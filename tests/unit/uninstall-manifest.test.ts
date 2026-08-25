import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  MANIFEST_NAME,
  applyDirectUninstall,
  normalizeInstallDirectoryForPlatform,
  planDirectUninstall,
  readDirectInstallManifest,
  type DirectInstallManifest,
} from "../../src/lib/uninstall-manifest.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let installDirectory = "";

const payload = {
  "arashi.bin": "native",
  arashi: "canonical",
  aw: "alias",
  "uninstall.sh": "helper",
} as const;

function manifest(overrides: Record<string, unknown> = {}): DirectInstallManifest {
  return {
    schemaVersion: 2,
    installationChannel: "official-direct",
    platform: "posix",
    installDirectory,
    files: [
      {
        relativePath: "arashi.bin",
        role: "native-executable",
        digest: digest(payload["arashi.bin"]),
      },
      { relativePath: "arashi", role: "canonical-wrapper", digest: digest(payload.arashi) },
      { relativePath: "aw", role: "alias-wrapper", digest: digest(payload.aw) },
      {
        relativePath: "uninstall.sh",
        role: "uninstall-helper",
        digest: digest(payload["uninstall.sh"]),
      },
    ],
    ...overrides,
  } as DirectInstallManifest;
}

async function writeInstallation(value: DirectInstallManifest = manifest()): Promise<void> {
  for (const [name, contents] of Object.entries(payload)) {
    await writeFile(join(installDirectory, name), contents);
  }
  await writeFile(join(installDirectory, MANIFEST_NAME), `${JSON.stringify(value)}\n`);
}

