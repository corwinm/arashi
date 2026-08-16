import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const sourceWrapper = join(import.meta.dirname, "../../bin/arashi");
const sourceAliasWrapper = join(import.meta.dirname, "../../bin/aw");
const temporaryDirectories: string[] = [];

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "arashi-wrapper-"));
  temporaryDirectories.push(directory);
  copyFileSync(sourceWrapper, join(directory, "arashi"));
  copyFileSync(sourceAliasWrapper, join(directory, "aw"));
  chmodSync(join(directory, "arashi"), 0o755);
  chmodSync(join(directory, "aw"), 0o755);
  writeFileSync(
    join(directory, "uname"),
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- Bash expands the fixture variables.
    '#!/bin/bash\nif [ "$1" = "-m" ]; then printf "%s\\n" "${UNAME_M:-x86_64}"; else printf "%s\\n" "${UNAME_S:-Linux}"; fi\n',
  );
  chmodSync(join(directory, "uname"), 0o755);
  return directory;
}

function writeBinary(directory: string, name: string, marker: string): void {
  writeFileSync(
    join(directory, name),
    `#!/bin/bash\nprintf '${marker}\\n'\nprintf 'args:'\nprintf ' <%s>' "$@"\nprintf '\\n'\nif [ "\${CHECK_STDIN:-}" = "1" ]; then\n  if IFS= read -r line; then printf 'stdin:%s\\n' "$line"; else printf 'stdin:closed\\n'; fi\nfi\nexit "\${BINARY_EXIT:-0}"\n`,
  );
  chmodSync(join(directory, name), 0o755);
}

