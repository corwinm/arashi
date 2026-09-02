import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import packageJson from "../../package.json";
import commandContract from "../../contracts/cli-commands.json";

const root = join(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArgs = (args: string[]): string[] =>
  process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;

const expectedPolicy = {
  alias: { expansion: "Arashi Workspace", name: "aw" },
  canonical: "arashi",
  completionNames: ["arashi", "aw"],
  ledger: { name: ".arashi-managed-entrypoints.json", schemaVersion: 2 },
  nativeBinaries: { posix: "arashi.bin", windows: "arashi.bin.exe" },
  npmBins: { arashi: "./bin/arashi.js", aw: "./bin/arashi.js" },
  posix: { installed: ["arashi.bin", "arashi", "aw", "uninstall.sh"] },
  shellWrapperNames: ["arashi", "aw"],
  windows: {
    installed: [
      "arashi.bin.exe",
      "arashi",
      "arashi.ps1",
      "arashi.bat",
      "aw",
      "aw.ps1",
      "aw.bat",
      "uninstall.ps1",
    ],
  },
};

describe("versioned executable distribution contract", () => {
  test("is generated from one typed source policy with canonical identity boundaries", () => {
    expect(existsSync(join(root, "src/contracts/executable-distribution.ts"))).toBe(true);
    const artifact = JSON.parse(read("contracts/executable-distribution.json"));
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact).toMatchObject(expectedPolicy);
    expect(artifact.identity).toMatchObject({
      branding: "arashi",
      commanderProgramName: "arashi",
      environmentPrefix: "ARASHI_",
      packageName: "arashi",
    });
    expect(artifact.ownership).toMatchObject({
      collisionPolicy: "marker-and-ledger-hash",
      ledger: expectedPolicy.ledger,
    });
    expect(artifact.ownership.markers).toMatchObject({
      cmd: expect.stringContaining("arashi-managed-alias"),
      posix: expect.stringContaining("arashi-managed-alias"),
      powershell: expect.stringContaining("arashi-managed-alias"),
    });
  });

  test("generates deterministically and is registered in stable quality/package gates", () => {
    expect(packageJson.scripts["executable-contract:generate"]).toBeTruthy();
    expect(packageJson.scripts["executable-contract:check"]).toBeTruthy();
    expect(packageJson.scripts.prepublishOnly).toContain("executable-contract:check");
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/contracts/executable-distribution.ts"), "--check"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  test("keeps executable aliases out of Commander paths and aliasPaths", () => {
    const { commands } = commandContract as {
      commands: { aliasPaths?: string[]; path: string }[];
    };
    expect(commands.some(({ path }) => path === "aw" || path.startsWith("aw "))).toBe(false);
    expect(commands.flatMap(({ aliasPaths = [] }) => aliasPaths)).not.toContain("aw");
  });

  test("matches npm, release, checksum, retained archive, installer, shell, and completion consumers", () => {
    expect(packageJson.bin).toEqual(expectedPolicy.npmBins);
    for (const asset of ["bin/aw", "bin/aw.ps1", "bin/aw.bat"]) {
      expect(existsSync(join(root, asset)), asset).toBe(true);
    }
    const combined = [
      read(".releaserc.json"),
      read("scripts/generate-checksums.sh"),
      read("scripts/package-releases.sh"),
      read("scripts/install.sh"),
      read("scripts/install.ps1"),
    ].join("\n");
    for (const asset of ["aw", "aw.ps1", "aw.bat"]) {
      expect(combined).toContain(asset);
    }
    expect(read("src/lib/shell-integration.ts")).toContain('"aw"');
    expect(read("src/completion/render.ts")).toMatch(/(?:complete|compdef|complete -c)[^\n]*aw/);
  });

  test("registers an exact-version post-publication gate and manual Windows stage", () => {
    expect(packageJson.scripts["release:verify-aw"]).toBeTruthy();
    const verifier = read("scripts/release/verify-aw.ts");
    expect(verifier).toContain("latest");
    expect(verifier).toContain("releaseNpmCommand");
    expect(verifier).toMatch(/run\(npmCommand, \[\s*"view"/);
    expect(verifier).toContain("ARASHI_VERSION");
    const commandLauncher = read("scripts/release/release-command.ts");
    expect(commandLauncher).toContain("npm.cmd");
    expect(commandLauncher).toContain("ComSpec");
    expect(commandLauncher).toContain('["call", command, ...args]');
    const workflow = read(".github/workflows/verify-aw-release.yml");
    expect(workflow).toContain("verify-aw-windows");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("release:verify-aw");
    const windowsJob = workflow.slice(workflow.indexOf("verify-aw-windows:"));
    expect(windowsJob).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(windowsJob).toContain("node-version: 24.18.0");
    expect(
      windowsJob.indexOf("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"),
    ).toBeLessThan(windowsJob.indexOf("Verify public npm package"));
  });

  test("hardens release pushes and automatically verifies a newly published version", () => {
    const releaseConfig = JSON.parse(read(".releaserc.json")) as {
      repositoryUrl?: string;
    };
    const releaseWorkflow = read(".github/workflows/release.yml");
    const verificationWorkflow = read(".github/workflows/verify-aw-release.yml");

    expect(releaseConfig.repositoryUrl).toBe("git@github.com:corwinm/arashi.git");
    expect(releaseWorkflow).toContain("concurrency:");
    expect(releaseWorkflow).toContain("cancel-in-progress: false");
    expect(releaseWorkflow).toContain("timeout-minutes:");
    expect(releaseWorkflow).toContain("ssh-key: ${{ secrets.RELEASE_DEPLOY_KEY }}");
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/verify-aw-release.yml");
    expect(releaseWorkflow).toContain("needs.release.outputs.version");
    expect(releaseWorkflow).not.toMatch(/^\s*uses:\s+[^\s]+@v\d+/mu);
    expect(releaseWorkflow).not.toContain("pull-requests: write");
    expect(releaseWorkflow).not.toContain("issues: write");
    expect(verificationWorkflow).toContain("workflow_call:");
    expect(verificationWorkflow).toContain("wait-for-publication:");
    expect(verificationWorkflow).toContain("needs: wait-for-publication");
    expect(verificationWorkflow).not.toMatch(/^\s*-?\s*uses:\s+[^\s]+@v\d+/mu);
    const publicationWait = verificationWorkflow.slice(
      verificationWorkflow.indexOf("Wait for exact public npm version"),
      verificationWorkflow.indexOf("verify-aw-posix:"),
    );
    expect(publicationWait).toContain("Exact version required");
    expect(publicationWait.indexOf("Exact version required")).toBeLessThan(
      publicationWait.indexOf("for attempt"),
    );
  });

  test("runs exact-version public npm and POSIX verification on a provisioned native POSIX runner", () => {
    const workflow = read(".github/workflows/verify-aw-release.yml");
    expect(workflow).toContain("verify-aw-posix:");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toMatch(/apt-get install[^\n]*(?:fish[^\n]*zsh|zsh[^\n]*fish)/);
    expect(workflow).toContain("pnpm release:verify-aw");
  });

  test("passes the dispatched POSIX verifier version through the environment", () => {
    const workflow = read(".github/workflows/verify-aw-release.yml");
    expect(workflow).toContain("VERIFY_VERSION: ${{ inputs.version }}");
    expect(workflow).toContain('pnpm release:verify-aw -- "$VERIFY_VERSION"');
    expect(workflow).not.toContain('pnpm release:verify-aw -- "${{ inputs.version }}"');
  });

  test("manual POSIX release instructions install the native payload and both wrappers together", () => {
    const installation = read("docs/INSTALLATION.md");
    const manual = installation.slice(
      installation.indexOf("## Manual macOS and Linux release fallback"),
      installation.indexOf("## Manual Windows release fallback"),
    );
    for (const nativeAsset of ["arashi-macos-arm64", "arashi-linux-x64"]) {
      expect(manual).toContain(`latest/download/${nativeAsset} -o arashi.bin`);
    }
    expect(manual.match(/latest\/download\/arashi -o arashi/g)).toHaveLength(2);
    expect(manual.match(/latest\/download\/aw -o aw/g)).toHaveLength(2);
    expect(
      manual.match(/sudo install -m 0755 arashi\.bin arashi aw \/usr\/local\/bin\//g),
    ).toHaveLength(2);
  });

  test("runs the packed npm generated-shim matrix on Windows without treating cmd shims as symlinks", () => {
    const packedAcceptance = read("tests/integration/npm-packed-alias.test.ts");
    expect(packedAcceptance).not.toContain('skipIf(process.platform === "win32")');
    expect(packedAcceptance).not.toContain("realpathSync(shim(");
    expect(packedAcceptance).toContain("ComSpec");
    expect(packedAcceptance).toContain('for (const name of ["arashi", "aw"]');
  });

  test("launches fresh Windows shells that resolve ordinary installer-produced names to the exact version", () => {
    const workflow = read(".github/workflows/verify-aw-release.yml");
    expect(workflow).toMatch(/& powershell\.exe[\s\S]*-NoProfile/);
    expect(workflow).toMatch(/& cmd\.exe[\s\S]*\/d/);
    expect(workflow).toContain("--noprofile --norc");
    expect(workflow).toContain("Get-Command arashi");
    expect(workflow).toContain("where arashi");
    expect(workflow).toContain("command -v arashi");
    expect(workflow).toContain("verify-aw-fresh.sh");
    expect(workflow).toContain("[System.IO.File]::WriteAllText($bashVerifier");
    expect(workflow).toContain('$bashVerifierContent -replace "`r`n", "`n"');
    expect(workflow).toContain("& $bash --noprofile --norc $bashVerifier");
    expect(workflow).not.toContain("& $bash --noprofile --norc -c");
    expect(workflow).toContain("ARASHI_EXPECTED_VERSION");
  });

  test("uses the real built CLI through aw for parent-shell switch acceptance", () => {
    const shellAcceptance = read("tests/unit/shell-integration-alias.test.ts");
    expect(shellAcceptance).not.toContain(String.raw`printf 'cd %s\n'`);
    expect(shellAcceptance).toMatch(/execFileSync\(\s*"bun",\s*\[\s*"build"/);
    expect(shellAcceptance).toContain("command aw shell init");
    expect(shellAcceptance).toContain("aw switch --all --path");
  });

  test("rejects missing and non-exact release verifier versions before installation", () => {
    const script = join(root, "scripts/release/verify-aw.ts");
    for (const args of [[], ["latest"]]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/exact|version/i);
    }
  });

  test("npm archive contains the shared entrypoint without a second native alias binary", () => {
    const packDirectory = mkdtempSync(join(tmpdir(), "arashi-aw-contract-pack-"));
    try {
      execFileSync(
        npmCommand,
        npmArgs([
          "pack",
          "--cache",
          join(packDirectory, "npm-cache"),
          "--pack-destination",
          packDirectory,
        ]),
        { cwd: root },
      );
      const archive = join(
        packDirectory,
        readdirSync(packDirectory).find((name) => name.endsWith(".tgz")) ?? "missing.tgz",
      );
      const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
      expect(files).toContain("package/bin/arashi.js");
      expect(files).not.toMatch(/(?:^|\/)aw\.bin(?:\.exe)?$/m);
    } finally {
      rmSync(packDirectory, { force: true, recursive: true });
    }
  });
});
