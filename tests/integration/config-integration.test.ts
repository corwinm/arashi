/**
 * Integration Tests for Configuration Management
 *
 * Tests file system operations, end-to-end flows, and error handling.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  loadConfig,
  saveConfig,
  configExists,
  generateDefaultConfig,
  getConfigPath,
  addRepo,
  removeRepo,
  repairRepositoryGitUrls,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  ConfigError,
  type Config,
} from "../../src/lib/config";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

describe("configExists", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns false when config does not exist", async () => {
    const exists = await configExists(testDir);
    expect(exists).toBe(false);
  });

  test("returns true when config exists", async () => {
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    const exists = await configExists(testDir);
    expect(exists).toBe(true);
  });
});

describe("saveConfig", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("writes configuration to file", async () => {
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    const configPath = getConfigPath(testDir);
    const file = Bun.file(configPath);
    expect(await file.exists()).toBe(true);
  });

  test("writes pretty-printed JSON with 2-space indentation", async () => {
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    const configPath = getConfigPath(testDir);
    const content = await Bun.file(configPath).text();

    // Check for 2-space indentation
    expect(content).toContain('  "version"');
    expect(content).toContain('  "repos_dir"');
    expect(content).not.toContain('    "version"'); // Not 4 spaces

    // Verify it's valid JSON
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe("1.0.0");
  });

  test("creates .arashi directory if missing", async () => {
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    // Check if directory exists by trying to access the config file
    const configPath = getConfigPath(testDir);
    const fileExists = await Bun.file(configPath).exists();
    expect(fileExists).toBe(true);
  });

  test("overwrites existing configuration", async () => {
    const config1 = generateDefaultConfig();
    await saveConfig(testDir, config1);

    const config2 = generateDefaultConfig();
    config2.auto_setup = false;
    await saveConfig(testDir, config2);

    const loaded = await loadConfig(testDir);
    expect(loaded.auto_setup).toBe(false);
  });

  test("preserves complex nested structures", async () => {
    const config: Config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "test-repo": {
          path: "./repos/test-repo",
          default_branch: "main",
          is_bare: false,
          worktrees: [
            {
              branch: "feature-123",
              path: "./repos/test-repo.worktrees/feature-123",
              created_at: "2026-02-03T10:30:00Z",
              metadata: {
                jira: "PROJ-123",
                owner: "alice",
              },
            },
          ],
          hooks: {
            post_create: "./.arashi/hooks/post-create.sh",
          },
        },
      },
    };

    await saveConfig(testDir, config);
    const loaded = await loadConfig(testDir);

    expect(loaded).toEqual(config);
    expect(loaded.discovered_repos["test-repo"].worktrees?.[0].metadata).toEqual({
      jira: "PROJ-123",
      owner: "alice",
    });
  });
});

describe("loadConfig", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("loads valid configuration", async () => {
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    const loaded = await loadConfig(testDir);
    expect(loaded).toEqual(config);
  });

  test("throws ConfigNotFoundError when file does not exist", async () => {
    await expect(loadConfig(testDir)).rejects.toThrow(ConfigNotFoundError);
  });

  test("ConfigNotFoundError contains helpful message", async () => {
    try {
      await loadConfig(testDir);
      expect(true).toBe(false); // Should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigNotFoundError);
      const err = error as ConfigNotFoundError;
      expect(err.message).toContain("not found");
      expect(err.message).toContain("arashi init");
      expect(err.context.path).toContain(".arashi/config.json");
    }
  });

  test("throws ConfigParseError on malformed JSON", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    await writeFile(configPath, "{ invalid json }");

    await expect(loadConfig(testDir)).rejects.toThrow(ConfigParseError);
  });

  test("ConfigParseError contains parse details", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    await writeFile(configPath, '{ "version": 1.0.0 }'); // Missing quotes

    try {
      await loadConfig(testDir);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigParseError);
      const err = error as ConfigParseError;
      expect(err.message).toContain("parse");
      expect(err.context.path).toContain("config.json");
    }
  });

  test("throws ConfigValidationError on invalid structure", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        repos_dir: "./repos",
        auto_setup: true,
        discovered_repos: {},
        // Missing version
      }),
    );

    await expect(loadConfig(testDir)).rejects.toThrow(ConfigValidationError);
  });

  test("ConfigValidationError lists specific problems", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: "", // Invalid
        auto_setup: "true", // Wrong type
        discovered_repos: {},
        // Missing repos_dir
      }),
    );

    try {
      await loadConfig(testDir);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.context.errors.length).toBeGreaterThan(0);
      expect(err.message).toContain("validation failed");
    }
  });

  test("loads configuration with extra fields (forward compatibility)", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    const configWithExtras = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {},
      future_feature: "some value",
      custom_data: { team: "backend" },
    };
    await writeFile(configPath, JSON.stringify(configWithExtras, null, 2));

    const loaded = await loadConfig(testDir);
    expect(loaded.version).toBe("1.0.0");
    expect((loaded as { future_feature?: unknown }).future_feature).toBe("some value");
  });
});

describe("addRepo", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("adds repository to configuration", async () => {
    await addRepo(testDir, "my-app", {
      path: "./repos/my-app",
      default_branch: "main",
    });

    const config = await loadConfig(testDir);
    expect(config.discovered_repos["my-app"]).toBeDefined();
    expect(config.discovered_repos["my-app"].path).toBe("./repos/my-app");
    expect(config.discovered_repos["my-app"].default_branch).toBe("main");
  });

  test("adds repository with minimal fields", async () => {
    await addRepo(testDir, "simple-repo", {
      path: "./repos/simple",
    });

    const config = await loadConfig(testDir);
    expect(config.discovered_repos["simple-repo"]).toBeDefined();
    expect(config.discovered_repos["simple-repo"].path).toBe("./repos/simple");
    expect(config.discovered_repos["simple-repo"].default_branch).toBeUndefined();
  });

  test("adds repository with complete configuration", async () => {
    await addRepo(testDir, "full-repo", {
      path: "./repos/full",
      default_branch: "develop",
      is_bare: true,
      hooks: {
        post_create: "./hooks/post.sh",
      },
    });

    const config = await loadConfig(testDir);
    const repo = config.discovered_repos["full-repo"];
    expect(repo.is_bare).toBe(true);
    expect(repo.hooks?.post_create).toBe("./hooks/post.sh");
  });

  test("throws error when repository name already exists", async () => {
    await addRepo(testDir, "duplicate", { path: "./repos/dup1" });

    await expect(addRepo(testDir, "duplicate", { path: "./repos/dup2" })).rejects.toThrow(
      ConfigError,
    );
  });

  test("error message for duplicate includes helpful context", async () => {
    await addRepo(testDir, "existing", { path: "./repos/existing" });

    try {
      await addRepo(testDir, "existing", { path: "./repos/new" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const err = error as ConfigError;
      expect(err.message).toContain("already exists");
      expect(err.message).toContain("existing");
      expect(err.context.name).toBe("existing");
    }
  });

  test("can add multiple repositories", async () => {
    await addRepo(testDir, "repo1", { path: "./repos/repo1" });
    await addRepo(testDir, "repo2", { path: "./repos/repo2" });
    await addRepo(testDir, "repo3", { path: "./repos/repo3" });

    const config = await loadConfig(testDir);
    expect(Object.keys(config.discovered_repos)).toHaveLength(3);
    expect(config.discovered_repos["repo1"]).toBeDefined();
    expect(config.discovered_repos["repo2"]).toBeDefined();
    expect(config.discovered_repos["repo3"]).toBeDefined();
  });

  test("preserves existing repositories when adding new one", async () => {
    await addRepo(testDir, "first", { path: "./repos/first" });
    await addRepo(testDir, "second", { path: "./repos/second" });

    const config = await loadConfig(testDir);
    expect(config.discovered_repos["first"]).toBeDefined();
    expect(config.discovered_repos["second"]).toBeDefined();
  });
});

describe("removeRepo", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("removes repository from configuration", async () => {
    await addRepo(testDir, "to-remove", { path: "./repos/to-remove" });
    await removeRepo(testDir, "to-remove");

    const config = await loadConfig(testDir);
    expect(config.discovered_repos["to-remove"]).toBeUndefined();
  });

  test("succeeds silently when repository does not exist (idempotent)", async () => {
    // Should not throw
    await removeRepo(testDir, "non-existent");

    const config = await loadConfig(testDir);
    expect(config.discovered_repos["non-existent"]).toBeUndefined();
  });

  test("preserves other repositories when removing one", async () => {
    await addRepo(testDir, "keep1", { path: "./repos/keep1" });
    await addRepo(testDir, "remove", { path: "./repos/remove" });
    await addRepo(testDir, "keep2", { path: "./repos/keep2" });

    await removeRepo(testDir, "remove");

    const config = await loadConfig(testDir);
    expect(config.discovered_repos["keep1"]).toBeDefined();
    expect(config.discovered_repos["keep2"]).toBeDefined();
    expect(config.discovered_repos["remove"]).toBeUndefined();
  });

  test("can remove and re-add repository", async () => {
    await addRepo(testDir, "repo", { path: "./repos/path1" });
    await removeRepo(testDir, "repo");
    await addRepo(testDir, "repo", { path: "./repos/path2" });

    const config = await loadConfig(testDir);
    expect(config.discovered_repos["repo"].path).toBe("./repos/path2");
  });
});

describe("round-trip tests", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("save and load preserves all data", async () => {
    const original: Config = {
      version: "1.0.0",
      repos_dir: "/absolute/path/to/repos",
      auto_setup: false,
      discovered_repos: {
        repo1: {
          path: "./repos/repo1",
          default_branch: "develop",
          is_bare: true,
        },
        repo2: {
          path: "./repos/repo2",
          worktrees: [
            {
              branch: "feature-auth",
              path: "./worktrees/feature-auth",
              created_at: "2026-02-03T15:45:30Z",
              metadata: {
                ticket: "JIRA-456",
                priority: "high",
              },
            },
          ],
          hooks: {
            pre_create: "./hooks/pre.sh",
            post_create: "./hooks/post.sh",
          },
        },
      },
    };

    await saveConfig(testDir, original);
    const loaded = await loadConfig(testDir);

    expect(loaded).toEqual(original);
  });

  test("multiple save-load cycles preserve data", async () => {
    let config = generateDefaultConfig();
    await saveConfig(testDir, config);

    config = await loadConfig(testDir);
    config.auto_setup = false;
    await saveConfig(testDir, config);

    config = await loadConfig(testDir);
    await addRepo(testDir, "test", { path: "./test" });

    config = await loadConfig(testDir);
    expect(config.auto_setup).toBe(false);
    expect(config.discovered_repos["test"]).toBeDefined();
  });

  test("persists repository git_url fields across save/load", async () => {
    const config: Config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "repo-with-url": {
          path: "./repos/repo-with-url",
          git_url: "git@github.com:team/repo-with-url.git",
        },
      },
    };

    await saveConfig(testDir, config);
    const loaded = await loadConfig(testDir);

    expect(loaded.discovered_repos["repo-with-url"]?.git_url).toBe(
      "git@github.com:team/repo-with-url.git",
    );
  });

  test("preserves JSON formatting across save-load cycles", async () => {
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    const content1 = await Bun.file(getConfigPath(testDir)).text();

    const loaded = await loadConfig(testDir);
    await saveConfig(testDir, loaded);

    const content2 = await Bun.file(getConfigPath(testDir)).text();

    expect(content1).toBe(content2);
  });
});

describe("end-to-end workflow", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("complete initialization workflow", async () => {
    // Check config doesn't exist
    expect(await configExists(testDir)).toBe(false);

    // Initialize with defaults
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    // Verify it exists
    expect(await configExists(testDir)).toBe(true);

    // Load and verify
    const loaded = await loadConfig(testDir);
    expect(loaded.version).toBe("1.0.0");
    expect(loaded.repos_dir).toBe("./repos");
  });

  test("complete repository management workflow", async () => {
    // Initialize
    await saveConfig(testDir, generateDefaultConfig());

    // Add repositories
    await addRepo(testDir, "frontend", {
      path: "./repos/frontend",
      default_branch: "main",
    });

    await addRepo(testDir, "backend", {
      path: "./repos/backend",
      default_branch: "develop",
    });

    // Verify both exist
    let config = await loadConfig(testDir);
    expect(Object.keys(config.discovered_repos)).toHaveLength(2);

    // Remove one
    await removeRepo(testDir, "frontend");

    // Verify only one remains
    config = await loadConfig(testDir);
    expect(Object.keys(config.discovered_repos)).toHaveLength(1);
    expect(config.discovered_repos["backend"]).toBeDefined();
  });

  test("modify configuration settings workflow", async () => {
    // Initialize
    await saveConfig(testDir, generateDefaultConfig());

    // Load and modify
    let config = await loadConfig(testDir);
    config.repos_dir = "/custom/path";
    config.auto_setup = false;
    await saveConfig(testDir, config);

    // Verify changes persisted
    config = await loadConfig(testDir);
    expect(config.repos_dir).toBe("/custom/path");
    expect(config.auto_setup).toBe(false);
  });
});

describe("repairRepositoryGitUrls", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("repairs missing git_url from local origin remote", async () => {
    const repoPath = join(testDir, "repos", "child-repo");
    await mkdir(repoPath, { recursive: true });

    await runGit(["init"], repoPath);
    await runGit(["remote", "add", "origin", "git@github.com:team/child-repo.git"], repoPath);

    const config: Config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "child-repo": {
          path: "./repos/child-repo",
        },
      },
    };

    const result = await repairRepositoryGitUrls(testDir, config);

    expect(result.updated).toBe(true);
    expect(result.repaired).toEqual(["child-repo"]);
    expect(config.discovered_repos["child-repo"].git_url).toBe(
      "git@github.com:team/child-repo.git",
    );
  });
});
