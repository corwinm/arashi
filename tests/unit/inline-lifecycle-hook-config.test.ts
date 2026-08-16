import {
  CURRENT_CONFIG_VERSION,
  ConfigValidationError,
  getConfigPath,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from "../../src/lib/config.ts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { delimiter, join, win32 } from "path";

import { tmpdir } from "os";

const roots: string[] = [];

const makeTempRoot = async (prefix = "arashi-inline-hook-red-"): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const baseConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  repos: {},
  reposDir: "./repos",
  version: "1.0.0",
  ...overrides,
});

const validationErrors = (value: unknown): string[] => {
  try {
    normalizeConfig(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as ConfigValidationError).context.errors;
  }
  throw new Error("Expected inline hook configuration validation to fail");
};

type InlineInterpreterMap = Partial<Record<"bash" | "powershell" | "cmd", string>>;
type InlineInterpreterResolution =
  | { available: true; executablePath: string; interpreter: "bash" | "powershell" | "cmd" }
  | { available: false; reasonCode: "interpreter_unavailable" };
type ResolveInlineHookInterpreter = (options: {
  env: Record<string, string | undefined>;
  interpreters: InlineInterpreterMap;
  isExecutableFile?: (path: string) => Promise<boolean>;
  platform: NodeJS.Platform;
  realpath?: (path: string) => Promise<string>;
}) => Promise<InlineInterpreterResolution>;

