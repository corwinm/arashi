// Test infrastructure only: native Git owns all protocol and pack bytes.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";

const quote = (value) => `'${value.replaceAll("'", String.raw`'\''`)}'`;
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// Named API is shared by Rust-driven acceptance and the fixture regression.
// oxlint-disable-next-line import/prefer-default-export
export async function startAuthenticatedGit() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "arashi-auth-")));
  fs.chmodSync(root, 0o700);
  const file = (name) => path.join(root, name);
  const write = (name, value) => fs.writeFileSync(file(name), value, { flag: "wx", mode: 0o600 });
  fs.mkdirSync(file("home"), { mode: 0o700 });
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|temp|tmp|pathext)$/i.test(key)) {
      environment[key] = value;
    }
  }
  Object.assign(environment, {
    GIT_ALLOW_PROTOCOL: "file:https:ssh",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_CONFIG_GLOBAL: file("gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: file("home"),
    NO_COLOR: "1",
    TERM: "dumb",
    USERPROFILE: file("home"),
    XDG_CONFIG_HOME: file("home"),
  });
  write("gitconfig", "[commit]\n gpgsign = false\n[maintenance]\n auto = false\n");
  const children = new Set(),
    connections = new Set(),
    events = [],
    outputs = [];
  let closed = false,
    sshServer = null,
    tlsServer = null;
  const password = randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(
    `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`,
  );
  function child(command, args, options = {}) {
    const proc = spawn(command, args, {
      cwd: root,
      detached: process.platform !== "win32",
      env: environment,
      windowsHide: true,
      ...options,
    });
    children.add(proc);
    proc.once("close", () => children.delete(proc));
    return proc;
  }
  function killOwned(proc) {
    if (!children.has(proc) || !proc.pid) {
      return;
    }
    if (process.platform === "win32") {
      // Only this fixture's still-owned root and its descendants, never image names.
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        env: environment,
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  }
  async function run(
    command,
    args,
    { cwd = ".", transport, mode = "valid", allowFailure = false } = {},
  ) {
    const env = { ...environment };
    if (transport) {
      env.GIT_CONFIG_GLOBAL = file(`${mode}.gitconfig`);
      env.GIT_SSH_COMMAND = `ssh -F ${quote(file(`${mode}.sshconfig`))}`;
      env.GIT_SSH_VARIANT = "ssh";
    }
    const proc = child(command, args, {
      cwd: path.resolve(root, cwd),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = Buffer.alloc(0),
      stdout = Buffer.alloc(0);
    proc.stdout.on("data", (bytes) => {
      stdout = Buffer.concat([stdout, bytes]);
    });
    proc.stderr.on("data", (bytes) => {
      stderr = Buffer.concat([stderr, bytes]);
    });
    const timer = setTimeout(() => killOwned(proc), 45_000);
    let code = null;
    try {
      [code] = await once(proc, "close");
    } finally {
      clearTimeout(timer);
    }
    const result = { code, stderr: stderr.toString(), stdout: stdout.toString() };
    outputs.push(result.stdout, result.stderr);
    // Never print arbitrary command argv, stderr or output: credentials are private.
    if (!allowFailure) {
      assert.equal(
        code,
        0,
        `${path.basename(command)} ${args[0]} failed (output retained privately)`,
      );
    }
    return result;
  }
  const git = async (cwd, args, options) =>
    (await run("git", args, { cwd, ...options })).stdout.trim();
  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    const listeners = [tlsServer, sshServer].filter((server) => server?.address());
    const stopped = listeners.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    );
    for (const connection of connections) {
      connection.destroy();
    }
    const pending = [...children].map((proc) => once(proc, "close").catch(() => {}));
    for (const proc of children) {
      killOwned(proc);
    }
    await Promise.all([...stopped, ...pending]);
    fs.rmSync(root, { force: true, recursive: true });
  }
  try {
    if (process.platform === "win32") {
      const identity = await run("whoami", ["/user", "/fo", "csv", "/nh"]);
      const sid = identity.stdout.match(/S-1-5-[0-9-]+/);
      assert.ok(sid, "cannot establish private fixture ACL identity");
      await run("icacls", [root, "/inheritance:r", "/grant:r", `*${sid[0]}:(OI)(CI)F`, "/T", "/Q"]);
    }
    write(
      "cert.cnf",
      "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Arashi disposable test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n",
    );
    for (const name of ["ca", "wrong-ca"]) {
      await run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        file(`${name}.key`),
        "-out",
        file(`${name}.pem`),
        "-config",
        file("cert.cnf"),
      ]);
    }
    await run("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      file("server.key"),
      "-out",
      file("server.csr"),
    ]);
    await run("openssl", [
      "x509",
      "-req",
      "-in",
      file("server.csr"),
      "-CA",
      file("ca.pem"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      file("cert.cnf"),
      "-extensions",
      "server",
      "-out",
      file("server.pem"),
    ]);
    for (const name of ["host", "client", "wrong-client", "wrong-host"]) {
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", file(name)]);
    }
    const clientKey = ssh2.utils.parseKey(fs.readFileSync(file("client")));
    assert.ok(!(clientKey instanceof Error));
    const remote = file("origin.git");
    await git(".", ["init", "--bare", "--initial-branch=main", remote]);
    await git(".", ["init", "--initial-branch=main", "seed"]);

    const backend = (args, env, { transport, service }) => {
      const event = { bytes: 0, kind: "backend", service, transport };
      events.push(event);
      const proc = child("git", args, {
        env: { ...environment, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.stdout.on("data", (bytes) => {
        event.bytes += bytes.length;
      });
      proc.stderr.on("data", (bytes) => outputs.push(bytes.toString()));
      proc.stdin.on("error", () => {});
      return proc;
    };
    tlsServer = https.createServer(
      {
        cert: fs.readFileSync(file("server.pem")),
        key: fs.readFileSync(file("server.key")),
        minVersion: "TLSv1.2",
      },
      (req, res) => {
        const [pathname, query = ""] = req.url.split("?");
        if (
          !/^\/origin\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(pathname) ||
          !["GET", "POST"].includes(req.method)
        ) {
          res.writeHead(404).end();
          return;
        }
        if (!equal(Buffer.from(req.headers.authorization || ""), expectedAuth)) {
          events.push({ kind: "denied", transport: "https" });
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }).end();
          return;
        }
        events.push({
          kind: "authenticated",
          protocol: req.socket.getProtocol(),
          transport: "https",
        });
        const service =
          pathname.endsWith("git-receive-pack") || query === "service=git-receive-pack"
            ? "receive-pack"
            : "upload-pack";
        const proc = backend(
          ["-c", "http.receivepack=true", "http-backend"],
          {
            CONTENT_LENGTH: req.headers["content-length"] || "",
            CONTENT_TYPE: req.headers["content-type"] || "",
            GATEWAY_INTERFACE: "CGI/1.1",
            GIT_HTTP_EXPORT_ALL: "1",
            GIT_PROJECT_ROOT: root,
            GIT_PROTOCOL: req.headers["git-protocol"] || "",
            HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "",
            PATH_INFO: pathname,
            QUERY_STRING: query,
            REMOTE_ADDR: "127.0.0.1",
            REMOTE_USER: "fixture",
            REQUEST_METHOD: req.method,
            SERVER_PROTOCOL: "HTTP/1.1",
          },
          { service, transport: "https" },
        );
        let header = Buffer.alloc(0),
          sent = false;
        proc.stdout.on("data", (bytes) => {
          if (sent) {
            if (!res.write(bytes)) {
              proc.stdout.pause();
            }
            return;
          }
          header = Buffer.concat([header, bytes]);
          const end = header.indexOf("\r\n\r\n");
          if (end === -1) {
            if (header.length > 65_536) {
              proc.kill();
              res.destroy();
            }
            return;
          }
          for (const line of header.subarray(0, end).toString("latin1").split("\r\n")) {
            const colon = line.indexOf(":"),
              key = line.slice(0, colon),
              value = line.slice(colon + 1).trim();
            if (key.toLowerCase() === "status") {
              res.statusCode = Number(value.slice(0, 3));
            } else {
              res.setHeader(key, value);
            }
          }
          sent = true;
          if (!res.write(header.subarray(end + 4))) {
            proc.stdout.pause();
          }
          header = Buffer.alloc(0);
        });
        res.on("drain", () => proc.stdout.resume());
        res.on("close", () => {
          if (proc.exitCode === null) {
            proc.kill();
          }
        });
        proc.on("error", () => res.destroy());
        proc.on("close", (code) => {
          if (code === 0 && sent) {
            res.end();
          } else {
            res.destroy();
          }
        });
        req.on("error", () => proc.kill());
        req.pipe(proc.stdin);
      },
    );
    tlsServer.requestTimeout = 30_000;
    tlsServer.on("connection", (socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
    });
    tlsServer.listen(0, "127.0.0.1");
    await once(tlsServer, "listening");

    sshServer = new ssh2.Server({ hostKeys: [fs.readFileSync(file("host"))] }, (client) => {
      connections.add(client);
      client.on("close", () => connections.delete(client));
      client.on("error", () => {});
      client.on("authentication", (ctx) => {
        const valid =
          ctx.username === "fixture" &&
          ctx.method === "publickey" &&
          equal(ctx.key.data, clientKey.getPublicSSH()) &&
          (!ctx.signature || clientKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true);
        if (valid) {
          if (ctx.signature) {
            events.push({ kind: "authenticated", transport: "ssh" });
          }
          ctx.accept();
        } else {
          events.push({ kind: "denied", transport: "ssh" });
          ctx.reject(["publickey"]);
        }
      });
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, reject, info) => {
            const match = /^git-(upload-pack|receive-pack) '\/origin\.git'$/.exec(info.command);
            if (!match) {
              reject();
              return;
            }
            const stream = acceptExec();
            const proc = backend([match[1], remote], {}, { service: match[1], transport: "ssh" });
            stream.on("error", () => proc.kill());
            stream.pipe(proc.stdin);
            proc.stdout.pipe(stream, { end: false });
            proc.stderr.pipe(stream.stderr, { end: false });
            proc.on("error", () => {
              stream.exit(1);
              stream.end();
            });
            proc.on("close", (code) => {
              stream.exit(code ?? 1);
              stream.end();
            });
            stream.on("close", () => {
              if (proc.exitCode === null) {
                proc.kill();
              }
            });
          });
        }),
      );
    });
    sshServer.listen(0, "127.0.0.1");
    await once(sshServer, "listening");
    const sshPort = sshServer.address().port;
    const urls = {
      https: `https://127.0.0.1:${tlsServer.address().port}/origin.git`,
      ssh: `ssh://fixture@127.0.0.1:${sshPort}/origin.git`,
    };
    write("credentials.json", JSON.stringify({ password, username: "fixture" }));
    write(
      "wrong-credentials.json",
      JSON.stringify({ password: randomBytes(32).toString("hex"), username: "fixture" }),
    );
    write(
      "credential.cjs",
      // Generated helper interpolates its own private data, not this fixture's source.
      // oxlint-disable-next-line no-template-curly-in-string
      'const fs = require("node:fs"); if (process.argv[3] === "get") { const c = JSON.parse(fs.readFileSync(process.argv[2])); process.stdout.write(`username=${c.username}\\npassword=${c.password}\\n`); }\n',
    );
    for (const mode of ["valid", "wrong-credential", "wrong-trust"]) {
      const wrongCredential = mode === "wrong-credential",
        wrongTrust = mode === "wrong-trust";
      write(
        `${mode}.known_hosts`,
        `[127.0.0.1]:${sshPort} ${fs.readFileSync(file(wrongTrust ? "wrong-host.pub" : "host.pub"), "utf8")}`,
      );
      write(
        `${mode}.sshconfig`,
        `Host *\n HostName 127.0.0.1\n User fixture\n Port ${sshPort}\n IdentityFile "${file(wrongCredential ? "wrong-client" : "client")}"\n IdentitiesOnly yes\n IdentityAgent none\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile "${file(`${mode}.known_hosts`)}"\n GlobalKnownHostsFile "${file(`${mode}.known_hosts`)}"\n PasswordAuthentication no\n KbdInteractiveAuthentication no\n ConnectTimeout 5\n`,
      );
      const helper = `!${quote(process.execPath)} ${quote(file("credential.cjs"))} ${quote(file(wrongCredential ? "wrong-credentials.json" : "credentials.json"))}`;
      write(
        `${mode}.gitconfig`,
        `${fs.readFileSync(file("gitconfig"), "utf8")}[http]\n sslVerify = true\n sslCAInfo = ${JSON.stringify(file(wrongTrust ? "wrong-ca.pem" : "ca.pem"))}\n[credential]\n helper = ${JSON.stringify(helper)}\n`,
      );
    }
    let serial = 0;
    return {
      assertNoSecretOutput() {
        const text = outputs.join("\n");
        for (const secret of [
          password,
          expectedAuth.toString(),
          "BEGIN OPENSSH PRIVATE KEY",
          "BEGIN PRIVATE KEY",
        ]) {
          assert.ok(!text.includes(secret), "fixture output leaked secret material");
        }
      },
      close,
      async commit(cwd, label) {
        fs.writeFileSync(
          path.resolve(root, cwd, "payload"),
          Buffer.concat([Buffer.from(`${label}-${serial++}\n`), randomBytes(8192)]),
        );
        await git(cwd, ["add", "payload"]);
        await git(cwd, ["commit", "-m", label]);
        return git(cwd, ["rev-parse", "HEAD"]);
      },
      events,
      git,
      remote,
      root,
      run,
      urls,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
