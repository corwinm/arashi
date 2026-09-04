import { describe, expect, test } from "vitest";
import {
  REPOSITORY_CONFIGURE_DESCRIPTORS,
  REPOSITORY_ONBOARDING_DESCRIPTORS,
  clearRepositoryField,
  createExistingRepositoryEditorState,
  createRepositoryEditorState,
  normalizeRepositoryEditorState,
  planRepositoryHookFile,
  setRepositoryInlineHook,
  setRepositoryPaths,
  setRepositoryScalarField,
  summarizeRepositoryEditorState,
  validateRepositoryEditorState,
} from "../../../src/lib/repository-config-editor.ts";
import type { Config } from "../../../src/lib/config.ts";
import { resolveLifecycleHookFilePath } from "../../../src/lib/hooks.ts";

const config = (): Config => ({
  baseBranch: "main",
  defaults: { create: { switch: true } },
  repos: { app: { path: "repos/app", gitUrl: "ssh://example/app", groups: ["kept"] } },
  reposDir: "repos",
  version: "1.0.0",
});

const configForRepository = (repositoryName: string): Config => ({
  ...config(),
  repos: {
    [repositoryName]: {
      gitUrl: "ssh://example/app",
      path: "repos/app",
    },
  },
});

describe("repository configuration editor", () => {
  test("extends the shared editor explicitly for configure without changing add onboarding", () => {
    expect(REPOSITORY_ONBOARDING_DESCRIPTORS.map(({ id }) => id)).toEqual([
      "copy",
      "symlink",
      "pre-create",
      "post-create",
      "pre-remove",
      "post-remove",
    ]);
    expect(REPOSITORY_CONFIGURE_DESCRIPTORS.map(({ id }) => id)).toEqual([
      "groups",
      "baseBranch",
      "copy",
      "symlink",
      "pre-create",
      "post-create",
      "pre-remove",
      "post-remove",
    ]);
    expect(
      REPOSITORY_CONFIGURE_DESCRIPTORS.map(({ canonicalPath }) => canonicalPath),
    ).not.toContain("repos.<name>.path");
    expect(
      REPOSITORY_CONFIGURE_DESCRIPTORS.map(({ canonicalPath }) => canonicalPath),
    ).not.toContain("repos.<name>.gitUrl");
  });

  test("publishes complete descriptor metadata and sanitized inline projections", () => {
    for (const descriptor of REPOSITORY_CONFIGURE_DESCRIPTORS) {
      expect(descriptor).toMatchObject({
        acceptedShape: expect.any(String),
        effectiveResolver: expect.any(String),
        ownership: "repository",
        purpose: expect.any(String),
        safeDisplay: expect.any(String),
        validationAdapter: expect.any(String),
      });
    }
    const state = setRepositoryInlineHook(
      createExistingRepositoryEditorState(config(), "app"),
      "pre-create",
      { bash: "secret", powershell: "also secret" },
    );
    expect(summarizeRepositoryEditorState(state).hooks).toContainEqual({
      interpreters: ["bash", "powershell"],
      lifecycle: "pre-create",
      sourceKind: "inline-config",
    });
    expect(JSON.stringify(summarizeRepositoryEditorState(state))).not.toContain("secret");
  });

  test("edits and clears groups and base policy immutably while preserving identity", () => {
    const initial = createExistingRepositoryEditorState(config(), "app");
    const edited = setRepositoryScalarField(initial, "baseBranch", "release");
    const grouped = setRepositoryScalarField(edited, "groups", ["core", "shared"]);
    const cleared = clearRepositoryField(grouped, "baseBranch");

    expect(initial.candidate.repos.app.baseBranch).toBeUndefined();
    expect(cleared.candidate.repos.app).toMatchObject({
      gitUrl: "ssh://example/app",
      groups: ["core", "shared"],
      path: "repos/app",
    });
    expect(cleared.candidate.repos.app.baseBranch).toBeUndefined();
    expect(cleared.fields.find(({ id }) => id === "baseBranch")?.state).toBe("unset");
  });

  test("exposes only explicit repository onboarding descriptors with unset state", () => {
    const state = createRepositoryEditorState(config(), "app");
    expect(
      REPOSITORY_ONBOARDING_DESCRIPTORS.map(({ id, scope, sensitive }) => ({
        id,
        scope,
        sensitive,
      })),
    ).toEqual([
      { id: "copy", scope: "repository", sensitive: false },
      { id: "symlink", scope: "repository", sensitive: false },
      { id: "pre-create", scope: "repository", sensitive: true },
      { id: "post-create", scope: "repository", sensitive: true },
      { id: "pre-remove", scope: "repository", sensitive: true },
      { id: "post-remove", scope: "repository", sensitive: true },
    ]);
    expect(state.fields.every((field) => field.state === "unset")).toBe(true);
    expect(state.fields.map((field) => field.id)).not.toContain("baseBranch");
    expect(REPOSITORY_ONBOARDING_DESCRIPTORS[0]).toMatchObject({
      acceptedShape: "repository-relative-string-array",
      projection: "paths",
      validation: "canonical-config",
    });
    expect(REPOSITORY_ONBOARDING_DESCRIPTORS[2]).toMatchObject({
      acceptedShape: "inline-bash-or-interpreter-map-or-native-file",
      projection: "source-presence",
      validation: "canonical-config-and-active-path",
    });
  });

  test("immutably normalizes paths in declaration order and preserves unrelated fields", () => {
    const initial = createRepositoryEditorState(config(), "app");
    const withCopy = setRepositoryPaths(initial, "copy", [".env", "cache/./local"]);
    const complete = setRepositoryPaths(withCopy, "symlink", ["settings/local.json"]);
    expect(initial.candidate.repos.app.copy).toBeUndefined();
    const normalized = normalizeRepositoryEditorState(complete);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      return;
    }
    expect(normalized.state.candidate.repos.app).toMatchObject({
      copy: [".env", "cache/local"],
      gitUrl: "ssh://example/app",
      groups: ["kept"],
      path: "repos/app",
      symlink: ["settings/local.json"],
    });
    expect(normalized.state.candidate.baseBranch).toBe("main");
  });

  test("attributes canonical portable collisions to the owning field", () => {
    const state = setRepositoryPaths(
      setRepositoryPaths(createRepositoryEditorState(config(), "app"), "copy", ["Data/local"]),
      "symlink",
      ["data/local"],
    );
    const result = normalizeRepositoryEditorState(state);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.diagnostics[0]).toMatchObject({ field: "symlink", retryable: true });
    expect(result.diagnostics[0].message).toMatch(/collision/i);
  });

  test.skipIf(process.platform === "win32")(
    "normalizes inline hooks, omits file-mode config, and never summarizes bodies",
    () => {
      const canary = "printf SECRET_EDITOR_CANARY";
      let state = createRepositoryEditorState(config(), "app");
      state = setRepositoryInlineHook(state, "pre-create", {
        bash: canary,
        powershell: "Write-Output hidden",
      });
      state = planRepositoryHookFile(state, "post-remove", {
        activeConfigRoot: "/workspace",
        activeRepositoryPath: "/workspace/repos/app",
        platform: "darwin",
      });
      const result = normalizeRepositoryEditorState(state);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.state.candidate.repos.app.hooks?.["pre-create"]).toEqual({
        bash: canary,
        powershell: "Write-Output hidden",
      });
      expect(result.state.candidate.repos.app.hooks?.["post-remove"]).toBeUndefined();
      expect(result.state.scripts[0]).toMatchObject({
        lifecycle: "post-remove",
        mode: 0o755,
        path: "/workspace/.arashi/hooks/post-remove.app.sh",
      });
      const summary = JSON.stringify(summarizeRepositoryEditorState(result.state));
      expect(summary).toContain("pre-create");
      expect(summary).toContain("post-remove.app.sh");
      expect(summary).not.toContain(canary);
      expect(summary).not.toContain("Write-Output hidden");
      expect(summary).not.toContain("exit 0");
    },
  );

  test.skipIf(process.platform === "win32").each([
    ["pre-create", "/workspace/.arashi/hooks/pre-create.app.sh"],
    ["post-create", "/workspace/.arashi/hooks/post-create.app.sh"],
    ["pre-remove", "/workspace/.arashi/hooks/pre-remove.app.sh"],
    ["post-remove", "/workspace/.arashi/hooks/post-remove.app.sh"],
  ] as const)("plans exact POSIX active path for %s", (lifecycle, expected) => {
    const state = planRepositoryHookFile(createRepositoryEditorState(config(), "app"), lifecycle, {
      activeConfigRoot: "/workspace",
      activeRepositoryPath: "/workspace/repos/app",
      platform: "linux",
    });
    expect(state.scripts[0]).toMatchObject({
      extension: ".sh",
      lifecycle,
      mode: 0o755,
      path: expected,
    });
    expect(state.scripts[0].path).toBe(
      resolveLifecycleHookFilePath({
        hookName: `${lifecycle}.app`,
        ownerRoot: "/workspace",
        platform: "linux",
      }),
    );
  });

  test.each([
    ["direct-main", "/main", "/main"],
    ["configured-bare", "/configuration", "/clone"],
    ["linked-parent", "/parent", "/parent/.arashi/worktrees/topic/repos/app"],
    ["bare-backed-linked", "/parent.git", "/parent-linked/repos/app"],
  ] as const)(
    "planner equals runtime path resolver in %s topology",
    (_mode, configRoot, repositoryPath) => {
      for (const lifecycle of ["pre-create", "post-create", "pre-remove", "post-remove"] as const) {
        const planned = planRepositoryHookFile(
          createRepositoryEditorState(config(), "app"),
          lifecycle,
          {
            activeConfigRoot: configRoot,
            activeRepositoryPath: repositoryPath,
            platform: "darwin",
          },
        ).scripts[0].path;
        expect(planned).toBe(
          resolveLifecycleHookFilePath({
            hookName: `${lifecycle}.app`,
            ownerRoot: configRoot,
            platform: "darwin",
          }),
        );
      }
    },
  );

  test("plans exactly one runtime-ready PowerShell file on Windows", () => {
    const state = planRepositoryHookFile(
      createRepositoryEditorState(config(), "app"),
      "pre-create",
      {
        activeConfigRoot: "C:\\workspace",
        activeRepositoryPath: "C:\\workspace\\repos\\app",
        platform: "win32",
      },
    );
    expect(state.scripts).toHaveLength(1);
    expect(state.scripts[0].extension).toBe(".ps1");
    expect(state.scripts[0].path.replaceAll("\\", "/")).toMatch(
      /\.arashi\/hooks\/pre-create\.app\.ps1$/,
    );
  });

  test.each([
    ["linux", "."],
    ["linux", ".."],
    ["linux", "../unexpected"],
    ["linux", "nested/repository"],
    ["win32", "."],
    ["win32", ".."],
    ["win32", "..\\unexpected"],
    ["win32", "../unexpected"],
    ["win32", "C:unexpected"],
    ["win32", "C:\\unexpected"],
    ["win32", "\\\\server\\share"],
  ] as const)(
    "rejects unsafe %s repository name segments before planning a create hook",
    (platform, repositoryName) => {
      const plan = () =>
        planRepositoryHookFile(
          createRepositoryEditorState(configForRepository(repositoryName), repositoryName),
          "pre-create",
          {
            activeConfigRoot: platform === "win32" ? "C:\\workspace" : "/workspace",
            activeRepositoryPath:
              platform === "win32" ? "C:\\workspace\\repos\\app" : "/workspace/repos/app",
            platform,
          },
        );
      expect(plan).toThrow("Repository name cannot be used in an active hook filename.");
    },
  );

  test.each([
    ["linux", "team app.v2", "/workspace/.arashi/hooks/pre-create.team app.v2.sh"],
    ["win32", "team app.v2", "C:/workspace/.arashi/hooks/pre-create.team app.v2.ps1"],
  ] as const)(
    "preserves legitimate %s repository hook names",
    (platform, repositoryName, expected) => {
      const planned = planRepositoryHookFile(
        createRepositoryEditorState(configForRepository(repositoryName), repositoryName),
        "pre-create",
        {
          activeConfigRoot: platform === "win32" ? "C:\\workspace" : "/workspace",
          activeRepositoryPath:
            platform === "win32" ? "C:\\workspace\\repos\\app" : "/workspace/repos/app",
          platform,
        },
      );
      expect(planned.scripts[0].path.replaceAll("\\", "/")).toBe(expected);
    },
  );

  test.skipIf(process.platform === "win32")(
    "applies qualified filename validation to repository-owned remove hooks",
    () => {
      const repositoryName = "../../legacy-config-name";
      expect(() =>
        planRepositoryHookFile(
          createRepositoryEditorState(configForRepository(repositoryName), repositoryName),
          "pre-remove",
          {
            activeConfigRoot: "/workspace",
            activeRepositoryPath: "/workspace/repos/app",
            platform: "linux",
          },
        ),
      ).toThrow("Repository name cannot be used in an active hook filename.");
    },
  );

  test.each([
    [{ destinationExists: true }, /destination already exists/i],
    [{ symlinkParent: true }, /symlinked parent/i],
    [{ nativeCandidateCount: 1 }, /ambiguous native/i],
    [{ nativeCandidateCount: 2 }, /ambiguous native/i],
  ] as const)(
    "attributes active-path safety failures to the owning lifecycle",
    async (metadata, expected) => {
      const editor = planRepositoryHookFile(
        createRepositoryEditorState(config(), "app"),
        "pre-create",
        {
          activeConfigRoot: "/workspace",
          activeRepositoryPath: "/workspace/repos/app",
          platform: "linux",
        },
      );
      const result = await validateRepositoryEditorState(editor, async () => [
        { lifecycle: "pre-create", ...metadata },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]).toMatchObject({ field: "pre-create", retryable: true });
      expect(result.diagnostics[0].message).toMatch(expected);
      expect(result.diagnostics[0].message).not.toContain("/workspace");
    },
  );

  test("ignores native-file parent diagnostics for inline-only hooks", async () => {
    const editor = setRepositoryInlineHook(
      createRepositoryEditorState(config(), "app"),
      "pre-create",
      "printf ready",
    );

    const result = await validateRepositoryEditorState(editor, async () => [
      {
        destinationExists: true,
        lifecycle: "pre-create",
        symlinkParent: true,
        unsafeDestination: true,
      },
    ]);

    expect(result.ok).toBe(true);
  });

  test("rejects inline/native ambiguity through the metadata-only validation boundary", async () => {
    const editor = setRepositoryInlineHook(
      createRepositoryEditorState(config(), "app"),
      "post-remove",
      {
        bash: "secret body",
      },
    );
    let observedRequest: unknown;
    const result = await validateRepositoryEditorState(editor, async (request) => {
      observedRequest = request;
      return [{ lifecycle: "post-remove", nativeCandidateCount: 1 }];
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0].field).toBe("post-remove");
    expect(observedRequest).toMatchObject({
      lifecycles: [{ inlineConfigured: true, lifecycle: "post-remove", plannedPath: null }],
      repositoryName: "app",
    });
    expect(JSON.stringify(observedRequest)).not.toContain("secret body");
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret body");
  });
});
