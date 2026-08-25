import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const fixtures: string[] = [];
const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

function writeChecksums(assets: string) {
  const checksums = ["arashi-macos-arm64", "arashi", "aw", "uninstall.sh"].map((name) => {
    const result = spawnSync("shasum", ["-a", "256", join(assets, name)], { encoding: "utf8" });
    return `${result.stdout.split(" ")[0]}  ${name}`;
  });
  writeFileSync(join(assets, "arashi-checksums.txt"), `${checksums.join("\n")}\n`);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "arashi-posix-installer-"));
  fixtures.push(directory);
  const assets = join(directory, "assets");
  const commands = join(directory, "commands");
  const install = join(directory, "install");
  mkdirSync(assets);
  mkdirSync(commands);
  writeFileSync(join(assets, "arashi-macos-arm64"), "#!/bin/sh\nprintf '9.9.9\\n'\n");
  chmodSync(join(assets, "arashi-macos-arm64"), 0o755);
  copyFileSync(join(root, "bin/arashi"), join(assets, "arashi"));
  copyFileSync(join(root, "bin/aw"), join(assets, "aw"));
  copyFileSync(join(root, "scripts/uninstall.sh"), join(assets, "uninstall.sh"));
  writeChecksums(assets);
  writeFileSync(
    join(commands, "curl"),
    `#!/bin/sh\nout=''; url=''; while [ "$#" -gt 0 ]; do case "$1" in --output) shift; out="$1";; http*) url="$1";; esac; shift; done; cp ${quote(assets)}/"\${url##*/}" "$out"\n`,
  );
  writeFileSync(
    join(commands, "uname"),
    '#!/bin/sh\n[ "$1" = "-m" ] && echo arm64 || echo Darwin\n',
  );
  chmodSync(join(commands, "curl"), 0o755);
  chmodSync(join(commands, "uname"), 0o755);
  const env = {
    ...process.env,
    ARASHI_INSTALL_DIR: install,
    ARASHI_NO_MODIFY_PATH: "1",
    ARASHI_SHELL_INTEGRATION: "no",
    ARASHI_VERSION: "9.9.9",
    HOME: join(directory, "home"),
    PATH: `${commands}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  return { assets, commands, directory, env, install };
}

describe.skipIf(process.platform === "win32")("POSIX installer transaction", () => {
  test("records only the exact PATH bytes created by this install", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const profile = join(state.env.HOME, ".zshrc");
    writeFileSync(profile, "before\n");
    const result = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });
    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger.pathMutation.profilePath).toBe(realpathSync(profile));
    expect(readFileSync(profile, "utf8")).toBe(`before\n${ledger.pathMutation.insertedBytes}`);
  });

  test("preserves validated installer-owned PATH provenance across refresh", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const profile = join(state.env.HOME, ".zshrc");
    writeFileSync(profile, "before\n");
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });
    expect(first.status, first.stderr).toBe(0);
    const firstLedger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );

    const refresh = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/bash" },
    });
    expect(refresh.status, refresh.stderr).toBe(0);
    const refreshedLedger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(refreshedLedger.pathMutation).toEqual(firstLedger.pathMutation);
    const bashProfile = join(state.env.HOME, ".bash_profile");
    if (existsSync(bashProfile))
      expect(readFileSync(bashProfile, "utf8")).not.toContain(state.install);
  });

  test("refreshes missing recorded PATH bytes in the current shell profile", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const zshProfile = join(state.env.HOME, ".zshrc");
    writeFileSync(zshProfile, "before\n");
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });
    expect(first.status, first.stderr).toBe(0);
    writeFileSync(zshProfile, "before\n");

    const refresh = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/bash" },
    });

    expect(refresh.status, refresh.stderr).toBe(0);
    const bashProfile = join(state.env.HOME, ".bash_profile");
    const refreshedLedger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(refreshedLedger.pathMutation.profilePath).toBe(realpathSync(bashProfile));
    expect(readFileSync(bashProfile, "utf8")).toContain(state.install);
    expect(readFileSync(zshProfile, "utf8")).toBe("before\n");
  });

  test("refreshes a recorded PATH block after its line endings change", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const zshProfile = join(state.env.HOME, ".zshrc");
    writeFileSync(zshProfile, "before\n");
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });
    expect(first.status, first.stderr).toBe(0);
    const firstLedger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    const converted = readFileSync(zshProfile, "utf8").replaceAll("\n", "\r\n");
    writeFileSync(zshProfile, converted);

    const refresh = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/bash" },
    });

    expect(refresh.status, refresh.stderr).toBe(0);
    const bashProfile = join(state.env.HOME, ".bash_profile");
    const refreshedLedger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(refreshedLedger.pathMutation.profilePath).toBe(realpathSync(bashProfile));
    expect(refreshedLedger.pathMutation).not.toEqual(firstLedger.pathMutation);
    expect(readFileSync(zshProfile, "utf8")).toBe(converted);
  });

  test("refreshes a recorded PATH block missing its leading newline", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const zshProfile = join(state.env.HOME, ".zshrc");
    writeFileSync(zshProfile, "");
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });
    expect(first.status, first.stderr).toBe(0);
    const firstLedger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    writeFileSync(zshProfile, firstLedger.pathMutation.insertedBytes.slice(1));

    const refresh = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/bash" },
    });

    expect(refresh.status, refresh.stderr).toBe(0);
    const bashProfile = join(state.env.HOME, ".bash_profile");
    const refreshedLedger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(refreshedLedger.pathMutation.profilePath).toBe(realpathSync(bashProfile));
    expect(readFileSync(bashProfile, "utf8")).toContain(state.install);
  });

  test("refreshes an exact pre-helper schema-v1 install to schema v2 without executing it", () => {
    const state = fixture();
    mkdirSync(state.install);
    const sentinel = join(state.directory, "legacy-entrypoint-executed");
    writeFileSync(join(state.install, "arashi.bin"), "legacy native\n");
    writeFileSync(join(state.install, "arashi"), "legacy wrapper\n");
    writeFileSync(
      join(state.install, "aw"),
      `#!/bin/sh\n# arashi-managed-alias:aw:v1\ntouch ${quote(sentinel)}\nexit 97\n`,
    );
    for (const name of ["arashi.bin", "arashi", "aw"]) {
      chmodSync(join(state.install, name), 0o755);
    }
    const aliasPath = join(state.install, "aw");
    const aliasHash = spawnSync("shasum", ["-a", "256", aliasPath], {
      encoding: "utf8",
    }).stdout.split(" ")[0];
    writeFileSync(
      join(state.install, ".arashi-managed-entrypoints.json"),
      `{
  "schemaVersion": 1,
  "installDirectory": ${JSON.stringify(state.install)},
  "releaseVersion": "1.31.0",
  "aliases": [
    { "path": ${JSON.stringify(aliasPath)}, "sha256": "${aliasHash}" }
  ]
}
`,
    );

    const refresh = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, PATH: `${state.install}:${state.env.PATH}` },
    });

    expect(refresh.status, refresh.stderr).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8")),
    ).toMatchObject({ schemaVersion: 2 });
    expect(existsSync(join(state.install, "uninstall.sh"))).toBe(true);
  });

  test("preserves a symlinked startup target instead of recording unremovable PATH bytes", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const target = join(state.env.HOME, "shared-zshrc");
    const profile = join(state.env.HOME, ".zshrc");
    writeFileSync(target, "before\n");
    symlinkSync(target, profile);

    const result = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("before\n");
    expect(result.stderr).toContain("symbolic link");
    const ledger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger).not.toHaveProperty("pathMutation");
  });

  test("rolls back a newly inserted PATH line when payload commit fails", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const profile = join(state.env.HOME, ".zshrc");
    writeFileSync(profile, "before\n");
    writeFileSync(join(state.assets, "arashi-macos-arm64"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(state.assets, "arashi-macos-arm64"), 0o755);
    writeChecksums(state.assets);

    const result = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(profile, "utf8")).toBe("before\n");
  });

  test("rolls back PATH when install-directory setup fails before payload traps arm", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const profile = join(state.env.HOME, ".zshrc");
    writeFileSync(profile, "before\n");
    const blockedParent = join(state.directory, "blocked-parent");
    writeFileSync(blockedParent, "not a directory\n");

    const result = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: {
        ...state.env,
        ARASHI_INSTALL_DIR: join(blockedParent, "install"),
        ARASHI_NO_MODIFY_PATH: "0",
        SHELL: "/bin/zsh",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unable to create install directory");
    expect(readFileSync(profile, "utf8")).toBe("before\n");
  });

  test("does not adopt a PATH entry that predates installation", () => {
    const state = fixture();
    mkdirSync(state.env.HOME, { recursive: true });
    const profile = join(state.env.HOME, ".zshrc");
    const before = `export PATH="${state.install}:$PATH"\n`;
    writeFileSync(profile, before);
    const result = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_NO_MODIFY_PATH: "0", SHELL: "/bin/zsh" },
    });
    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger).not.toHaveProperty("pathMutation");
    expect(readFileSync(profile, "utf8")).toBe(before);
  });

  test("fresh install and managed upgrade commit one native binary, both wrappers, and owned ledger", () => {
    const state = fixture();
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(join(state.install, "arashi"), "utf8")).toContain("Wrapper for arashi");
    expect(readFileSync(join(state.install, "aw"), "utf8")).toContain("arashi-managed-alias:aw:v1");
    expect(readFileSync(join(state.install, "uninstall.sh"))).toEqual(
      readFileSync(join(state.assets, "uninstall.sh")),
    );
    expect(existsSync(join(state.install, "arashi.bin"))).toBe(true);
    expect(existsSync(join(state.install, "aw.bin"))).toBe(false);
    const ledger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger).toMatchObject({
      installDirectory: state.install,
      installationChannel: "official-direct",
      platform: "posix",
      schemaVersion: 2,
    });
    expect(ledger.files.map((file: { relativePath: string }) => file.relativePath)).toEqual([
      "arashi.bin",
      "arashi",
      "aw",
      "uninstall.sh",
    ]);
    const second = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(second.status, second.stderr).toBe(0);
    expect(
      spawnSync(join(state.install, "arashi"), ["--version"], { encoding: "utf8" }).stdout,
    ).toBe("9.9.9\n");
    expect(spawnSync(join(state.install, "aw"), ["--version"], { encoding: "utf8" }).stdout).toBe(
      "9.9.9\n",
    );
  });

  test("normalizes trailing install separators before ownership preflight and ledger persistence", () => {
    const state = fixture();
    const trailingInstall = `${state.install}///`;
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_INSTALL_DIR: trailingInstall },
    });
    expect(first.status, first.stderr).toBe(0);
    const ledger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger.installDirectory).toBe(state.install);
    expect(ledger.installDirectory).toBe(state.install);

    const second = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: {
        ...state.env,
        ARASHI_INSTALL_DIR: trailingInstall,
        PATH: `${state.install}:${state.env.PATH}`,
      },
    });
    expect(second.status, second.stderr).toBe(0);
  });

  test("normalizes lexical parent traversal before creating targets and ownership metadata", () => {
    const state = fixture();
    mkdirSync(join(state.directory, "parent"));
    const lexicalInstall = `${state.directory}/parent/../install`;
    const result = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, ARASHI_INSTALL_DIR: lexicalInstall },
    });
    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger.installDirectory).toBe(state.install);
    const helperCheck = spawnSync(
      "bash",
      [join(state.install, "uninstall.sh"), "--install-dir", state.install, "--dry-run"],
      { encoding: "utf8", env: { ...state.env, HOME: state.env.HOME } },
    );
    expect(helperCheck.status, helperCheck.stderr).toBe(0);
  });

  test("never executes a tampered installed helper during schema-v2 refresh preflight", () => {
    const state = fixture();
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(first.status, first.stderr).toBe(0);
    const sentinel = join(state.directory, "tampered-helper-executed");
    writeFileSync(
      join(state.install, "uninstall.sh"),
      `#!/bin/sh\ntouch ${quote(sentinel)}\nexit 0\n`,
    );
    chmodSync(join(state.install, "uninstall.sh"), 0o755);

    const refresh = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(refresh.status).not.toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("accepts a managed alias reached through a symlinked PATH directory", () => {
    const state = fixture();
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(first.status, first.stderr).toBe(0);

    const linkedBin = join(state.directory, "linked-bin");
    symlinkSync(state.install, linkedBin, "dir");
    const second = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...state.env, PATH: `${linkedBin}:${state.env.PATH}` },
    });
    expect(second.status, second.stderr).toBe(0);
  });

  test("ignores an exported aw function during filesystem collision preflight", () => {
    const state = fixture();
    const executed = join(state.directory, "exported-function-executed");
    const command = `aw() { touch ${quote(executed)}; }; export -f aw; exec bash ${quote(join(root, "scripts/install.sh"))}`;
    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      env: state.env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(executed)).toBe(false);
  });

  test.each([{ signal: "SIGHUP" }, { signal: "SIGTERM" }] as const)(
    "rolls back a fresh payload when $signal reaches only the installer PID after mutation begins",
    async ({ signal }) => {
      const state = fixture();
      const ready = join(state.directory, "smoke-ready");
      writeFileSync(
        join(state.assets, "arashi-macos-arm64"),
        `#!/bin/sh\ntouch "$ARASHI_SIGNAL_READY"\ntrap 'exit 143' HUP INT TERM\nwhile :; do sleep 1; done\n`,
      );
      chmodSync(join(state.assets, "arashi-macos-arm64"), 0o755);
      writeChecksums(state.assets);

      const child = spawn("bash", [join(root, "scripts/install.sh")], {
        detached: true,
        env: { ...state.env, ARASHI_SIGNAL_READY: ready },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const closed = once(child, "close");
      for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) {
        await delay(25);
      }
      expect(existsSync(ready), stderr).toBe(true);
      child.kill(signal);
      const [status] = (await closed) as [number | null, NodeJS.Signals | null];
      expect(status).not.toBe(0);
      for (const name of ["arashi.bin", "arashi", "aw", ".arashi-managed-entrypoints.json"]) {
        expect(existsSync(join(state.install, name)), `${name} survived interrupted rollback`).toBe(
          false,
        );
      }
    },
    10_000,
  );

  test("rolls back a foreground transaction when Ctrl-C delivers SIGINT", () => {
    const state = fixture();
    const ready = join(state.directory, "sigint-smoke-ready");
    const stdoutPath = join(state.directory, "sigint-stdout");
    const stderrPath = join(state.directory, "sigint-stderr");
    const resultPath = join(state.directory, "sigint-result.json");
    writeFileSync(
      join(state.assets, "arashi-macos-arm64"),
      `#!/bin/sh\ntouch "$ARASHI_SIGNAL_READY"\ntrap 'exit 143' HUP INT TERM\nwhile :; do sleep 1; done\n`,
    );
    chmodSync(join(state.assets, "arashi-macos-arm64"), 0o755);
    writeChecksums(state.assets);

    const config = Buffer.from(
      JSON.stringify({
        command: ["bash", join(root, "scripts/install.sh")],
        cwd: root,
        env: { ...state.env, ARASHI_SIGNAL_READY: ready },
        prompt: "__unused_when_ready_path_is_set__",
        readyPath: ready,
        response: "__CTRL_C__",
        resultPath,
        stderrPath,
        stdoutPath,
        timeoutSeconds: 10,
      }),
    ).toString("base64");
    const result = spawnSync(
      process.execPath,
      [join(root, "tests/helpers/pty-session.mjs"), config],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const session = JSON.parse(readFileSync(resultPath, "utf8")) as {
      exitCode: number;
      reused: boolean;
    };
    expect(session.exitCode).not.toBe(0);
    expect(session.reused).toBe(true);
    for (const name of [
      "arashi.bin",
      "arashi",
      "aw",
      "uninstall.sh",
      ".arashi-managed-entrypoints.json",
    ]) {
      expect(existsSync(join(state.install, name)), `${name} survived SIGINT rollback`).toBe(false);
    }
  }, 20_000);

  test("restores an existing managed payload when interrupted during backup cleanup", async () => {
    const state = fixture();
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(first.status, first.stderr).toBe(0);
    const managedNames = [
      "arashi.bin",
      "arashi",
      "aw",
      "uninstall.sh",
      ".arashi-managed-entrypoints.json",
    ];
    const originals = new Map(
      managedNames.map((name) => {
        const path = join(state.install, name);
        return [name, { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }];
      }),
    );

    writeFileSync(
      join(state.assets, "arashi-macos-arm64"),
      "#!/bin/sh\nprintf '9.9.9\\n'\n# replacement payload\n",
    );
    chmodSync(join(state.assets, "arashi-macos-arm64"), 0o755);
    writeChecksums(state.assets);
    const cleanupReady = join(state.directory, "cleanup-ready");
    writeFileSync(
      join(state.commands, "rm"),
      `#!/bin/sh\ncase "$*" in *arashi-payload-backup*) touch "$ARASHI_CLEANUP_READY"; sleep 3;; esac\nexec /bin/rm "$@"\n`,
    );
    chmodSync(join(state.commands, "rm"), 0o755);

    const child = spawn("bash", [join(root, "scripts/install.sh")], {
      detached: true,
      env: { ...state.env, ARASHI_CLEANUP_READY: cleanupReady },
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100 && !existsSync(cleanupReady); attempt += 1) {
      await delay(25);
    }
    expect(existsSync(cleanupReady)).toBe(true);
    child.kill("SIGTERM");
    const [status] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect(status).not.toBe(0);
    for (const name of managedNames) {
      const path = join(state.install, name);
      const original = originals.get(name)!;
      expect(readFileSync(path), `${name} bytes were not restored`).toEqual(original.bytes);
      expect(statSync(path).mode & 0o777, `${name} mode was not restored`).toBe(original.mode);
    }
  }, 12_000);

  test("retains complete rollback sources when restoration fails after backup cleanup", async () => {
    const state = fixture();
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(first.status, first.stderr).toBe(0);
    const managedNames = [
      "arashi.bin",
      "arashi",
      "aw",
      "uninstall.sh",
      ".arashi-managed-entrypoints.json",
    ];
    const originals = managedNames.map((name) => {
      const path = join(state.install, name);
      return { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 };
    });

    writeFileSync(
      join(state.assets, "arashi-macos-arm64"),
      "#!/bin/sh\nprintf '9.9.9\\n'\n# replacement payload\n",
    );
    chmodSync(join(state.assets, "arashi-macos-arm64"), 0o755);
    writeChecksums(state.assets);
    const cleanupReady = join(state.directory, "retention-cleanup-ready");
    writeFileSync(
      join(state.commands, "rm"),
      `#!/bin/sh\ncase "$*" in *arashi-payload-backup*) touch "$ARASHI_CLEANUP_READY"; sleep 3;; esac\nexec /bin/rm "$@"\n`,
    );
    writeFileSync(
      join(state.commands, "mv"),
      '#!/bin/sh\ncase "$*" in *.arashi-restore.*) exit 71;; esac\nexec /bin/mv "$@"\n',
    );
    chmodSync(join(state.commands, "rm"), 0o755);
    chmodSync(join(state.commands, "mv"), 0o755);

    const child = spawn("bash", [join(root, "scripts/install.sh")], {
      detached: true,
      env: { ...state.env, ARASHI_CLEANUP_READY: cleanupReady },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    for (let attempt = 0; attempt < 100 && !existsSync(cleanupReady); attempt += 1) {
      await delay(25);
    }
    expect(existsSync(cleanupReady)).toBe(true);
    child.kill("SIGTERM");
    const [status] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect(status).not.toBe(0);
    const retainedPath = stderr.match(/recoverable backups retained at: (.+?)\. Restore/u)?.[1];
    expect(retainedPath, stderr).toBeTruthy();
    fixtures.push(retainedPath!);
    for (const [index, original] of originals.entries()) {
      const backup = join(retainedPath!, String(index));
      expect(readFileSync(backup), `backup ${index} bytes were not retained`).toEqual(
        original.bytes,
      );
      expect(statSync(backup).mode & 0o777, `backup ${index} mode was not retained`).toBe(
        original.mode,
      );
    }
  }, 12_000);

  test("rejects a pinned binary whose parsed version only contains the requested version as a substring", () => {
    const state = fixture();
    writeFileSync(join(state.assets, "arashi-macos-arm64"), "#!/bin/sh\nprintf '19.9.9\\n'\n");
    chmodSync(join(state.assets, "arashi-macos-arm64"), 0o755);
    writeChecksums(state.assets);

    const result = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match requested release 9.9.9");
    expect(existsSync(join(state.install, ".arashi-managed-entrypoints.json"))).toBe(false);
  });

  test("manual marked alias and PATH collisions fail before download or target creation without execution", () => {
    const state = fixture();
    mkdirSync(state.install, { recursive: true });
    copyFileSync(join(root, "bin/aw"), join(state.install, "aw"));
    const manual = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(manual.status).not.toBe(0);
    expect(manual.stderr).toContain("no installer ownership ledger");

    const pathState = fixture();
    const collisionBin = join(pathState.directory, "collision");
    mkdirSync(collisionBin);
    const sentinel = join(pathState.directory, "executed");
    writeFileSync(join(collisionBin, "aw"), `#!/bin/sh\ntouch ${quote(sentinel)}\n`);
    chmodSync(join(collisionBin, "aw"), 0o755);
    const collision = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: { ...pathState.env, PATH: `${collisionBin}:${pathState.env.PATH}` },
    });
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain(join(collisionBin, "aw"));
    expect(existsSync(pathState.install)).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
  });
});
