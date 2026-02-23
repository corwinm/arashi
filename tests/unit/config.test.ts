/**
 * Unit Tests for Configuration Management
 *
 * Tests pure functions and validation logic without file system operations.
 */

import { describe, test, expect } from "bun:test";
import {
  getConfigPath,
  generateDefaultConfig,
  normalizeConfig,
  validateConfig,
  ConfigValidationError,
  UnsupportedConfigVersionError,
} from "../../src/lib/config";
import { join } from "path";
import { DEFAULT_WORKTREES_DIR } from "../../src/lib/worktree-location";

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
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "example-repo": {
          path: "./repos/example-repo",
          defaultBranch: "main",
          isBare: false,
        },
      },
    };

    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  test("accepts minimal valid configuration", () => {
    const minimalConfig = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {},
    };

    expect(() => validateConfig(minimalConfig)).not.toThrow();
  });

  test("accepts command-scoped defaults configuration", () => {
    const configWithDefaults = {
      version: "1.0.0",
      reposDir: "./repos",
      defaults: {
        create: {
          switch: true,
          launch: true,
          launchMode: "sesh",
        },
        switch: {
          launchMode: "sesh",
        },
      },
      repos: {},
    };

    expect(() => validateConfig(configWithDefaults)).not.toThrow();
  });

  test("normalizes snake_case launch mode aliases", () => {
    const normalized = normalizeConfig({
      version: "1.0.0",
      reposDir: "./repos",
      defaults: {
        create: {
          switch: true,
          launch_mode: "sesh",
        },
        switch: {
          launch_mode: "auto",
        },
      },
      repos: {},
    });

    expect(normalized.defaults?.create?.launchMode).toBe("sesh");
    expect(normalized.defaults?.create?.launch).toBe(true);
    expect(normalized.defaults?.switch?.launchMode).toBe("auto");
  });

  test("ignores malformed defaults and preserves baseline behavior", () => {
    const normalized = normalizeConfig({
      version: "1.0.0",
      reposDir: "./repos",
      defaults: {
        create: "invalid",
        switch: {
          launchMode: "unknown",
        },
      },
      repos: {},
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
    const config = {
      reposDir: "./repos",
      repos: {},
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("version");
  });

  test("catches missing reposDir field", () => {
    const config = {
      version: "1.0.0",
      repos: {},
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("reposDir");
  });

  test("catches missing repos field", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("repos");
  });

  test("catches invalid field types", () => {
    const config = {
      version: 1.0, // Should be string
      reposDir: "./repos",
      repos: [], // Should be object
    };

    try {
      validateConfig(config);
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
      version: "", // Empty string not allowed
      reposDir: "",
      repos: {},
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

  test("rejects unsupported config version", () => {
    const config = {
      version: "2.0.0",
      reposDir: "./repos",
      repos: {},
    };

    expect(() => validateConfig(config)).toThrow(UnsupportedConfigVersionError);
    expect(() => validateConfig(config)).toThrow("Unsupported configuration version");
  });

  test("normalizes supported version alias", () => {
    const normalized = normalizeConfig({
      version: "1",
      reposDir: "./repos",
      repos: {},
    });

    expect(normalized.version).toBe("1.0.0");
  });

  test("applies default worktreesDir when omitted", () => {
    const normalized = normalizeConfig({
      version: "1.0.0",
      reposDir: "./repos",
      repos: {},
    });

    expect(normalized.worktreesDir).toBe(DEFAULT_WORKTREES_DIR);
  });

  test("normalizes supported worktreesDir path variants", () => {
    const dotVariant = normalizeConfig({
      version: "1.0.0",
      reposDir: "./repos",
      worktreesDir: "./",
      repos: {},
    });
    expect(dotVariant.worktreesDir).toBe(".");

    const managedVariant = normalizeConfig({
      version: "1.0.0",
      reposDir: "./repos",
      worktreesDir: ".arashi/worktrees/",
      repos: {},
    });
    expect(managedVariant.worktreesDir).toBe(DEFAULT_WORKTREES_DIR);
  });

  test("rejects absolute worktreesDir paths", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      worktreesDir: "/tmp/worktrees",
      repos: {},
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("worktreesDir");
  });

  test("rejects unknown root fields", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {},
      future_feature: "some value",
      custom_metadata: { team: "backend" },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("unknown property");
  });
});

describe("validateConfig - RepoConfig validation", () => {
  test("accepts valid repository configuration", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
          defaultBranch: "main",
          isBare: false,
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts repository with minimal fields", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts repository gitUrl when present", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
          gitUrl: "git@github.com:team/my-repo.git",
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("catches invalid gitUrl type", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
          gitUrl: 123,
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("gitUrl");
  });

  test("catches missing path field in repository", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          defaultBranch: "main",
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("my-repo");
    expect(() => validateConfig(config)).toThrow("path");
  });

  test("accepts deprecated repository metadata keys during migration", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
          defaultBranch: "main",
          isBare: false,
          worktrees: [],
        },
      },
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  test("drops deprecated repository metadata keys during normalization", () => {
    const normalized = normalizeConfig({
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
          defaultBranch: "main",
          isBare: false,
          worktrees: [],
        },
      },
    });

    expect(normalized.repos["my-repo"]).toEqual({
      path: "./repos/my-repo",
    });
  });

  test("catches unknown repository properties", () => {
    const config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "my-repo": {
          path: "./repos/my-repo",
          customField: true,
        },
      },
    };

    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow("unknown property");
  });
});

describe("validateConfig - error messages", () => {
  test("provides multiple errors in single validation", () => {
    const config = {
      version: "", // Invalid
      reposDir: "./repos",
      repos: {
        "bad-repo": {
          // Missing path
          customField: true, // Unknown property
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
      reposDir: "./repos",
      repos: {},
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
