import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  releaseCommandInvocation,
  releaseNpmCommand,
  spawnReleaseCommand,
} from "../../scripts/release/release-command.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

describe("release verifier command launching", () => {
  test("uses the Node installation npm shim instead of a project-local Windows shim", () => {
    expect(releaseNpmCommand("win32", "C:\\Program Files\\nodejs\\node.exe")).toBe(
      "C:\\Program Files\\nodejs\\npm.cmd",
    );
    expect(releaseNpmCommand("linux", "/usr/local/bin/node")).toBe("npm");
  });

  test("routes Windows commands and npm shims through the command interpreter", () => {
    expect(
      releaseCommandInvocation("C:\\release fixture\\aw.cmd", ["--version"], "win32", "cmd.exe"),
    ).toEqual({
      args: ["/d", "/s", "/c", 'call "C:\\release fixture\\aw.cmd" "--version"'],
      command: "cmd.exe",
      windowsVerbatimArguments: true,
    });
    expect(releaseCommandInvocation("npm", ["view"], "win32", "cmd.exe")).toEqual({
      args: ["/d", "/s", "/c", 'call npm "view"'],
      command: "cmd.exe",
      windowsVerbatimArguments: true,
    });
  });

  test("keeps POSIX commands direct", () => {
    expect(releaseCommandInvocation("npm", ["view"], "linux", "cmd.exe")).toEqual({
      args: ["view"],
      command: "npm",
    });
  });

  test.skipIf(process.platform !== "win32")(
    "executes a generated Windows cmd shim with arguments",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "arashi-release-command-"));
      fixtures.push(directory);
      for (const shimName of ["aw.cmd", "release shim.cmd"]) {
        const shim = join(directory, shimName);
        writeFileSync(shim, "@echo off\r\necho %~1,%~2\r\n");
        const result = spawnReleaseCommand(shim, ["first", "second"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(result.status, result.error?.message || result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("first,second");
      }
    },
  );
});
