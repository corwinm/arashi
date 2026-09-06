"use strict";
// Test-only smart HTTP gateway. Git owns every protocol/pack byte.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const [base, ready] = process.argv.slice(2);
const root = fs.realpathSync(base);
const environment = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(path|systemroot|windir|temp|tmp|pathext)$/i.test(key)) environment[key] = value;
}
Object.assign(environment, {
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(root, "home", ".gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  GIT_PROJECT_ROOT: root,
  GIT_HTTP_EXPORT_ALL: "1",
});
const server = http.createServer((req, res) => {
  // Export only the fixture's two bare origins, never arbitrary base files or paths.
  const [pathname, query = ""] = req.url.split("?");
  if (
    !/^\/(child|main)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(pathname) ||
    !["GET", "POST"].includes(req.method)
  ) {
    res.writeHead(404);
    res.end("Not found\n");
    return;
  }
  const repository = pathname.split("/")[1];
  try {
    if (fs.realpathSync(path.join(root, repository)) !== path.join(root, repository)) {
      res.writeHead(403);
      res.end();
      return;
    }
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  const backend = spawn("git", ["-c", "http.receivepack=true", "http-backend"], {
    cwd: root,
    windowsHide: true,
    env: {
      ...environment,
      PATH_INFO: pathname,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] || "",
      CONTENT_LENGTH: req.headers["content-length"] || "",
      REMOTE_ADDR: "127.0.0.1",
      SERVER_PROTOCOL: "HTTP/1.1",
      GATEWAY_INTERFACE: "CGI/1.1",
      GIT_PROTOCOL: req.headers["git-protocol"] || "",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let header = Buffer.alloc(0),
    sent = false;
  function failure(error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Git backend failed\n");
    } else res.destroy();
  }
  backend.on("error", failure);
  backend.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") failure(error);
  });
  backend.stdout.on("data", (bytes) => {
    if (sent) {
      if (!res.write(bytes)) backend.stdout.pause();
      return;
    }
    header = Buffer.concat([header, bytes]);
    const end = header.indexOf("\r\n\r\n");
    if (end < 0) {
      if (header.length > 65536) failure(new Error("Oversized CGI header"));
      return;
    }
    try {
      for (const line of header.subarray(0, end).toString("latin1").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 1) throw new Error("Invalid CGI header");
        const key = line.slice(0, colon),
          value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") {
          if (!/^[1-5][0-9]{2}( |$)/.test(value)) throw new Error("Invalid CGI status");
          res.statusCode = Number(value.slice(0, 3));
        } else res.setHeader(key, value);
      }
      sent = true;
      if (!res.write(header.subarray(end + 4))) backend.stdout.pause();
      header = Buffer.alloc(0);
    } catch (error) {
      failure(error);
    }
  });
  res.on("drain", () => backend.stdout.resume());
  backend.on("close", (code) => {
    if (code !== 0 || !sent) failure(new Error(`Git backend exit ${code}`));
    else res.end();
  });
  req.on("error", failure);
  req.pipe(backend.stdin);
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(ready, String(server.address().port), { flag: "wx" });
});
// The Rust guard retains this root until taskkill /T has settled every backend.
// Do not exit on stdin EOF or kill only git.exe: Git launches other names too.