const inlineInterpreterResolver = async (): Promise<ResolveInlineHookInterpreter> => {
  const hookRuntime = await import("../../src/lib/hooks.ts");
  const candidate = Reflect.get(hookRuntime, "resolveInlineHookInterpreter");
  expect(
    candidate,
    "src/lib/hooks.ts must export the production inline interpreter resolver",
  ).toBeTypeOf("function");
  return candidate as ResolveInlineHookInterpreter;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("inline lifecycle hook configuration RED contract", () => {
  test("normalizes typed root and repository shorthand/maps while retaining version 1.0.0", () => {
    const normalized = normalizeConfig(
      baseConfig({
        hooks: {
          scripts: {
            "post-remove": {
              bash: "printf root-bash",
              cmd: "echo root-cmd",
              powershell: "Write-Output root-powershell",
            },
            "pre-create": "printf root",
          },
          timeout: 12_345,
        },
        repos: {
          api: {
            gitUrl: "git@example.test:team/api.git",
            groups: ["core"],
            hooks: {
              "post-create": { bash: "printf repository" },
              "pre-remove": "printf repository-remove",
            },
            path: "./repos/api",
          },
        },
      }),
    );

    expect(CURRENT_CONFIG_VERSION).toBe("1.0.0");
    expect(normalized.version).toBe("1.0.0");
    expect(normalized.hooks).toEqual({
      scripts: {
        "post-remove": {
          bash: "printf root-bash",
          cmd: "echo root-cmd",
          powershell: "Write-Output root-powershell",
        },
        "pre-create": { bash: "printf root" },
      },
      timeout: 12_345,
    });
    expect(normalized.repos.api).toEqual({
      gitUrl: "git@example.test:team/api.git",
      groups: ["core"],
      hooks: {
        "post-create": { bash: "printf repository" },
        "pre-remove": { bash: "printf repository-remove" },
      },
      path: "./repos/api",
    });
  });

  test("save/load preserves inline hooks, timeout, repository fields, and unrelated data", async () => {
    const root = await makeTempRoot();
    const config = baseConfig({
      hooks: {
        scripts: {
          "post-remove": { cmd: "echo cleanup", powershell: "Write-Output cleanup" },
          "pre-create": "printf prepare",
        },
        timeout: 9876,
      },
      repos: {
        api: {
          gitUrl: "git@example.test:team/api.git",
          groups: ["core", "service"],
          hooks: { "post-create": { bash: "printf ready" } },
          path: "./custom/api",
        },
      },
      sync: { timeoutSeconds: 42 },
    });

    await saveConfig(root, config as unknown as Parameters<typeof saveConfig>[1]);
    const loaded = await loadConfig(root);

    expect(loaded).toMatchObject({
      hooks: {
        scripts: {
          "post-remove": { cmd: "echo cleanup", powershell: "Write-Output cleanup" },
          "pre-create": { bash: "printf prepare" },
        },
        timeout: 9876,
      },
      repos: {
        api: {
          gitUrl: "git@example.test:team/api.git",
          groups: ["core", "service"],
          hooks: { "post-create": { bash: "printf ready" } },
          path: "./custom/api",
        },
      },
      sync: { timeoutSeconds: 42 },
      version: "1.0.0",
    });
    expect(JSON.parse(await readFile(getConfigPath(root), "utf8"))).toMatchObject(loaded);
  });

  test.each([
    [
      "unknown lifecycle",
      { hooks: { scripts: { deploy: "printf nope" } } },
      "hooks.scripts.deploy",
    ],
    [
      "dynamic repository lifecycle",
      { hooks: { scripts: { "pre-create.api": "printf nope" } } },
      "hooks.scripts.pre-create.api",
    ],
    [
      "empty root snippet",
      { hooks: { scripts: { "pre-create": "" } } },
      "hooks.scripts.pre-create",
    ],
    [
      "whitespace repository snippet",
      { repos: { api: { hooks: { "pre-remove": "   \t" }, path: "./repos/api" } } },
      "repos.api.hooks.pre-remove",
    ],
    ["empty map", { hooks: { scripts: { "post-create": {} } } }, "hooks.scripts.post-create"],
    [
      "unsupported interpreter",
      { hooks: { scripts: { "post-create": { zsh: "printf nope" } } } },
      "hooks.scripts.post-create.zsh",
    ],
    [
      "non-string map member",
      { repos: { api: { hooks: { "post-remove": { bash: 7 } }, path: "./repos/api" } } },
      "repos.api.hooks.post-remove.bash",
    ],
    [
      "array",
      { hooks: { scripts: { "pre-create": ["printf nope"] } } },
      "hooks.scripts.pre-create",
    ],
    ["number", { hooks: { scripts: { "pre-create": 7 } } }, "hooks.scripts.pre-create"],
    ["boolean", { hooks: { scripts: { "pre-create": true } } }, "hooks.scripts.pre-create"],
    ["null", { hooks: { scripts: { "pre-create": null } } }, "hooks.scripts.pre-create"],
  ] as const)("rejects %s at the exact nested config path", (_label, patch, expectedPath) => {
    const config = baseConfig(patch);
    if ("repos" in patch) {
      config.repos = patch.repos;
    }
    const errors = validationErrors(config);

    expect(errors.some((message) => message.includes(expectedPath))).toBe(true);
    expect(errors).not.toContain("hooks.scripts: unknown property");
    expect(errors).not.toContain("repos.api.hooks: unknown property");
  });

  test("repository nesting is the only repository-inline form", () => {
    const nested = normalizeConfig(
      baseConfig({
        repos: {
          api: {
            hooks: { "post-create": "printf nested" },
            path: "./repos/api",
          },
        },
      }),
    );
    expect((nested.repos.api as unknown as Record<string, unknown>).hooks).toEqual({
      "post-create": { bash: "printf nested" },
    });

    for (const dynamicName of [
      "pre-create.api",
      "post-create.api",
      "pre-remove.api",
      "post-remove.api",
    ]) {
      const errors = validationErrors(
        baseConfig({ hooks: { scripts: { [dynamicName]: "printf encoded" } } }),
      );
      expect(errors).toContain(`hooks.scripts.${dynamicName}: unknown property`);
    }
  });

  test("checked schema is fresh and exposes closed root/repository lifecycle and interpreter maps", async () => {
    const schemaPath = join(import.meta.dirname, "..", "..", "schema", "config.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
      definitions: Record<string, Record<string, unknown>>;
    };
    const { createGenerator } = await import("ts-json-schema-generator");
    const generated = createGenerator({
      expose: "export",
      jsDoc: "extended",
      path: join(import.meta.dirname, "..", "..", "src", "lib", "config.ts"),
      skipTypeCheck: false,
      tsconfig: join(import.meta.dirname, "..", "..", "tsconfig.schema.json"),
      type: "Config",
    }).createSchema("Config");
    const serialized = JSON.stringify(schema);

    expect(schema).toEqual(generated);

    expect(CURRENT_CONFIG_VERSION).toBe("1.0.0");
    expect(schema.definitions).toHaveProperty("InlineHookInterpreter");
    expect(schema.definitions).toHaveProperty("InlineHookValue");
    expect(schema.definitions).toHaveProperty("InlineHookScripts");
    expect(schema.definitions.Config).toMatchObject({
      properties: {
        hooks: expect.any(Object),
        repos: expect.any(Object),
        version: { $ref: "#/definitions/ConfigVersion" },
      },
    });
    expect(schema.definitions.ConfigVersion).toMatchObject({ const: "1.0.0" });
    expect(serialized).toContain('"pre-create"');
    expect(serialized).toContain('"post-create"');
    expect(serialized).toContain('"pre-remove"');
    expect(serialized).toContain('"post-remove"');
    expect(serialized).toContain('"additionalProperties":false');
    expect(serialized).not.toContain("pre-create.api");
    expect(serialized).not.toContain("post-create.api");
  });
});

describe("inline interpreter resolver RED contract", () => {
  test("POSIX scans non-empty PATH entries in order and returns the first executable real path", async () => {
    const first = await makeTempRoot("arashi-inline-path-first-");
    const second = await makeTempRoot("arashi-inline-path-second-");
    const firstBash = join(first, "bash");
    const secondBash = join(second, "bash");
    await writeFile(firstBash, "#!/bin/sh\nexit 0\n");
    await writeFile(secondBash, "#!/bin/sh\nexit 0\n");
    await chmod(firstBash, 0o644);
    await chmod(secondBash, 0o755);

    const resolve = await inlineInterpreterResolver();
    const result = await resolve({
      env: { PATH: ["", first, "", second].join(delimiter) },
      interpreters: { bash: "printf bash", cmd: "echo ignored" },
      platform: "linux",
    });

    expect(result).toEqual({
      available: true,
      executablePath: await realpath(secondBash),
      interpreter: "bash",
    });
  });

  test("Windows selects fixed PowerShell then cmd then ordered PATH Bash without pwsh fallback", async () => {
    const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    const cmd = String.raw`C:\Windows\System32\cmd.exe`;
    const bash = String.raw`D:\Git\bin\bash.exe`;
    const available = new Set([powershell, cmd, bash]);
    const probes: string[] = [];
    const isExecutableFile = async (path: string): Promise<boolean> => {
      probes.push(path);
      return available.has(path);
    };
    const normalizeWindowsPath = async (path: string): Promise<string> => win32.normalize(path);

    const resolve = await inlineInterpreterResolver();
    const all = await resolve({
      env: { PATH: String.raw`C:\ignored;;D:\Git\bin`, SystemRoot: String.raw`C:\Windows` },
      interpreters: { bash: "echo bash", cmd: "echo cmd", powershell: "Write-Output ps" },
      isExecutableFile,
      platform: "win32",
      realpath: normalizeWindowsPath,
    });
    expect(all).toEqual({
      available: true,
      executablePath: powershell,
      interpreter: "powershell",
    });

    available.delete(powershell);
    const fallback = await resolve({
      env: { PATH: String.raw`C:\ignored;;D:\Git\bin`, SystemRoot: String.raw`C:\Windows` },
      interpreters: { bash: "echo bash", cmd: "echo cmd", powershell: "Write-Output ps" },
      isExecutableFile,
      platform: "win32",
      realpath: normalizeWindowsPath,
    });
    expect(fallback).toEqual({
      available: true,
      executablePath: cmd,
      interpreter: "cmd",
    });

    available.delete(cmd);
    const bashFallback = await resolve({
      env: { PATH: String.raw`C:\ignored;;D:\Git\bin`, SystemRoot: String.raw`C:\Windows` },
      interpreters: { bash: "echo bash", cmd: "echo cmd", powershell: "Write-Output ps" },
      isExecutableFile,
      platform: "win32",
      realpath: normalizeWindowsPath,
    });
    expect(bashFallback).toEqual({
      available: true,
      executablePath: bash,
      interpreter: "bash",
    });
    expect(probes).toEqual([
      powershell,
      powershell,
      cmd,
      powershell,
      cmd,
      String.raw`C:\ignored\bash.exe`,
      bash,
    ]);
    expect(probes.join("\n")).not.toMatch(/pwsh|wt\.exe|windowsterminal/i);
  });

  test("reports interpreter_unavailable for incompatible or unavailable configured entries", async () => {
    const resolve = await inlineInterpreterResolver();

    await expect(
      resolve({
        env: { PATH: "" },
        interpreters: { powershell: "Write-Output nope" },
        platform: "linux",
      }),
    ).resolves.toEqual({ available: false, reasonCode: "interpreter_unavailable" });
    await expect(
      resolve({
        env: { PATH: "", SystemRoot: "" },
        interpreters: { bash: "echo nope", cmd: "echo nope", powershell: "Write-Output nope" },
        platform: "win32",
      }),
    ).resolves.toEqual({ available: false, reasonCode: "interpreter_unavailable" });
  });

  test.each([String.raw`\Windows`, "/Windows"])(
    "rejects drive-relative SystemRoot %s without probing a fixed interpreter",
    async (systemRoot) => {
      const probes: string[] = [];
      const resolve = await inlineInterpreterResolver();
      const result = await resolve({
        env: { PATH: "", SystemRoot: systemRoot },
        interpreters: { powershell: "Write-Output nope" },
        isExecutableFile: async (path) => {
          probes.push(path);
          return true;
        },
        platform: "win32",
        realpath: async (path) => path,
      });

      expect(result).toEqual({ available: false, reasonCode: "interpreter_unavailable" });
      expect(probes).toEqual([]);
    },
  );
});
