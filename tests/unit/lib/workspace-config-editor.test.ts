import { describe, expect, test } from "vitest";
import { serializeConfig, type Config } from "../../../src/lib/config.ts";
import { DEFAULT_LIFECYCLE_HOOK_TIMEOUT } from "../../../src/lib/hooks.ts";
import {
  CONFIGURE_SCOPE_DESCRIPTORS,
  applyConfigurationAction,
  createConfigurationSession,
  inspectConfiguration,
  planWorkspaceHookFile,
  setWorkspaceInlineHook,
} from "../../../src/lib/workspace-config-editor.ts";

const config = (): Config => ({
  $schema: "https://example.test/schema.json",
  baseBranch: "main",
  defaults: { create: { switch: true } },
  repos: {
    app: {
      gitUrl: "ssh://example.test/app",
      groups: ["existing"],
      path: "repos/app",
    },
  },
  reposDir: "repos",
  sync: { timeoutSeconds: 45 },
  version: "1.0.0",
});

describe("workspace configuration editor", () => {
  test("publishes exactly the approved finite scope and descriptor set", () => {
    expect(
      CONFIGURE_SCOPE_DESCRIPTORS.map(({ id, canonicalPath, scope }) => ({
        canonicalPath,
        id,
        scope,
      })),
    ).toEqual([
      { canonicalPath: "reposDir", id: "reposDir", scope: "workspace-settings" },
      { canonicalPath: "worktreesDir", id: "worktreesDir", scope: "workspace-settings" },
      { canonicalPath: "baseBranch", id: "baseBranch", scope: "workspace-settings" },
      {
        canonicalPath: "sync.timeoutSeconds",
        id: "sync.timeoutSeconds",
        scope: "workspace-settings",
      },
      { canonicalPath: "hooks.timeout", id: "hooks.timeout", scope: "workspace-hooks" },
      ...(["pre-create", "post-create", "pre-remove", "post-remove"] as const).map((lifecycle) => ({
        canonicalPath: `hooks.scripts.${lifecycle}`,
        id: `hooks.scripts.${lifecycle}`,
        scope: "workspace-hooks",
      })),
      {
        canonicalPath: "defaults.create.switch",
        id: "defaults.create.switch",
        scope: "command-defaults",
      },
      {
        canonicalPath: "defaults.create.launch",
        id: "defaults.create.launch",
        scope: "command-defaults",
      },
      {
        canonicalPath: "defaults.switch.mode",
        id: "defaults.switch.mode",
        scope: "command-defaults",
      },
      ...(["vscode", "cursor", "kiro"] as const).flatMap((editor) =>
        (["switch", "launch"] as const).map((field) => ({
          canonicalPath: `defaults.editors.${editor}.create.${field}`,
          id: `defaults.editors.${editor}.create.${field}`,
          scope: "editor-defaults",
        })),
      ),
      { canonicalPath: "meta.baseBranch", id: "meta.baseBranch", scope: "meta-policy" },
    ]);
    expect(CONFIGURE_SCOPE_DESCRIPTORS.map(({ canonicalPath }) => canonicalPath)).not.toContain(
      "$schema",
    );
  });

  test("keeps configured state separate from inherited and built-in effective state", () => {
    const inspection = inspectConfiguration(config(), "app");
    const byPath = new Map(inspection.settings.map((setting) => [setting.canonicalPath, setting]));

    expect(byPath.get("baseBranch")).toMatchObject({
      configured: true,
      configuredValue: "main",
    });
    expect(byPath.get("hooks.timeout")).toMatchObject({
      configured: false,
      effective: { source: "built-in", value: DEFAULT_LIFECYCLE_HOOK_TIMEOUT },
    });
    expect(byPath.get("defaults.create.launch")).toMatchObject({
      configured: false,
      effective: { source: "built-in", value: "none" },
    });
    expect(byPath.get("defaults.switch.mode")).toMatchObject({
      configured: false,
      effective: { source: "built-in", value: "launch" },
    });
    expect(byPath.get("meta.baseBranch")).toMatchObject({
      configured: false,
      effective: { source: "inherited", value: "main" },
    });
    expect(
      inspection.repositories[0]?.settings.find(({ id }) => id === "baseBranch"),
    ).toMatchObject({
      configured: false,
      effective: { source: "inherited", value: "main" },
    });
  });

  test("uses persisted field presence rather than normalized fallback values", () => {
    const normalized = config();
    normalized.worktreesDir = ".arashi/worktrees";
    const inspection = inspectConfiguration(normalized, undefined, {
      baseBranch: "main",
      repos: normalized.repos,
      reposDir: "repos",
      version: "1.0.0",
    });
    expect(inspection.settings.find(({ id }) => id === "worktreesDir")).toMatchObject({
      configured: false,
      effective: { source: "built-in", value: ".arashi/worktrees" },
    });
  });

  test("recognizes persisted aliases and projects their canonical effective values", () => {
    const normalized = config();
    normalized.reposDir = "legacy-repos";
    normalized.worktreesDir = "legacy-worktrees";
    normalized.sync = { timeoutSeconds: 19 };
    normalized.defaults = {
      create: { launch: "sesh", switch: true },
      switch: { mode: "herdr" },
    };
    const inspection = inspectConfiguration(normalized, undefined, {
      version: "1",
      repos_dir: "legacy-repos",
      worktrees_dir: "legacy-worktrees",
      repos: normalized.repos,
      sync: { timeout_seconds: 19 },
      defaults: {
        create: { launch_mode: "sesh", switch: true },
        switch: { launchMode: "herdr" },
      },
    });
    const byId = new Map(inspection.settings.map((setting) => [setting.id, setting]));
    expect(byId.get("reposDir")).toMatchObject({
      configured: true,
      configuredValue: "legacy-repos",
      persistedPath: "repos_dir",
    });
    expect(byId.get("worktreesDir")).toMatchObject({
      configured: true,
      configuredValue: "legacy-worktrees",
      persistedPath: "worktrees_dir",
    });
    expect(byId.get("sync.timeoutSeconds")).toMatchObject({
      configured: true,
      configuredValue: 19,
      persistedPath: "sync.timeout_seconds",
    });
    expect(byId.get("defaults.create.launch")).toMatchObject({
      configured: true,
      configuredValue: "sesh",
      persistedPath: "defaults.create.launch_mode",
    });
    expect(byId.get("defaults.switch.mode")).toMatchObject({
      configured: true,
      configuredValue: "herdr",
      persistedPath: "defaults.switch.launchMode",
    });
  });

  test("includes complete product-owned descriptor metadata in inspection", () => {
    const inspection = inspectConfiguration(config());
    for (const setting of inspection.settings) {
      expect(setting.descriptor).toMatchObject({
        acceptedShape: expect.any(String),
        effectiveResolver: expect.any(String),
        ownership: expect.any(String),
        purpose: expect.any(String),
        safeDisplay: expect.any(String),
        validationAdapter: expect.any(String),
      });
    }
    for (const repository of inspection.repositories) {
      for (const setting of repository.settings) {
        expect(setting.descriptor).toMatchObject({
          acceptedShape: expect.any(String),
          effectiveResolver: expect.any(String),
          ownership: "repository",
          purpose: expect.any(String),
          safeDisplay: expect.any(String),
          validationAdapter: expect.any(String),
        });
      }
    }
  });

  test("matches runtime effective defaults exactly", () => {
    const inspection = inspectConfiguration(config());
    const byPath = new Map(inspection.settings.map((setting) => [setting.canonicalPath, setting]));
    expect(byPath.get("sync.timeoutSeconds")).toMatchObject({
      configured: true,
      configuredValue: 45,
    });
    const withoutSync = config();
    delete withoutSync.sync;
    const defaults = new Map(
      inspectConfiguration(withoutSync).settings.map((setting) => [setting.canonicalPath, setting]),
    );
    expect(defaults.get("sync.timeoutSeconds")).toMatchObject({
      configured: false,
      effective: { source: "built-in", value: 300 },
    });
    expect(defaults.get("defaults.switch.mode")).toMatchObject({
      configured: false,
      effective: { source: "built-in", value: "launch" },
    });
  });

  test("applies explicit immutable keep edit and clear while pruning only empty containers", () => {
    const initial = createConfigurationSession(config());
    const kept = applyConfigurationAction(initial, "sync.timeoutSeconds", { action: "keep" });
    expect(kept).not.toBe(initial);
    expect(kept.candidate.sync?.timeoutSeconds).toBe(45);

    const edited = applyConfigurationAction(kept, "defaults.create.launch", {
      action: "edit",
      value: "sesh",
    });
    expect(initial.candidate.defaults?.create?.launch).toBeUndefined();
    expect(edited.candidate.defaults?.create).toEqual({ launch: "sesh", switch: true });

    const cleared = applyConfigurationAction(edited, "sync.timeoutSeconds", { action: "clear" });
    expect(cleared.candidate.sync).toBeUndefined();
    expect(cleared.candidate.$schema).toBe("https://example.test/schema.json");
    expect(cleared.candidate.repos.app).toMatchObject({
      gitUrl: "ssh://example.test/app",
      groups: ["existing"],
      path: "repos/app",
    });
    expect(() => applyConfigurationAction(initial, "reposDir", { action: "clear" })).toThrow(
      /required.*reposDir|reposDir.*required/i,
    );
  });

  test("does not persist an absent worktreesDir while editing another field", () => {
    const initial = createConfigurationSession(config());
    const edited = applyConfigurationAction(initial, "reposDir", {
      action: "edit",
      value: "children",
    });
    expect(edited.candidate.worktreesDir).toBeUndefined();
    expect(serializeConfig(edited.candidate)).not.toContain("worktreesDir");
  });

  test("normalizes workspace inline hooks and plans exact body-free active files", () => {
    let session = createConfigurationSession(config());
    session = setWorkspaceInlineHook(session, "pre-create", { bash: "echo visible" });
    expect(serializeConfig(session.candidate)).toContain('"pre-create": "echo visible"');
    expect(
      inspectConfiguration(session.candidate).settings.find(
        ({ id }) => id === "hooks.scripts.pre-create",
      )?.configuredValue,
    ).toEqual({
      interpreters: ["bash"],
      lifecycle: "pre-create",
      sourceKind: "inline-config",
    });

    session = planWorkspaceHookFile(session, "pre-create", {
      activeConfigRoot: "/workspace",
      platform: "linux",
    });
    expect(session.candidate.hooks?.scripts?.["pre-create"]).toBeUndefined();
    expect(session.scripts).toEqual([
      expect.objectContaining({
        lifecycle: "pre-create",
        mode: 0o755,
        ownerRoot: "/workspace",
        path: "/workspace/.arashi/hooks/pre-create.sh",
        state: "safe-no-op",
      }),
    ]);
    expect(JSON.stringify(inspectConfiguration(session.candidate))).not.toContain("echo visible");
  });

  test("workspace hook operations preserve repository-owned plans for the same lifecycle", () => {
    const repositoryPlan = {
      extension: ".sh" as const,
      lifecycle: "pre-create" as const,
      mode: 0o755,
      ownerRoot: "/workspace/repos/app",
      path: "/workspace/.arashi/hooks/pre-create.app.sh",
      repositoryName: "app",
      state: "safe-no-op" as const,
    };
    const initial = {
      ...createConfigurationSession(config()),
      scripts: Object.freeze([repositoryPlan]),
    };
    const inline = setWorkspaceInlineHook(initial, "pre-create", "echo workspace");
    expect(inline.scripts).toEqual([repositoryPlan]);
    const planned = planWorkspaceHookFile(initial, "pre-create", {
      activeConfigRoot: "/workspace",
      platform: "linux",
    });
    expect(planned.scripts).toContainEqual(repositoryPlan);
    const cleared = applyConfigurationAction(planned, "hooks.scripts.pre-create", {
      action: "clear",
    });
    expect(cleared.scripts).toEqual([repositoryPlan]);
  });

  test("clearing a lifecycle removes both its inline field and pending active-file plan", () => {
    const planned = planWorkspaceHookFile(createConfigurationSession(config()), "pre-create", {
      activeConfigRoot: "/workspace",
      platform: "linux",
    });
    const cleared = applyConfigurationAction(planned, "hooks.scripts.pre-create", {
      action: "clear",
    });
    expect(cleared.scripts).toEqual([]);
    expect(cleared.candidate.hooks?.scripts?.["pre-create"]).toBeUndefined();
  });
});
