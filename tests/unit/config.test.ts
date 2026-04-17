/**
 * Unit Tests for Configuration Management
 *
 * Tests pure functions and validation logic without file system operations.
 */

import {
  ConfigValidationError,
  UnsupportedConfigVersionError,
  generateDefaultConfig,
  getConfigPath,
  normalizeConfig,
  validateConfig,
} from "../../src/lib/config";
import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKTREES_DIR } from "../../src/lib/worktree-location";
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
    expect(config.reposDir).toBe("./repos");
    expect(config.worktreesDir).toBe(DEFAULT_WORKTREES_DIR);
    expect(config.repos).toEqual({});
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
    const validConfig = {
      repos: {
        "example-repo": {
          defaultBranch: "main",
          isBare: false,
          path: "./repos/example-repo",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  test("accepts minimal valid configuration", () => {
    const minimalConfig = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(minimalConfig)).not.toThrow();
  });

  test("accepts command-scoped defaults configuration", () => {
    const configWithDefaults = {
      defaults: {
        create: {
          launch: true,
          launchMode: "sesh",
          switch: true,
        },
        switch: {
          launchMode: "sesh",
          mode: "cd",
        },
      },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(configWithDefaults)).not.toThrow();
  });

  test("accepts editor-scoped create defaults configuration", () => {
    const configWithEditorDefaults = {
      defaults: {
        create: {
          switch: true,
        },
        editors: {
          cursor: {
            create: {
              launch: true,
            },
          },
          vscode: {
            create: {
              launchMode: "sesh",
            },
          },
        },
      },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(configWithEditorDefaults)).not.toThrow();
  });

  test("normalizes snake_case launch mode aliases", () => {
    const normalized = normalizeConfig({
      defaults: {
        create: {
          launch_mode: "sesh",
          switch: true,
        },
        switch: {
          launch_mode: "auto",
          mode: "auto",
        },
      },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });

    expect(normalized.defaults?.create?.launchMode).toBe("sesh");
    expect(normalized.defaults?.create?.launch).toBe(true);
    expect(normalized.defaults?.switch?.mode).toBe("auto");
    expect(normalized.defaults?.switch?.launchMode).toBe("auto");
  });

  test("normalizes editor-scoped create defaults", () => {
    const normalized = normalizeConfig({
      defaults: {
        create: {
          launch: true,
        },
        editors: {
          kiro: {
            create: {
              switch: true,
            },
          },
          vscode: {
            create: {
              launch_mode: "sesh",
            },
          },
        },
      },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });

    expect(normalized.defaults?.create?.launch).toBe(true);
    expect(normalized.defaults?.editors?.vscode?.create?.launchMode).toBe("sesh");
    expect(normalized.defaults?.editors?.vscode?.create?.launch).toBe(true);
    expect(normalized.defaults?.editors?.kiro?.create?.switch).toBe(true);
  });

  test("ignores malformed defaults and preserves baseline behavior", () => {
    const normalized = normalizeConfig({
      defaults: {
        create: "invalid",
        switch: {
          launchMode: "unknown",
        },
      },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });

    expect(normalized.defaults).toBeUndefined();
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
    const config: unknown = {
      repos: {},
      reposDir: "./repos",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("version");
  });

  test("catches missing reposDir field", () => {
    const config: unknown = {
      repos: {},
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("reposDir");
  });

  test("catches missing repos field", () => {
    const config: unknown = {
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("repos");
  });

  test("catches invalid field types", () => {
    const config: unknown = {
      repos: [], // Should be object
      reposDir: "./repos",
      version: 1, // Should be string
    };

    try {
      normalizeConfig(config);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.context.errors).toContain("version: must be a non-empty string");
      expect(err.context.errors).toContain("repos: must be an object");
    }
  });

  test("catches empty string values", () => {
    const config = {
      repos: {},
      reposDir: "",
      version: "", // Empty string not allowed
    };

    try {
      normalizeConfig(config);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.context.errors.length).toBeGreaterThan(0);
    }
  });

  test("rejects unsupported config version", () => {
    const config = {
      repos: {},
      reposDir: "./repos",
      version: "2.0.0",
    };

    expect(() => validateConfig(config)).toThrow(UnsupportedConfigVersionError);
    expect(() => validateConfig(config)).toThrow("Unsupported configuration version");
  });

  test("normalizes supported version alias", () => {
    const normalized = normalizeConfig({
      repos: {},
      reposDir: "./repos",
      version: "1",
    });

    expect(normalized.version).toBe("1.0.0");
  });

  test("applies default worktreesDir when omitted", () => {
    const normalized = normalizeConfig({
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });

    expect(normalized.worktreesDir).toBe(DEFAULT_WORKTREES_DIR);
  });

  test("normalizes supported worktreesDir path variants", () => {
    const dotVariant = normalizeConfig({
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreesDir: "./",
    });
    expect(dotVariant.worktreesDir).toBe(".");

    const managedVariant = normalizeConfig({
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreesDir: ".arashi/worktrees/",
    });
    expect(managedVariant.worktreesDir).toBe(DEFAULT_WORKTREES_DIR);
  });

  test("rejects absolute worktreesDir paths", () => {
    const config = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreesDir: "/tmp/worktrees",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("worktreesDir");
  });

  test("rejects unknown root fields", () => {
    const config = {
      custom_metadata: { team: "backend" },
      future_feature: "some value",
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("unknown property");
  });
});

describe("validateConfig - RepoConfig validation", () => {
  test("accepts valid repository configuration", () => {
    const config = {
      repos: {
        "my-repo": {
          defaultBranch: "main",
          isBare: false,
          path: "./repos/my-repo",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts repository with minimal fields", () => {
    const config = {
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts repository gitUrl when present", () => {
    const config = {
      repos: {
        "my-repo": {
          gitUrl: "git@github.com:team/my-repo.git",
          path: "./repos/my-repo",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("catches invalid gitUrl type", () => {
    const config = {
      repos: {
        "my-repo": {
          gitUrl: 123,
          path: "./repos/my-repo",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("gitUrl");
  });

  test("catches missing path field in repository", () => {
    const config = {
      repos: {
        "my-repo": {
          defaultBranch: "main",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("my-repo");
    expect(() => validateConfig(config)).toThrow("path");
  });

  test("accepts deprecated repository metadata keys during migration", () => {
    const config = {
      repos: {
        "my-repo": {
          defaultBranch: "main",
          isBare: false,
          path: "./repos/my-repo",
          worktrees: [],
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("drops deprecated repository metadata keys during normalization", () => {
    const normalized = normalizeConfig({
      repos: {
        "my-repo": {
          defaultBranch: "main",
          isBare: false,
          path: "./repos/my-repo",
          worktrees: [],
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    });

    expect(normalized.repos["my-repo"]).toEqual({
      path: "./repos/my-repo",
    });
  });

  test("catches unknown repository properties", () => {
    const config = {
      repos: {
        "my-repo": {
          customField: true,
          path: "./repos/my-repo",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("unknown property");
  });
});

describe("validateConfig - error messages", () => {
  test("provides multiple errors in single validation", () => {
    const config = {
      repos: {
        "bad-repo": {
          // Missing path
          customField: true, // Unknown property
        },
      },
      reposDir: "./repos",
      version: "", // Invalid
    };

    try {
      normalizeConfig(config);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.context.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("error message includes helpful context", () => {
    const config = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };
    delete (config as { version?: string }).version;

    try {
      normalizeConfig(config);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const err = error as ConfigValidationError;
      expect(err.message).toContain("Configuration validation failed");
      expect(err.message).toContain("version");
    }
  });
});
