/**
 * Integration Tests for Configuration Management
 *
 * Tests file system operations, end-to-end flows, and error handling.
 */

import {
  ConfigError,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  UnsupportedConfigVersionError,
  addRepo,
  configExists,
  generateDefaultConfig,
  getConfigPath,
  loadConfig,
  removeRepo,
  repairRepositoryGitUrls,
  saveConfig,
} from "../../src/lib/config";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

type Config = Awaited<ReturnType<typeof loadConfig>>;

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
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
    await rm(testDir, { force: true, recursive: true });
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
    await rm(testDir, { force: true, recursive: true });
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
    expect(content).toContain('  "reposDir"');
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
    config2.reposDir = "./custom-repos";
    await saveConfig(testDir, config2);

    const loaded = await loadConfig(testDir);
    expect(loaded.reposDir).toBe("./custom-repos");
  });

  test("drops deprecated repository metadata while preserving canonical fields", async () => {
    const config = {
      repos: {
        "test-repo": {
          defaultBranch: "main",
          isBare: false,
          path: "./repos/test-repo",
          worktrees: [
            {
              branch: "feature-123",
              createdAt: "2026-02-03T10:30:00Z",
              path: "./repos/test-repo.worktrees/feature-123",
            },
          ],
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    await saveConfig(testDir, config as unknown as Config);
    const loaded = await loadConfig(testDir);

    expect(loaded.repos["test-repo"]).toEqual({
      path: "./repos/test-repo",
    });
  });
});

describe("loadConfig", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("loads valid configuration", async () => {
    const config = generateDefaultConfig();
    await saveConfig(testDir, config);

    const loaded = await loadConfig(testDir);
    expect(loaded).toEqual(config);
  });

  test("migrates version alias to canonical version and persists", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          repos: {},
          reposDir: "./repos",
          version: "1",
        },
        null,
        2,
      ),
    );

    const loaded = await loadConfig(testDir);
    expect(loaded.version).toBe("1.0.0");

    const persisted = JSON.parse(await Bun.file(configPath).text()) as { version: string };
    expect(persisted.version).toBe("1.0.0");
  });

  test("throws unsupported version error for future config versions", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        repos: {},
        reposDir: "./repos",
        version: "2.0.0",
      }),
    );

    await expect(loadConfig(testDir)).rejects.toThrow(UnsupportedConfigVersionError);
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
        repos: {},
        reposDir: "./repos",
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
        repos: {},
        // Missing reposDir
        version: "", // Invalid
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

  test("rejects configuration with unknown root fields", async () => {
    const configPath = getConfigPath(testDir);
    await mkdir(join(testDir, ".arashi"), { recursive: true });
    const configWithExtras = {
      custom_data: { team: "backend" },
      future_feature: "some value",
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };
    await writeFile(configPath, JSON.stringify(configWithExtras, null, 2));

    await expect(loadConfig(testDir)).rejects.toThrow(ConfigValidationError);
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
    await rm(testDir, { force: true, recursive: true });
  });

  test("adds repository to configuration", async () => {
    await addRepo(testDir, "my-app", {
      path: "./repos/my-app",
    });

    const config = await loadConfig(testDir);
    expect(config.repos["my-app"]).toBeDefined();
    expect(config.repos["my-app"].path).toBe("./repos/my-app");
    expect(config.repos["my-app"].gitUrl).toBeUndefined();
  });

  test("adds repository with minimal fields", async () => {
    await addRepo(testDir, "simple-repo", {
      path: "./repos/simple",
    });

    const config = await loadConfig(testDir);
    expect(config.repos["simple-repo"]).toBeDefined();
    expect(config.repos["simple-repo"].path).toBe("./repos/simple");
    expect(config.repos["simple-repo"].gitUrl).toBeUndefined();
  });

  test("adds repository with complete configuration", async () => {
    await addRepo(testDir, "full-repo", {
      gitUrl: "git@github.com:team/full.git",
      path: "./repos/full",
    });

    const config = await loadConfig(testDir);
    const repo = config.repos["full-repo"];
    expect(repo.path).toBe("./repos/full");
    expect(repo.gitUrl).toBe("git@github.com:team/full.git");
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
    expect(Object.keys(config.repos)).toHaveLength(3);
    expect(config.repos["repo1"]).toBeDefined();
    expect(config.repos["repo2"]).toBeDefined();
    expect(config.repos["repo3"]).toBeDefined();
  });

  test("preserves existing repositories when adding new one", async () => {
    await addRepo(testDir, "first", { path: "./repos/first" });
    await addRepo(testDir, "second", { path: "./repos/second" });

    const config = await loadConfig(testDir);
    expect(config.repos["first"]).toBeDefined();
    expect(config.repos["second"]).toBeDefined();
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
    await rm(testDir, { force: true, recursive: true });
  });

  test("removes repository from configuration", async () => {
    await addRepo(testDir, "to-remove", { path: "./repos/to-remove" });
    await removeRepo(testDir, "to-remove");

    const config = await loadConfig(testDir);
    expect(config.repos["to-remove"]).toBeUndefined();
  });

  test("succeeds silently when repository does not exist (idempotent)", async () => {
    // Should not throw
    await removeRepo(testDir, "non-existent");

    const config = await loadConfig(testDir);
    expect(config.repos["non-existent"]).toBeUndefined();
  });

  test("preserves other repositories when removing one", async () => {
    await addRepo(testDir, "keep1", { path: "./repos/keep1" });
    await addRepo(testDir, "remove", { path: "./repos/remove" });
    await addRepo(testDir, "keep2", { path: "./repos/keep2" });

    await removeRepo(testDir, "remove");

    const config = await loadConfig(testDir);
    expect(config.repos["keep1"]).toBeDefined();
    expect(config.repos["keep2"]).toBeDefined();
    expect(config.repos["remove"]).toBeUndefined();
  });

  test("can remove and re-add repository", async () => {
    await addRepo(testDir, "repo", { path: "./repos/path1" });
    await removeRepo(testDir, "repo");
    await addRepo(testDir, "repo", { path: "./repos/path2" });

    const config = await loadConfig(testDir);
    expect(config.repos["repo"].path).toBe("./repos/path2");
  });
});