function runWrapper(
  directory: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    name?: "arashi" | "aw";
    symlink?: boolean;
  } = {},
) {
  const name = options.name ?? "arashi";
  const command = options.symlink ? join(directory, `linked-${name}`) : join(directory, name);
  if (options.symlink) {
    symlinkSync(name, command);
  }
  return spawnSync("bash", [command, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      ...options.env,
    },
    input: options.input,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("extensionless aw wrapper", () => {
  test("carries the managed marker and selects the same Windows binary with argv and exit parity", () => {
    expect(readFileSync(sourceAliasWrapper, "utf8")).toContain("arashi-managed-alias:aw:v1");
    const directory = createFixture();
    writeBinary(directory, "arashi.bin.exe", "windows");
    const result = runWrapper(directory, ["create", "topic"], {
      env: { BINARY_EXIT: "23", CHECK_STDIN: "1", UNAME_S: "MINGW64_NT-10.0" },
      input: "available\n",
      name: "aw",
      symlink: true,
    });
    expect(result.status).toBe(23);
    expect(result.stdout).toContain("args: <create> <topic>");
    expect(result.stdout).toContain("stdin:available");
  });

  test("keeps POSIX precedence and does not select a stray Windows executable", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi.bin", "posix");
    writeBinary(directory, "arashi.bin.exe", "windows");
    const result = runWrapper(directory, ["--version"], {
      env: { UNAME_M: "arm64", UNAME_S: "Darwin" },
      name: "aw",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("posix");
    expect(result.stdout).not.toContain("windows");
  });

  test("retains conditional stdin closure for piped list", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi.bin.exe", "windows");
    const result = runWrapper(directory, ["list"], {
      env: { CHECK_STDIN: "1", UNAME_S: "MSYS_NT-10.0" },
      input: "must-not-arrive\n",
      name: "aw",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stdin:closed");
  });
});

describe("extensionless arashi wrapper", () => {
  test.each(["MINGW64_NT-10.0", "MSYS_NT-10.0", "CYGWIN_NT-10.0"])(
    "selects arashi.bin.exe with explicit %s shell evidence",
    (uname) => {
      const directory = createFixture();
      writeBinary(directory, "arashi.bin.exe", "windows");

      const result = runWrapper(directory, ["status", "--verbose"], { env: { UNAME_S: uname } });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("windows");
      expect(result.stdout).toContain("args: <status> <--verbose>");
    },
  );

  test("retains arashi.bin precedence and follows a relative symlink", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi.bin", "posix");
    writeBinary(directory, "arashi.bin.exe", "windows");

    const result = runWrapper(directory, ["--version"], {
      env: { UNAME_S: "MINGW64_NT-10.0" },
      symlink: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("posix");
    expect(result.stdout).not.toContain("windows");
  });

  test("retains the Linux release-name fallback", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi-linux-x64", "linux");

    const result = runWrapper(directory, ["--version"], {
      env: { UNAME_M: "x86_64", UNAME_S: "Linux" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("linux");
  });

  test("does not select a stray Windows executable without Windows shell evidence", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi.bin.exe", "windows");

    const result = runWrapper(directory, ["--version"], {
      env: { UNAME_M: "arm64", UNAME_S: "Darwin" },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("windows");
    expect(result.stderr).toContain("arashi binary not found");
  });

  test("forwards exit status and preserves stdin for ordinary commands", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi.bin.exe", "windows");

    const result = runWrapper(directory, ["create", "topic"], {
      env: { BINARY_EXIT: "23", CHECK_STDIN: "1", UNAME_S: "MINGW64_NT-10.0" },
      input: "available\n",
    });

    expect(result.status).toBe(23);
    expect(result.stdout).toContain("stdin:available");
  });

  test("retains conditional stdin closure for piped list", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi.bin.exe", "windows");

    const result = runWrapper(directory, ["list"], {
      env: { CHECK_STDIN: "1", UNAME_S: "MINGW64_NT-10.0" },
      input: "must-not-arrive\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stdin:closed");
  });

  test("preserves hook-eligible stdin for forced remove with redirected stdout", () => {
    const directory = createFixture();
    writeBinary(directory, "arashi.bin.exe", "windows");

    const result = runWrapper(directory, ["remove", "--force", "topic"], {
      env: { CHECK_STDIN: "1", UNAME_S: "MINGW64_NT-10.0" },
      input: "hook-answer\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stdin:hook-answer");
  });
});

describe("retained POSIX release archive wrappers", () => {
  test("canonical and alias archives preserve prompt stdin and conditionally close piped list stdin", () => {
    const fixture = mkdtempSync(join(tmpdir(), "arashi-retained-archive-"));
    temporaryDirectories.push(fixture);
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(join(fixture, "bin"), { recursive: true });
    mkdirSync(join(fixture, "stub-bin"), { recursive: true });
    copyFileSync(
      join(import.meta.dirname, "../../scripts/package-releases.sh"),
      join(fixture, "scripts/package-releases.sh"),
    );
    for (const wrapper of ["arashi", "aw"]) {
      copyFileSync(
        join(import.meta.dirname, `../../bin/${wrapper}`),
        join(fixture, "bin", wrapper),
      );
    }
    for (const binary of ["arashi-macos-arm64", "arashi-linux-x64"]) {
      writeFileSync(
        join(fixture, "bin", binary),
        '#!/bin/sh\nif IFS= read -r value; then printf "stdin:%s\\n" "$value"; else printf "stdin:closed\\n"; fi\n',
      );
      chmodSync(join(fixture, "bin", binary), 0o755);
    }
    for (const asset of [
      "arashi-windows-x64.exe",
      "arashi.bat",
      "arashi.ps1",
      "aw.bat",
      "aw.ps1",
    ]) {
      writeFileSync(join(fixture, "bin", asset), `fixture:${asset}\n`);
    }
    writeFileSync(join(fixture, "stub-bin", "pnpm"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fixture, "stub-bin", "pnpm"), 0o755);

    const packaged = spawnSync("bash", ["scripts/package-releases.sh", "fixture"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(fixture, "stub-bin")}:${process.env.PATH ?? ""}` },
    });
    expect(packaged.status, packaged.stderr).toBe(0);
    const extracted = join(fixture, "extracted");
    mkdirSync(extracted);
    const unpacked = spawnSync(
      "tar",
      ["-xzf", join(fixture, "releases/arashi-fixture-linux-x64.tar.gz")],
      { cwd: extracted, encoding: "utf8" },
    );
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const archiveDirectory = join(extracted, "arashi-linux-x64");

    for (const name of ["arashi", "aw"] as const) {
      const prompt = spawnSync("bash", [join(archiveDirectory, name), "prompt"], {
        encoding: "utf8",
        input: "answer\n",
      });
      expect(prompt.status, prompt.stderr).toBe(0);
      expect(prompt.stdout).toBe("stdin:answer\n");

      const list = spawnSync("bash", [join(archiveDirectory, name), "list"], {
        encoding: "utf8",
        input: "must-not-arrive\n",
      });
      expect(list.status, list.stderr).toBe(0);
      expect(list.stdout).toBe("stdin:closed\n");
    }
  });
});