beforeEach(async () => {
  installDirectory = await mkdtemp(join(await realpath(tmpdir()), "arashi-uninstall-manifest-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(installDirectory, { recursive: true, force: true });
});

describe("schema-v2 direct ownership manifest", () => {
  test("compares Windows install paths case-insensitively without trailing separators", () => {
    expect(normalizeInstallDirectoryForPlatform("C:\\Tools\\Arashi\\", "windows")).toBe(
      normalizeInstallDirectoryForPlatform("c:\\tools\\arashi", "windows"),
    );
  });

  test("accepts only the closed official POSIX payload", async () => {
    await writeInstallation();
    await expect(readDirectInstallManifest(installDirectory)).resolves.toEqual(manifest());

    for (const invalid of [
      manifest({ schemaVersion: 1 }),
      manifest({ installationChannel: "manual" }),
      manifest({ platform: "plan9" }),
      manifest({ surprise: true }),
      manifest({ files: [...manifest().files, manifest().files[0]] }),
      manifest({
        files: manifest().files.map((file, index) =>
          index === 0 ? { ...file, relativePath: "../escape" } : file,
        ),
      }),
      manifest({
        files: manifest().files.map((file, index) =>
          index === 0 ? { ...file, digest: "ABC" } : file,
        ),
      }),
      manifest({
        files: manifest().files.map((file, index) =>
          index === 0 ? { ...file, role: "mystery" } : file,
        ),
      }),
    ]) {
      await writeFile(join(installDirectory, MANIFEST_NAME), JSON.stringify(invalid));
      await expect(readDirectInstallManifest(installDirectory)).rejects.toThrow();
    }
  });

  test("requires the exact Windows file roles and PATH provenance", async () => {
    const files = [
      ["arashi.bin.exe", "native-executable"],
      ["arashi", "canonical-wrapper"],
      ["arashi.ps1", "canonical-powershell-wrapper"],
      ["arashi.bat", "canonical-cmd-wrapper"],
      ["aw", "alias-wrapper"],
      ["aw.ps1", "alias-powershell-wrapper"],
      ["aw.bat", "alias-cmd-wrapper"],
      ["uninstall.ps1", "uninstall-helper"],
    ].map(([relativePath, role]) => ({ digest: "0".repeat(64), relativePath, role }));
    const value = manifest({
      platform: "windows",
      files,
      pathMutation: { entry: installDirectory, created: false },
    });
    await writeFile(join(installDirectory, MANIFEST_NAME), JSON.stringify(value));
    await expect(readDirectInstallManifest(installDirectory)).resolves.toEqual(value);

    await writeFile(
      join(installDirectory, MANIFEST_NAME),
      JSON.stringify({ ...value, pathMutation: { entry: installDirectory, created: "yes" } }),
    );
    await expect(readDirectInstallManifest(installDirectory)).rejects.toThrow(/pathMutation/);
  });
});

describe("direct uninstall plan and apply", () => {
  test("blocks modified, non-regular, and linked payload before any mutation", async () => {
    await writeInstallation();
    await writeFile(join(installDirectory, "aw"), "modified");
    await rm(join(installDirectory, "arashi"));
    await symlink(join(installDirectory, "arashi.bin"), join(installDirectory, "arashi"));

    const before = await readFile(join(installDirectory, "arashi.bin"), "utf8");
    await expect(planDirectUninstall(installDirectory)).rejects.toThrow(
      /aw.*digest|arashi.*symbolic link/s,
    );
    expect(await readFile(join(installDirectory, "arashi.bin"), "utf8")).toBe(before);
    expect((await lstat(join(installDirectory, MANIFEST_NAME))).isFile()).toBe(true);
  });

  test("refuses an install directory reached through a symbolic link", async () => {
    const realDirectory = installDirectory;
    const linkedDirectory = `${installDirectory}-link`;
    await symlink(realDirectory, linkedDirectory);
    installDirectory = linkedDirectory;
    await writeInstallation();
    await expect(planDirectUninstall(linkedDirectory)).rejects.toThrow(
      /install directory.*symbolic link/i,
    );
    expect(await readFile(join(realDirectory, "aw"), "utf8")).toBe("alias");
    await rm(linkedDirectory);
    installDirectory = realDirectory;
  });

  test("canonicalizes a stable linked ancestor before planning deletion", async () => {
    const fixtureRoot = installDirectory;
    const realParent = join(fixtureRoot, "real-parent");
    await mkdir(join(realParent, "bin"), { recursive: true });
    await symlink(realParent, join(fixtureRoot, "linked-parent"), "dir");
    installDirectory = join(fixtureRoot, "linked-parent", "bin");
    await writeInstallation();

    const plan = await planDirectUninstall(installDirectory);
    expect(plan.installDirectory).toBe(join(realParent, "bin"));
    expect(plan.files.find((file) => file.relativePath === "aw")?.status).toBe("removable");
    expect(await readFile(join(realParent, "bin", "aw"), "utf8")).toBe("alias");
    await applyDirectUninstall(plan);
    await expect(readFile(join(realParent, "bin", MANIFEST_NAME), "utf8")).rejects.toThrow();
    installDirectory = fixtureRoot;
  });

  test("treats absent listed files as exact rerun no-ops and removes the manifest last", async () => {
    await writeInstallation();
    await rm(join(installDirectory, "aw"));
    await writeFile(join(installDirectory, "neighbor"), "preserve");
    const plan = await planDirectUninstall(installDirectory);
    expect(plan.files.find((file) => file.relativePath === "aw")?.status).toBe("absent");

    const events: string[] = [];
    await applyDirectUninstall(plan, {
      removeFile: async (path) => {
        events.push(path);
        await rm(path);
      },
    });
    expect(events.at(-1)).toBe(join(installDirectory, MANIFEST_NAME));
    expect(await readFile(join(installDirectory, "neighbor"), "utf8")).toBe("preserve");
    expect((await lstat(installDirectory)).isDirectory()).toBe(true);
  });

  test("removes exact recorded POSIX PATH bytes once and preserves outside bytes", async () => {
    const profile = join(installDirectory, "profile");
    const insertedBytes = `\n# arashi installer PATH\nexport PATH="${installDirectory}:$PATH"\n`;
    await writeFile(profile, `before${insertedBytes}after`);
    await writeInstallation(manifest({ pathMutation: { profilePath: profile, insertedBytes } }));
    const plan = await planDirectUninstall(installDirectory);
    await applyDirectUninstall(plan);
    expect(await readFile(profile, "utf8")).toBe("beforeafter");
  });

  test("preserves non-UTF-8 bytes outside exact recorded POSIX PATH bytes", async () => {
    const profile = join(installDirectory, "profile");
    const insertedBytes = "owned-path-bytes";
    const prefix = Buffer.from([0xff, 0x0a]);
    const suffix = Buffer.from([0x0a, 0x80]);
    await writeFile(profile, Buffer.concat([prefix, Buffer.from(insertedBytes), suffix]));
    await writeInstallation(manifest({ pathMutation: { profilePath: profile, insertedBytes } }));

    const plan = await planDirectUninstall(installDirectory);
    await applyDirectUninstall(plan);

    expect(await readFile(profile)).toEqual(Buffer.concat([prefix, suffix]));
  });

  test("preserves duplicate or linked PATH state while allowing owned payload cleanup", async () => {
    const profile = join(installDirectory, "profile");
    const insertedBytes = "owned-path-bytes\n";
    await writeFile(profile, insertedBytes.repeat(2));
    await writeInstallation(manifest({ pathMutation: { profilePath: profile, insertedBytes } }));
    const duplicatePlan = await planDirectUninstall(installDirectory);
    expect(duplicatePlan.pathMutation?.status).toBe("preserved");
    await applyDirectUninstall(duplicatePlan);
    expect(await readFile(profile, "utf8")).toBe(insertedBytes.repeat(2));

    await writeInstallation(manifest({ pathMutation: { profilePath: profile, insertedBytes } }));
    await rm(profile);
    await symlink(join(installDirectory, "aw"), profile);
    const linkedPlan = await planDirectUninstall(installDirectory);
    expect(linkedPlan.pathMutation?.status).toBe("preserved");
    await applyDirectUninstall(linkedPlan);
    expect((await lstat(profile)).isSymbolicLink()).toBe(true);
  });
});
