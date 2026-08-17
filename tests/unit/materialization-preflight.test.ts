import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  inspectMaterializationSourceTree,
  resolveNativeSymlinkCapability,
} from "../../src/lib/materialization-preflight.ts";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("materialization source preflight", () => {
  test.skipIf(process.platform === "win32")(
    "rejects a FIFO nested inside a configured source directory",
    async () => {
      const sourceRoot = await mkdtemp(join(tmpdir(), "arashi-nonregular-source-test-"));
      cleanupRoots.push(sourceRoot);
      await promisify(execFile)("mkfifo", [join(sourceRoot, "blocked.fifo")]);

      await expect(inspectMaterializationSourceTree(sourceRoot, sourceRoot)).rejects.toThrow(
        "Materialization sources must be regular files or directories",
      );
    },
  );
});

describe("native symlink preflight capability", () => {
  test("places the probe on the destination filesystem and cleans it", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "arashi-symlink-capability-test-"));
    cleanupRoots.push(fixtureRoot);
    const destinationRoot = join(fixtureRoot, "managed", "worktree", "repos", "app");
    let observedTarget = "";

    await expect(
      resolveNativeSymlinkCapability("file", {
        probeBasePath: destinationRoot,
        createSymlink: async (target) => {
          observedTarget = target;
        },
      }),
    ).resolves.toBe("supported");
    const targetFromFixture = relative(await realpath(fixtureRoot), observedTarget);
    expect(targetFromFixture).not.toBe("..");
    expect(targetFromFixture.startsWith(`..${sep}`)).toBe(false);
    expect(isAbsolute(targetFromFixture)).toBe(false);
    await expect(access(join(fixtureRoot, "managed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports an unsupported host capability and removes the temporary probe", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "arashi-symlink-capability-test-"));
    cleanupRoots.push(fixtureRoot);
    const probeRoot = join(fixtureRoot, "probe");

    await expect(
      resolveNativeSymlinkCapability("directory", {
        createProbeRoot: async () => {
          await mkdir(probeRoot);
          return probeRoot;
        },
        createSymlink: async () => {
          throw Object.assign(new Error("native symlinks denied"), { code: "EPERM" });
        },
      }),
    ).resolves.toBe("unsupported");
    await expect(access(probeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not classify probe-root permission failures as unsupported symlinks", async () => {
    const operational = Object.assign(new Error("probe root denied"), { code: "EACCES" });
    await expect(
      resolveNativeSymlinkCapability("file", {
        createProbeRoot: async () => {
          throw operational;
        },
      }),
    ).rejects.toBe(operational);
  });

  test("propagates operational probe failures after cleanup", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "arashi-symlink-capability-test-"));
    cleanupRoots.push(fixtureRoot);
    const probeRoot = join(fixtureRoot, "probe");

    await expect(
      resolveNativeSymlinkCapability("file", {
        createProbeRoot: async () => {
          await mkdir(probeRoot);
          return probeRoot;
        },
        createSymlink: async () => {
          throw Object.assign(new Error("filesystem unavailable"), { code: "EIO" });
        },
      }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(access(probeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
