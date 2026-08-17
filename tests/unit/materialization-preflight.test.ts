import { afterEach, describe, expect, test } from "vitest";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveNativeSymlinkCapability } from "../../src/lib/materialization-preflight.ts";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("native symlink preflight capability", () => {
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
