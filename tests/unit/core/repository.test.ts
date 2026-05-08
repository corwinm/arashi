import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { detectSetupScript } from "../../../src/core/repository.js";
import { join } from "path";
import { tmpdir } from "os";

describe("detectSetupScript", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-setup-detect-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("detects setup.sh when present in repository root", async () => {
    const repoPath = join(testDir, "setup-repo");
    await mkdir(repoPath, { recursive: true });
    const setupPath = join(repoPath, "setup.sh");
    await Bun.write(setupPath, "#!/bin/bash\necho 'Setup script'");

    const result = await detectSetupScript(repoPath);

    expect(result.hasSetupScript).toBe(true);
    expect(result.setupScriptPath).toBe(setupPath);
  });

  test("returns false when no setup script exists", async () => {
    const repoPath = join(testDir, "no-setup-repo");
    await mkdir(repoPath, { recursive: true });

    const result = await detectSetupScript(repoPath);

    expect(result.hasSetupScript).toBe(false);
    expect(result.setupScriptPath).toBeUndefined();
  });

  test("detects multiple script patterns", async () => {
    const repo1Path = join(testDir, "bash-setup-repo");
    await mkdir(repo1Path, { recursive: true });
    const bashSetupPath = join(repo1Path, "setup.bash");
    await Bun.write(bashSetupPath, "#!/bin/bash\necho 'Bash setup'");

    const result1 = await detectSetupScript(repo1Path);
    expect(result1.hasSetupScript).toBe(true);
    expect(result1.setupScriptPath).toBe(bashSetupPath);

    const repo2Path = join(testDir, "arashi-setup-repo");
    await mkdir(join(repo2Path, ".arashi"), { recursive: true });
    const arashiSetupPath = join(repo2Path, ".arashi", "setup.sh");
    await Bun.write(arashiSetupPath, "#!/bin/bash\necho 'Arashi setup'");

    const result2 = await detectSetupScript(repo2Path);
    expect(result2.hasSetupScript).toBe(true);
    expect(result2.setupScriptPath).toBe(arashiSetupPath);
  });

  test("supports custom patterns from options", async () => {
    const repoPath = join(testDir, "custom-setup-repo");
    await mkdir(repoPath, { recursive: true });
    const customPath = join(repoPath, "install.sh");
    await Bun.write(customPath, "#!/bin/bash\necho 'Custom install'");

    const result = await detectSetupScript(repoPath, ["install.sh", "bootstrap.sh"]);

    expect(result.hasSetupScript).toBe(true);
    expect(result.setupScriptPath).toBe(customPath);
  });
});
