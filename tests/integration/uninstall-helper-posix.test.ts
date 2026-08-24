import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const helperSource = join(import.meta.dirname, "../../scripts/uninstall.sh");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let fixture = "";
let install = "";

function prepare(): void {
  const payload = {
    "arashi.bin": "native",
    arashi: "canonical",
    aw: "alias",
    "uninstall.sh": readFileSync(helperSource, "utf8"),
  };
  for (const [name, contents] of Object.entries(payload)) {
    writeFileSync(join(install, name), contents);
    chmodSync(join(install, name), 0o755);
  }
  writeFileSync(
    join(install, ".arashi-managed-entrypoints.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      installationChannel: "official-direct",
      platform: "posix",
      installDirectory: install,
      files: [
        {
          relativePath: "arashi.bin",
          role: "native-executable",
          digest: hash(payload["arashi.bin"]),
        },
        { relativePath: "arashi", role: "canonical-wrapper", digest: hash(payload.arashi) },
        { relativePath: "aw", role: "alias-wrapper", digest: hash(payload.aw) },
        {
          relativePath: "uninstall.sh",
          role: "uninstall-helper",
          digest: hash(payload["uninstall.sh"]),
        },
      ],
    })}\n`,
  );
}

function updateManifest(change: (manifest: Record<string, unknown>) => void): void {
  const path = join(install, ".arashi-managed-entrypoints.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest);
  writeFileSync(path, `${JSON.stringify(manifest)}\n`);
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "arashi-helper-"));
  install = join(fixture, "install");
  mkdir(install);
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));
function mkdir(path: string) {
  const result = spawnSync("mkdir", ["-p", path]);
  if (result.status !== 0) throw new Error("mkdir failed");
}

describe("bundled POSIX uninstall helper", () => {
  test("completes manifest preflight before asking for consent", () => {
    const source = readFileSync(helperSource, "utf8");
    expect(source.indexOf('if blockers: fail("preflight refused:')).toBeLessThan(
      source.indexOf("Remove this proven Arashi direct installation?"),
    );
  });

  test("dry-run revalidates the local manifest and mutates nothing", () => {
    prepare();
    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/official-direct|remove.*arashi\.bin/is);
    expect(existsSync(join(install, "arashi.bin"))).toBe(true);
    expect(existsSync(join(install, ".arashi-managed-entrypoints.json"))).toBe(true);
  });

  test("temporary-self cannot remove the installed helper during dry-run", () => {
    prepare();
    const installedHelper = join(install, "uninstall.sh");
    const result = spawnSync(
      "bash",
      [installedHelper, "--install-dir", install, "--dry-run", "--temporary-self"],
      { encoding: "utf8", env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(installedHelper)).toBe(true);
  });

  test("uses the deterministic default install directory", () => {
    install = join(fixture, ".arashi", "bin");
    mkdir(install);
    prepare();
    const result = spawnSync("bash", [helperSource, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(install);
  });

  test("removes exact PATH and shell bytes while preserving outside and project state", () => {
    prepare();
    const profile = join(fixture, ".zshrc");
    const pathBytes = `\n# Added by arashi installer\nexport PATH="${install}:$PATH"`;
    writeFileSync(
      profile,
      `before${pathBytes}\n# >>> arashi shell integration >>>\nowned\n# <<< arashi shell integration <<<\nafter`,
    );
    chmodSync(profile, 0o644);
    updateManifest((manifest) => {
      manifest.pathMutation = { insertedBytes: pathBytes, profilePath: profile };
    });
    const project = join(fixture, "project", ".git", "config");
    mkdir(join(fixture, "project", ".git"));
    writeFileSync(project, "preserve");
    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(profile, "utf8")).toBe("before\n\nafter");
    expect(statSync(profile).mode & 0o777).toBe(0o644);
    expect(readFileSync(project, "utf8")).toBe("preserve");
  });

  test("removes canonical CRLF shell marker lines without changing outside bytes", () => {
    prepare();
    const profile = join(fixture, ".zshrc");
    writeFileSync(
      profile,
      "before\r\n# >>> arashi shell integration >>>\r\nowned\r\n# <<< arashi shell integration <<<\r\nafter\r\n",
    );

    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(profile, "utf8")).toBe("before\r\n\r\nafter\r\n");
  });

  test("refuses marker substrings embedded in unrelated command lines", () => {
    prepare();
    const profile = join(fixture, ".zshrc");
    const contents =
      'before echo "# >>> arashi shell integration >>>"\nunrelated command\necho "# <<< arashi shell integration <<<" after\n';
    writeFileSync(profile, contents);
    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/marker/i);
    expect(readFileSync(profile, "utf8")).toBe(contents);
    expect(existsSync(join(install, "arashi.bin"))).toBe(true);
  });

  test("runs with a PATH that contains no Python executable", () => {
    prepare();
    const commands = join(fixture, "commands");
    mkdir(commands);
    for (const name of [
      "awk",
      "basename",
      "cmp",
      "cut",
      "dd",
      "dirname",
      "grep",
      "kill",
      "mktemp",
      "mv",
      "od",
      "rm",
      "rmdir",
      "sed",
      "shasum",
      "sleep",
      "stat",
      "tr",
      "wc",
    ]) {
      const resolved = spawnSync("sh", ["-c", `command -v ${name}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (resolved) symlinkSync(resolved, join(commands, name));
    }
    const result = spawnSync("/bin/bash", [helperSource, "--install-dir", install, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, PATH: commands, SHELL: "/bin/zsh" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/official-direct/);
  });

  test("preserves non-UTF-8 bytes outside exact recorded PATH provenance", () => {
    prepare();
    const profile = join(fixture, ".zshrc");
    const outside = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    const insertedBytes = `\n# Added by arashi installer\nexport PATH="${install}:$PATH"\n`;
    writeFileSync(
      profile,
      Buffer.concat([outside, Buffer.from(insertedBytes), Buffer.from([0x80])]),
    );
    chmodSync(profile, 0o644);
    updateManifest((manifest) => {
      manifest.pathMutation = { insertedBytes, profilePath: profile };
    });
    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(profile)).toEqual(Buffer.concat([outside, Buffer.from([0x80])]));
    expect(statSync(profile).mode & 0o777).toBe(0o644);
  });

  test("rejects unknown manifest properties before touching a matching payload", () => {
    prepare();
    updateManifest((manifest) => {
      manifest.unexpected = true;
    });
    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/closed|validation/i);
    expect(existsSync(join(install, "arashi.bin"))).toBe(true);
  });

  test("refuses a modified file before removing any matching file", () => {
    prepare();
    writeFileSync(join(install, "aw"), "modified");
    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/digest|modified/i);
    expect(existsSync(join(install, "arashi.bin"))).toBe(true);
    expect(existsSync(join(install, ".arashi-managed-entrypoints.json"))).toBe(true);
  });

  test("skips absent owned files, preserves neighbors and removes manifest last", () => {
    prepare();
    rmSync(join(install, "aw"));
    writeFileSync(join(install, "neighbor"), "keep");
    const result = spawnSync("bash", [helperSource, "--install-dir", install, "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(install, "neighbor"), "utf8")).toBe("keep");
    expect(existsSync(install)).toBe(true);
    expect(existsSync(join(install, ".arashi-managed-entrypoints.json"))).toBe(false);
  });

  test("a staged temporary helper waits for parent and narrowly self-cleans", () => {
    prepare();
    const temporaryDirectory = join(fixture, "arashi-uninstall-staged");
    mkdir(temporaryDirectory);
    const temporary = join(temporaryDirectory, "uninstall.sh");
    writeFileSync(temporary, readFileSync(helperSource));
    chmodSync(temporary, 0o755);
    const result = spawnSync(
      "bash",
      [temporary, "--install-dir", install, "--parent-pid", "999999", "--yes", "--temporary-self"],
      { encoding: "utf8", env: { ...process.env, HOME: fixture, SHELL: "/bin/zsh" } },
    );
    expect(result.status).toBe(0);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(temporaryDirectory)).toBe(false);
    expect(existsSync(fixture)).toBe(true);
  });
});
