import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  const checksums = ["arashi-macos-arm64", "arashi", "aw"].map((name) => {
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
  test("fresh install and managed upgrade commit one native binary, both wrappers, and owned ledger", () => {
    const state = fixture();
    const first = spawnSync("bash", [join(root, "scripts/install.sh")], {
      encoding: "utf8",
      env: state.env,
    });
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(join(state.install, "arashi"), "utf8")).toContain("Wrapper for arashi");
    expect(readFileSync(join(state.install, "aw"), "utf8")).toContain("arashi-managed-alias:aw:v1");
    expect(existsSync(join(state.install, "arashi.bin"))).toBe(true);
    expect(existsSync(join(state.install, "aw.bin"))).toBe(false);
    const ledger = JSON.parse(
      readFileSync(join(state.install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger).toMatchObject({
      installDirectory: state.install,
      releaseVersion: "9.9.9",
      schemaVersion: 1,
    });
    expect(ledger.aliases).toHaveLength(1);
    expect(ledger.aliases[0].path).toBe(join(state.install, "aw"));
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
    expect(ledger.aliases[0].path).toBe(join(state.install, "aw"));

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
