import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "../..");
const requiredWindowsAssets = [
  "arashi",
  "arashi.bat",
  "arashi.ps1",
  "aw",
  "aw.bat",
  "aw.ps1",
  "arashi-windows-x64.exe",
] as const;
const requiredInstallerAssets = [...requiredWindowsAssets, "arashi-checksums.txt"].toSorted();
const temporaryDirectories: string[] = [];

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function quotedShellArray(script: string, name: string): string[] {
  const body = script.match(new RegExp(`${name}=\\(\\n([\\s\\S]*?)\\n\\)`))?.[1];
  if (!body) {
    throw new Error(`Missing shell array ${name}`);
  }
  return [...body.matchAll(/^\s*"([^"]+)"\s*$/gm)].map((match) => match[1]).toSorted();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("canonical Windows release payload", () => {
  test("keeps the extensionless Bash wrapper on LF line endings for Windows checkouts", () => {
    expect(read(".gitattributes")).toContain("bin/arashi text eol=lf");
  });

  test("is downloaded and checksum-verified by the installer", () => {
    const installer = read("scripts/install.ps1");
    const installerAssets = [...installer.matchAll(/^\$\w+Asset = "([^"]+)"$/gm)]
      .map((match) => match[1])
      .toSorted();

    expect(installerAssets).toEqual(requiredInstallerAssets);
    expect(installer).toContain("Assert-ArashiChecksum");
  });

  test("is published exactly by semantic-release and covered exactly by the checksum producer", () => {
    const release = JSON.parse(read(".releaserc.json")) as {
      plugins: (string | [string, { assets?: { path: string }[] }])[];
    };
    const github = release.plugins.find(
      (plugin): plugin is [string, { assets: { path: string }[] }] =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/github",
    );
    expect(github).toBeDefined();
    const publishedWindowsAssets =
      github?.[1].assets
        .map((asset) => asset.path.replace("bin/", ""))
        .filter(
          (asset) =>
            asset === "arashi" ||
            asset === "arashi.bat" ||
            asset === "arashi.ps1" ||
            asset === "aw" ||
            asset === "aw.bat" ||
            asset === "aw.ps1" ||
            asset === "arashi-windows-x64.exe" ||
            asset === "arashi-checksums.txt",
        )
        .toSorted() ?? [];

    expect(publishedWindowsAssets).toEqual(requiredInstallerAssets);
    expect(
      quotedShellArray(read("scripts/generate-checksums.sh"), "ASSETS").filter((asset) =>
        requiredWindowsAssets.includes(asset as (typeof requiredWindowsAssets)[number]),
      ),
    ).toEqual([...requiredWindowsAssets].toSorted());
  });

  test("ships the same supported seven-file payload in the Windows archive", () => {
    const packager = read("scripts/package-releases.sh");

    expect(packager).toContain('cp bin/arashi "$DIST_DIR/arashi-windows-x64/arashi"');
    expect(packager).toContain("arashi.bin.exe");
    expect(packager).toContain("arashi.ps1");
    expect(packager).toContain("arashi.bat");
    expect(packager).toContain('cp bin/aw "$DIST_DIR/arashi-windows-x64/aw"');
    expect(packager).toContain("aw.ps1");
    expect(packager).toContain("aw.bat");
    expect(packager).toContain("Git Bash");
    expect(packager).toContain("Open a new");
  });

  test.skipIf(process.platform === "win32")(
    "executes the packager and inspects the generated Windows archive",
    () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "arashi-release-contract-"));
      temporaryDirectories.push(fixtureRoot);
      mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
      mkdirSync(join(fixtureRoot, "bin"), { recursive: true });
      mkdirSync(join(fixtureRoot, "stub-bin"), { recursive: true });
      copyFileSync(
        join(root, "scripts/package-releases.sh"),
        join(fixtureRoot, "scripts/package-releases.sh"),
      );

      for (const asset of [
        "arashi",
        "arashi.bat",
        "arashi.ps1",
        "aw",
        "aw.bat",
        "aw.ps1",
        "arashi-macos-arm64",
        "arashi-linux-x64",
        "arashi-windows-x64.exe",
      ]) {
        writeFileSync(join(fixtureRoot, "bin", asset), `fixture:${asset}\n`);
      }
      const pnpmStub = join(fixtureRoot, "stub-bin", "pnpm");
      writeFileSync(pnpmStub, "#!/bin/sh\nexit 0\n");
      chmodSync(pnpmStub, 0o755);

      execFileSync("bash", ["scripts/package-releases.sh", "fixture"], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: `${join(fixtureRoot, "stub-bin")}:${process.env.PATH}` },
        stdio: "pipe",
      });

      const archive = join(fixtureRoot, "releases/arashi-fixture-windows-x64.zip");
      const members = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter((member) => !member.endsWith("/"))
        .toSorted();
      expect(members).toEqual(
        [
          "README.txt",
          "arashi",
          "arashi.bat",
          "arashi.bin.exe",
          "arashi.ps1",
          "aw",
          "aw.bat",
          "aw.ps1",
        ]
          .map((name) => `arashi-windows-x64/${name}`)
          .toSorted(),
      );
      expect(
        execFileSync("unzip", ["-p", archive, "arashi-windows-x64/arashi"], { encoding: "utf8" }),
      ).toBe("fixture:arashi\n");
    },
  );
});
