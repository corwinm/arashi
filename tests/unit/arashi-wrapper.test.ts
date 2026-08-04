import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const sourceWrapper = join(import.meta.dirname, "../../bin/arashi");
const temporaryDirectories: string[] = [];

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "arashi-wrapper-"));
  temporaryDirectories.push(directory);
  copyFileSync(sourceWrapper, join(directory, "arashi"));
  chmodSync(join(directory, "arashi"), 0o755);
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
  options: { env?: NodeJS.ProcessEnv; input?: string; symlink?: boolean } = {},
) {
  const command = options.symlink ? join(directory, "linked-arashi") : join(directory, "arashi");
  if (options.symlink) {
    symlinkSync("arashi", command);
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

  test.each([["list"], ["remove", "--force", "topic"]])(
    "retains conditional stdin closure for piped %s",
    (...args) => {
      const directory = createFixture();
      writeBinary(directory, "arashi.bin.exe", "windows");

      const result = runWrapper(directory, args, {
        env: { CHECK_STDIN: "1", UNAME_S: "MINGW64_NT-10.0" },
        input: "must-not-arrive\n",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("stdin:closed");
    },
  );
});
