import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { tmpdir } from "os";
import { CURRENT_CONFIG_VERSION, type Config } from "../../src/lib/config.ts";
import {
  getUserConfigPath,
  loadUserConfig,
  normalizeUserConfig,
  resolveEffectivePersonalConfig,
} from "../../src/lib/user-config.ts";

const roots: string[] = [];
const workspace = (overrides: Partial<Config> = {}): Config => ({
  repos: {},
  reposDir: "./repos",
  version: CURRENT_CONFIG_VERSION,
  worktreesDir: ".arashi/worktrees",
  ...overrides,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("user configuration", () => {
  test("accepts a partial personal scope but requires version metadata", () => {
    expect(
      normalizeUserConfig({
        version: CURRENT_CONFIG_VERSION,
        defaults: { create: { launch: "none", switch: false } },
      }),
    ).toMatchObject({ defaults: { create: { launch: "none", switch: false } } });
    expect(() => normalizeUserConfig({ defaults: { create: { switch: true } } })).toThrow(
      'version: must be "1.0.0"',
    );
    expect(() => normalizeUserConfig({ version: CURRENT_CONFIG_VERSION, repos: {} })).toThrow(
      "repos: unknown property",
    );
  });

  test("names malformed and invalid user files with field diagnostics", async () => {
    const home = await mkdtemp(join(tmpdir(), "arashi-user-config-"));
    roots.push(home);
    const path = getUserConfigPath({ HOME: home });
    await mkdir(join(home, ".arashi"));
    await writeFile(
      path,
      JSON.stringify({ version: CURRENT_CONFIG_VERSION, worktreeNaming: { style: "wat" } }),
    );
    await expect(loadUserConfig({ HOME: home })).rejects.toThrow(
      `User configuration validation failed at ${path}`,
    );
    await writeFile(path, "{");
    await expect(loadUserConfig({ HOME: home })).rejects.toThrow(path);
  });

  test("merges nested fields independently and preserves explicit disabling values", async () => {
    const home = await mkdtemp(join(tmpdir(), "arashi-user-config-"));
    roots.push(home);
    await mkdir(join(home, ".arashi"));
    await writeFile(
      getUserConfigPath({ HOME: home }),
      JSON.stringify({
        version: CURRENT_CONFIG_VERSION,
        defaults: {
          create: { launch: "sesh", switch: true },
          editors: { vscode: { create: { launch: "auto", switch: true } } },
          switch: { mode: "cd" },
        },
        worktreeNaming: { branchSlashes: "flatten", style: "repo-branch" },
        worktreesDir: ".personal-trees",
      }),
    );
    const root = join(home, "workspace");
    const effective = await resolveEffectivePersonalConfig({
      builtInWorktreesDir: ".arashi/worktrees",
      env: { HOME: home },
      mainRoot: root,
      workspaceConfig: workspace({
        defaults: {
          create: { launch: "none", switch: false },
          editors: { vscode: { create: { switch: false } } },
        },
        worktreeNaming: { style: "branch" },
      }),
      workspaceConfigPath: join(root, ".arashi", "config.json"),
      workspaceWorktreesDirAuthored: false,
    });
    expect(effective.config.defaults).toMatchObject({
      create: { launch: "none", switch: false },
      editors: { vscode: { create: { launch: "auto", switch: false } } },
      switch: { mode: "cd" },
    });
    expect(effective.config.worktreeNaming).toEqual({
      branchSlashes: "flatten",
      style: "branch",
    });
    expect(effective.worktreesBase).toBe(join(root, ".personal-trees"));
    expect(effective.sources).toMatchObject({
      "defaults.create.launch": "workspace",
      "defaults.create.switch": "workspace",
      "defaults.editors.vscode.create.launch": "user",
      "defaults.editors.vscode.create.switch": "workspace",
      "defaults.switch.mode": "user",
      worktreesDir: "user",
    });
  });

  test("qualifies absolute shared roots per repository with a stable collision suffix", async () => {
    const home = await mkdtemp(join(tmpdir(), "arashi-user-config-"));
    roots.push(home);
    const shared = join(home, "shared");
    await mkdir(join(home, ".arashi"));
    await writeFile(
      getUserConfigPath({ HOME: home }),
      JSON.stringify({ version: CURRENT_CONFIG_VERSION, worktreesDir: shared }),
    );
    const resolveFor = (mainRoot: string) =>
      resolveEffectivePersonalConfig({
        builtInWorktreesDir: ".worktrees",
        env: { HOME: home },
        mainRoot,
        workspaceConfig: workspace({ worktreesDir: ".worktrees" }),
        workspaceWorktreesDirAuthored: false,
      });
    const first = await resolveFor(join(home, "one", "app"));
    const repeated = await resolveFor(join(home, "one", "app"));
    const second = await resolveFor(join(home, "two", "app"));
    expect(first.worktreesBase).toBe(repeated.worktreesBase);
    expect(first.worktreesBase).not.toBe(second.worktreesBase);
    expect(dirname(first.worktreesBase)).toBe(shared);
    expect(basename(first.worktreesBase)).toMatch(/^app-[a-f0-9]{8}$/);
  });
});
