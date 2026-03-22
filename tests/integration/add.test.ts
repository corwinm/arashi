/**
 * Integration tests for the add command
 *
 * Tests the full add command workflow including:
 * - URL validation and parsing
 * - Repository cloning
 * - Branch detection
 * - Setup script detection
 * - Configuration updates
 * - Error handling and rollback
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deriveRepoName,
  detectSetupScript,
  isValidGitUrl,
  parseGitUrl,
} from "../../src/commands/add.ts";
import { mkdir, rm } from "fs/promises";
import { AddCommandErrorCode } from "../../src/lib/errors.ts";
import { existsSync } from "fs";
import { join } from "path";

// Test workspace directory
const TEST_WORKSPACE = join(import.meta.dir, "../temp-integration-workspace");

describe("Add Command - URL Validation", () => {
  test("validates HTTPS URLs correctly", () => {
    expect(isValidGitUrl("https://github.com/user/repo.git")).toBe(true);
    expect(isValidGitUrl("https://github.com/user/repo")).toBe(true);
    expect(isValidGitUrl("https://gitlab.com/org/project.git")).toBe(true);
  });

  test("validates SSH URLs correctly", () => {
    expect(isValidGitUrl("git@github.com:user/repo.git")).toBe(true);
    expect(isValidGitUrl("ssh://git@github.com/user/repo.git")).toBe(true);
    expect(isValidGitUrl("git@gitlab.company.com:team/project.git")).toBe(true);
  });

  test("validates Git protocol URLs correctly", () => {
    expect(isValidGitUrl("git://github.com/user/repo.git")).toBe(true);
    expect(isValidGitUrl("git://host.com/repo.git")).toBe(true);
  });

  test("validates File URLs correctly", () => {
    expect(isValidGitUrl("file:///absolute/path/to/repo.git")).toBe(true);
    expect(isValidGitUrl("/absolute/path/to/repo.git")).toBe(true);
    expect(isValidGitUrl("/home/user/repos/local-repo")).toBe(true);
  });

  test("validates SCP-style URLs correctly", () => {
    expect(isValidGitUrl("user@host:repo.git")).toBe(true);
    expect(isValidGitUrl("deploy@server.com:project.git")).toBe(true);
  });

  test("rejects invalid URLs", () => {
    expect(isValidGitUrl("invalid-url")).toBe(false);
    expect(isValidGitUrl("http://github.com/user/repo.git")).toBe(false);
    expect(isValidGitUrl("github.com/user/repo")).toBe(false);
    expect(isValidGitUrl("./relative/path")).toBe(false);
    expect(isValidGitUrl("")).toBe(false);
  });
});

describe("Add Command - Repository Name Derivation", () => {
  test("derives name from HTTPS URLs", () => {
    expect(deriveRepoName("https://github.com/user/my-repo.git")).toBe("my-repo");
    expect(deriveRepoName("https://github.com/user/project")).toBe("project");
    expect(deriveRepoName("https://gitlab.com/org/team/nested-repo.git")).toBe("nested-repo");
  });

  test("derives name from SSH URLs", () => {
    expect(deriveRepoName("git@github.com:user/my-repo.git")).toBe("my-repo");
    expect(deriveRepoName("ssh://git@github.com/user/repo")).toBe("repo");
    expect(deriveRepoName("user@host:project.git")).toBe("project");
  });

  test("derives name from file URLs", () => {
    expect(deriveRepoName("file:///home/repos/local-repo.git")).toBe("local-repo");
    expect(deriveRepoName("/absolute/path/repo")).toBe("repo");
  });

  test("handles trailing slashes", () => {
    expect(deriveRepoName("https://github.com/user/repo.git/")).toBe("repo");
    expect(deriveRepoName("https://github.com/user/repo/")).toBe("repo");
  });

  test("handles special characters in names", () => {
    expect(deriveRepoName("https://github.com/user/my-repo-v2.git")).toBe("my-repo-v2");
    expect(deriveRepoName("https://github.com/user/repo_name.git")).toBe("repo_name");
    expect(deriveRepoName("https://github.com/user/repo.name.git")).toBe("repo.name");
  });

  test("throws on invalid derived names", () => {
    expect(() => deriveRepoName("https://github.com/user/my repo.git")).toThrow();
    expect(() => deriveRepoName("https://github.com/user/my@repo.git")).toThrow();
  });
});

describe("Add Command - URL Parsing", () => {
  test("parses HTTPS URLs correctly", () => {
    const info = parseGitUrl("https://github.com/facebook/react.git");
    expect(info.protocol).toBe("https");
    expect(info.host).toBe("github.com");
    expect(info.owner).toBe("facebook");
    expect(info.repository).toBe("react");
    expect(info.derivedName).toBe("react");
  });

  test("parses SSH URLs correctly", () => {
    const info = parseGitUrl("git@github.com:user/repo.git");
    expect(info.protocol).toBe("ssh");
    expect(info.host).toBe("github.com");
    expect(info.owner).toBe("user");
    expect(info.repository).toBe("repo");
    expect(info.derivedName).toBe("repo");
  });

  test("parses Git protocol URLs correctly", () => {
    const info = parseGitUrl("git://github.com/user/repo.git");
    expect(info.protocol).toBe("git");
    expect(info.host).toBe("github.com");
    expect(info.owner).toBe("user");
    expect(info.repository).toBe("repo");
  });

  test("parses File URLs correctly", () => {
    const info = parseGitUrl("file:///home/user/repos/local-repo.git");
    expect(info.protocol).toBe("file");
    expect(info.host).toBeNull();
    expect(info.repository).toBe("local-repo");
  });

  test("throws AddCommandError for invalid URLs", () => {
    try {
      parseGitUrl("invalid-url");
      expect(true).toBe(false); // Should not reach here
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        return;
      }
      expect(error.name).toBe("AddCommandError");
      expect((error as { code?: unknown }).code).toBe(AddCommandErrorCode.INVALID_URL);
    }
  });
});

describe("Add Command - Setup Script Detection", () => {
  let testRepoPath: string;

  beforeEach(async () => {
    testRepoPath = join(TEST_WORKSPACE, "test-repo-detection");
    await mkdir(testRepoPath, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(testRepoPath)) {
      await rm(testRepoPath, { force: true, recursive: true });
    }
  });

  test("detects setup.sh", async () => {
    const setupPath = join(testRepoPath, "setup.sh");
    await Bun.write(setupPath, '#!/bin/bash\necho "Setup"\n');

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBe(setupPath);
  });

  test("detects setup.bash", async () => {
    const setupPath = join(testRepoPath, "setup.bash");
    await Bun.write(setupPath, '#!/bin/bash\necho "Setup"\n');

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBe(setupPath);
  });

  test("detects install.sh", async () => {
    const setupPath = join(testRepoPath, "install.sh");
    await Bun.write(setupPath, '#!/bin/bash\necho "Install"\n');

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBe(setupPath);
  });

  test("detects bootstrap.sh", async () => {
    const setupPath = join(testRepoPath, "bootstrap.sh");
    await Bun.write(setupPath, '#!/bin/bash\necho "Bootstrap"\n');

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBe(setupPath);
  });

  test("detects Makefile with setup target", async () => {
    const makefilePath = join(testRepoPath, "Makefile");
    await Bun.write(makefilePath, 'setup:\n\t@echo "Running setup"\n');

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBe(makefilePath);
  });

  test("detects Makefile with install target", async () => {
    const makefilePath = join(testRepoPath, "Makefile");
    await Bun.write(makefilePath, 'install:\n\t@echo "Installing"\n');

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBe(makefilePath);
  });

  test("returns null when no setup script found", async () => {
    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBeNull();
  });

  test("returns null for Makefile without setup/install target", async () => {
    const makefilePath = join(testRepoPath, "Makefile");
    await Bun.write(makefilePath, 'build:\n\t@echo "Building"\n');

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBeNull();
  });

  test("prioritizes setup.sh over other scripts", async () => {
    await Bun.write(join(testRepoPath, "setup.sh"), "#!/bin/bash\n");
    await Bun.write(join(testRepoPath, "install.sh"), "#!/bin/bash\n");
    await Bun.write(join(testRepoPath, "bootstrap.sh"), "#!/bin/bash\n");

    const detected = await detectSetupScript(testRepoPath);
    expect(detected).toBe(join(testRepoPath, "setup.sh"));
  });
});

describe("Add Command - Edge Cases", () => {
  test("handles URLs with trailing slashes", () => {
    const info = parseGitUrl("https://github.com/user/repo.git/");
    expect(info.derivedName).toBe("repo");
  });

  test("handles URLs without .git suffix", () => {
    const info = parseGitUrl("https://github.com/user/repo");
    expect(info.derivedName).toBe("repo");
  });

  test("handles repository names with special characters", () => {
    const name = deriveRepoName("https://github.com/user/my-repo_v2.0.git");
    expect(name).toBe("my-repo_v2.0");
  });

  test("handles file:// URLs", () => {
    const info = parseGitUrl("file:///home/repos/project.git");
    expect(info.protocol).toBe("file");
    expect(info.derivedName).toBe("project");
  });

  test("handles SCP-style SSH URLs", () => {
    const info = parseGitUrl("user@server.com:repo.git");
    expect(info.protocol).toBe("ssh");
    expect(info.derivedName).toBe("repo");
  });
});

// Note: Full end-to-end integration tests with actual git repositories
// Would require network access and are better suited for manual testing
// Or CI/CD pipelines with test repositories.

describe("Add Command - Validation Summary", () => {
  test("all URL validation functions work correctly", () => {
    expect(() => {
      const valid = isValidGitUrl("https://github.com/user/repo.git");
      expect(valid).toBe(true);

      const name = deriveRepoName("https://github.com/user/repo.git");
      expect(name).toBe("repo");

      const info = parseGitUrl("https://github.com/user/repo.git");
      expect(info.repository).toBe("repo");
    }).not.toThrow();
  });
});