describe("round-trip tests", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("save and load preserves all data", async () => {
    const original: Config = {
      repos: {
        repo1: {
          gitUrl: "git@github.com:team/repo1.git",
          path: "./repos/repo1",
        },
        repo2: {
          path: "./repos/repo2",
        },
      },
      reposDir: "/absolute/path/to/repos",
      version: "1.0.0",
    };

    await saveConfig(testDir, original);
    const loaded = await loadConfig(testDir);

    expect(loaded).toMatchObject(original);
  });

  test("multiple save-load cycles preserve data", async () => {
    let config = generateDefaultConfig();
    await saveConfig(testDir, config);

    config = await loadConfig(testDir);
    config.reposDir = "./repos-custom";
    await saveConfig(testDir, config);

    config = await loadConfig(testDir);
    await addRepo(testDir, "test", { path: "./test" });

    config = await loadConfig(testDir);
    expect(config.reposDir).toBe("./repos-custom");
    expect(config.repos["test"]).toBeDefined();
  });

  test("persists repository gitUrl fields across save/load", async () => {
    const config: Config = {
      repos: {
        "repo-with-url": {
          gitUrl: "git@github.com:team/repo-with-url.git",
          path: "./repos/repo-with-url",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    await saveConfig(testDir, config);
    const loaded = await loadConfig(testDir);

    expect(loaded.repos["repo-with-url"]?.gitUrl).toBe("git@github.com:team/repo-with-url.git");
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
    await rm(testDir, { force: true, recursive: true });
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
    expect(loaded.reposDir).toBe("./repos");
  });

  test("complete repository management workflow", async () => {
    // Initialize
    await saveConfig(testDir, generateDefaultConfig());

    // Add repositories
    await addRepo(testDir, "frontend", {
      path: "./repos/frontend",
    });

    await addRepo(testDir, "backend", {
      path: "./repos/backend",
    });

    // Verify both exist
    let config = await loadConfig(testDir);
    expect(Object.keys(config.repos)).toHaveLength(2);

    // Remove one
    await removeRepo(testDir, "frontend");

    // Verify only one remains
    config = await loadConfig(testDir);
    expect(Object.keys(config.repos)).toHaveLength(1);
    expect(config.repos["backend"]).toBeDefined();
  });

  test("modify configuration settings workflow", async () => {
    // Initialize
    await saveConfig(testDir, generateDefaultConfig());

    // Load and modify
    let config = await loadConfig(testDir);
    config.reposDir = "/custom/path";
    await saveConfig(testDir, config);

    // Verify changes persisted
    config = await loadConfig(testDir);
    expect(config.reposDir).toBe("/custom/path");
  });
});

describe("repairRepositoryGitUrls", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("repairs missing gitUrl from local origin remote", async () => {
    const repoPath = join(testDir, "repos", "child-repo");
    await mkdir(repoPath, { recursive: true });

    await runGit(["init"], repoPath);
    await runGit(["remote", "add", "origin", "git@github.com:team/child-repo.git"], repoPath);

    const config: Config = {
      repos: {
        "child-repo": {
          path: "./repos/child-repo",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const result = await repairRepositoryGitUrls(testDir, config);

    expect(result.updated).toBe(true);
    expect(result.repaired).toEqual(["child-repo"]);
    expect(config.repos["child-repo"].gitUrl).toBe("git@github.com:team/child-repo.git");
  });
});
