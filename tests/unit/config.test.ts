/**
 * Unit Tests for Configuration Management
 *
 * Tests pure functions and validation logic without file system operations.
 */

import { describe, test, expect } from "bun:test";
import {
  getConfigPath,
  generateDefaultConfig,
  validateConfig,
  ConfigValidationError,
  type Config,
} from "../../src/lib/config";
import { join } from "path";

describe("getConfigPath", () => {
  test("constructs correct path with repo path", () => {
    const repoPath = "/path/to/repo";
    const configPath = getConfigPath(repoPath);
    expect(configPath).toBe(join(repoPath, ".arashi", "config.json"));
  });

  test("handles relative paths", () => {
    const repoPath = "./my-repo";
    const configPath = getConfigPath(repoPath);
    expect(configPath).toBe(join("./my-repo", ".arashi", "config.json"));
  });

  test("handles paths with trailing slash", () => {
    const repoPath = "/path/to/repo/";
    const configPath = getConfigPath(repoPath);
    expect(configPath).toContain(".arashi");
    expect(configPath).toContain("config.json");
  });
});

describe("generateDefaultConfig", () => {
  test("returns correct default structure", () => {
    const config = generateDefaultConfig();

    expect(config.version).toBe("1.0.0");
    expect(config.repos_dir).toBe("./repos");
    expect(config.auto_setup).toBe(true);
    expect(config.discovered_repos).toEqual({});
  });

  test("returns a new object each time", () => {
    const config1 = generateDefaultConfig();
    const config2 = generateDefaultConfig();

    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });
});

describe("validateConfig - root level", () => {
  test("accepts valid complete configuration", () => {
    const validConfig: Config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "example-repo": {
          path: "./repos/example-repo",
          default_branch: "main",
          is_bare: false,
        },
      },
    };

    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  test("accepts minimal valid configuration", () => {
    const minimalConfig = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {},
    };

    expect(() => validateConfig(minimalConfig)).not.toThrow();
  });

  test("throws on null config", () => {
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
    expect(() => validateConfig(null)).toThrow("Config must be an object");
  });

  test("throws on non-object config", () => {
    expect(() => validateConfig("not an object")).toThrow(ConfigValidationError);
    expect(() => validateConfig(123)).toThrow(ConfigValidationError);
    expect(() => validateConfig([])).toThrow(ConfigValidationError);
  });

  test("catches missing version field", () => {
    const config = {
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {},
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("version");
  });

  test("catches missing repos_dir field", () => {
    const config = {
      version: "1.0.0",
      auto_setup: true,
      discovered_repos: {},
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("repos_dir");
  });

  test("catches missing auto_setup field", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      discovered_repos: {},
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("auto_setup");
  });

  test("catches missing discovered_repos field", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("discovered_repos");
  });

  test("catches invalid field types", () => {
    const config = {
      version: 1.0, // Should be string
      repos_dir: "./repos",
      auto_setup: "true", // Should be boolean
      discovered_repos: [], // Should be object
    };

    try {
      validateConfig(config);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.context.errors).toContain("version: must be a non-empty string");
      expect(err.context.errors).toContain("auto_setup: must be a boolean");
      expect(err.context.errors).toContain("discovered_repos: must be an object");
    }
  });

  test("catches empty string values", () => {
    const config = {
      version: "", // Empty string not allowed
      repos_dir: "",
      auto_setup: true,
      discovered_repos: {},
    };

    try {
      validateConfig(config);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.context.errors.length).toBeGreaterThan(0);
    }
  });

  test("preserves unknown fields (forward compatibility)", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {},
      future_feature: "some value",
      custom_metadata: { team: "backend" },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("validateConfig - RepoConfig validation", () => {
  test("accepts valid repository configuration", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          default_branch: "main",
          is_bare: false,
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts repository with minimal fields", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("catches missing path field in repository", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          default_branch: "main",
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("my-repo");
    expect(() => validateConfig(config)).toThrow("path");
  });

  test("catches invalid default_branch type", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          default_branch: 123, // Should be string
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("default_branch");
  });

  test("catches invalid is_bare type", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          is_bare: "false", // Should be boolean
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("is_bare");
  });

  test("catches non-array worktrees", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: "not-an-array",
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("worktrees");
  });
});

describe("validateConfig - WorktreeInfo validation", () => {
  test("accepts valid worktree configuration", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: [
            {
              branch: "feature-123",
              path: "./repos/my-repo.worktrees/feature-123",
              created_at: "2026-02-03T10:30:00Z",
            },
          ],
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts worktree with metadata", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: [
            {
              branch: "feature-123",
              path: "./repos/my-repo.worktrees/feature-123",
              created_at: "2026-02-03T10:30:00Z",
              metadata: {
                jira_ticket: "PROJ-123",
                owner: "alice",
              },
            },
          ],
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("catches missing branch field", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: [
            {
              path: "./repos/my-repo.worktrees/feature-123",
              created_at: "2026-02-03T10:30:00Z",
            },
          ],
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("branch");
  });

  test("catches missing path field in worktree", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: [
            {
              branch: "feature-123",
              created_at: "2026-02-03T10:30:00Z",
            },
          ],
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("path");
  });

  test("catches missing created_at field", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: [
            {
              branch: "feature-123",
              path: "./repos/my-repo.worktrees/feature-123",
            },
          ],
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("created_at");
  });

  test("catches invalid ISO 8601 date", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: [
            {
              branch: "feature-123",
              path: "./repos/my-repo.worktrees/feature-123",
              created_at: "not-a-date",
            },
          ],
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("created_at");
    expect(() => validateConfig(config)).toThrow("ISO 8601");
  });

  test("catches invalid metadata type", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          worktrees: [
            {
              branch: "feature-123",
              path: "./repos/my-repo.worktrees/feature-123",
              created_at: "2026-02-03T10:30:00Z",
              metadata: "not-an-object",
            },
          ],
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("metadata");
  });
});

describe("validateConfig - HookConfig validation", () => {
  test("accepts valid hook configuration", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          hooks: {
            pre_create: "./.arashi/hooks/pre-create.sh",
            post_create: "./.arashi/hooks/post-create.sh",
            setup: "./.arashi/hooks/setup.sh",
          },
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts partial hook configuration", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          hooks: {
            post_create: "./.arashi/hooks/post-create.sh",
          },
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("catches invalid pre_create type", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          hooks: {
            pre_create: 123,
          },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("pre_create");
  });

  test("catches empty hook paths", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "my-repo": {
          path: "./repos/my-repo",
          hooks: {
            post_create: "",
          },
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("post_create");
  });
});

describe("validateConfig - error messages", () => {
  test("provides multiple errors in single validation", () => {
    const config = {
      version: "", // Invalid
      repos_dir: "./repos",
      auto_setup: "not-a-boolean", // Invalid
      discovered_repos: {
        "bad-repo": {
          // Missing path
          default_branch: 123, // Invalid type
        },
      },
    };

    try {
      validateConfig(config);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.context.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("error message includes helpful context", () => {
    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {},
    };
    delete (config as { version?: string }).version;

    try {
      validateConfig(config);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.message).toContain("Configuration validation failed");
      expect(err.message).toContain("version");
    }
  });
});
