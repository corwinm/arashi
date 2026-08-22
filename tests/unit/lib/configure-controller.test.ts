import { describe, expect, test, vi } from "vitest";
import type { Config } from "../../../src/lib/config.ts";
import type { RepositoryActivePathObserver } from "../../../src/lib/repository-config-editor.ts";
import {
  buildConfigurationPreview,
  collectConfigurationEdits,
  type ConfigurePrompts,
} from "../../../src/lib/configure-controller.ts";
import {
  createConfigurationSession,
  planWorkspaceHookFile,
} from "../../../src/lib/workspace-config-editor.ts";

const baseConfig = (): Config => ({
  hooks: { scripts: { "post-remove": "printf BODY_CANARY" } },
  repos: { app: { path: "repos/app" } },
  reposDir: "repos",
  version: "1.0.0",
});

const scriptedPrompts = (answers: unknown[]) => {
  const messages: string[] = [];
  const selections: Array<{ message: string; choices: string[] }> = [];
  const next = async <T>(message: string) => {
    messages.push(message);
    if (answers.length === 0)
      return { reason: "exit" as const, status: "cancelled" as const } as never;
    return { status: "ok" as const, value: answers.shift() as T };
  };
  const prompts: ConfigurePrompts = {
    confirm: next,
    input: next,
    select: async <T>(message: string, choices: Array<{ name: string; value: T }>) => {
      selections.push({ message, choices: choices.map(({ name }) => name) });
      return next<T>(message);
    },
    showDiagnostic: (message) => messages.push(message),
  };
  return { messages, prompts, selections };
};
const existingActiveObserver: RepositoryActivePathObserver = async (request) =>
  request.lifecycles.map(({ lifecycle }) => ({ destinationExists: true, lifecycle }));
const existingNativeObserver: RepositoryActivePathObserver = async (request) =>
  request.lifecycles.map(({ lifecycle }) => ({ lifecycle, nativeCandidateCount: 1 }));

describe("configure controller", () => {
  test("exits before preview confirmation when serialized bytes and plans are unchanged", async () => {
    const original = JSON.stringify(baseConfig());
    const { messages, prompts } = scriptedPrompts([
      "workspace-settings",
      "reposDir",
      "keep",
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      originalSerialized: original,
      prompts,
    });
    expect(result).toEqual({ status: "no-changes" });
    expect(messages).not.toContain(expect.stringContaining("Apply this workspace configuration?"));
  });

  test("accepts runtime-valid zero sync timeout and retries the owning prompt on invalid values", async () => {
    const { messages, prompts } = scriptedPrompts([
      "workspace-settings",
      "sync.timeoutSeconds",
      "edit",
      "-1",
      "0",
      false,
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      prompts,
    });
    expect(result.status).toBe("declined");
    expect(messages.filter((message) => message.includes("sync.timeoutSeconds"))).toHaveLength(3);
    expect(messages.some((message) => /non-negative/i.test(message))).toBe(true);
  });

  test("retains raw persisted alias presence in interactive setting labels", async () => {
    const configuration = baseConfig();
    configuration.reposDir = "legacy-repos";
    const { prompts, selections } = scriptedPrompts([
      "workspace-settings",
      "reposDir",
      "keep",
      false,
    ]);
    await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: configuration,
      persisted: {
        version: "1",
        repos_dir: "legacy-repos",
        repos: { app: { path: "repos/app" } },
      },
      prompts,
    });
    const settings = selections.find(({ message }) => message.includes("workspace-settings"));
    expect(settings?.choices).toContain('reposDir — Configured; value "legacy-repos"');
  });

  test("reuses one-path-at-a-time repository entry with unselected escaped discovery", async () => {
    const discover = vi.fn(async () => ({
      candidates: [{ kind: "file" as const, path: ".env\u007f", selected: false as const }],
      inspectedEntries: 1,
    }));
    const { messages, prompts } = scriptedPrompts([
      "repository",
      "app",
      "copy",
      "edit",
      ".env",
      true,
      ".cache",
      false,
      false,
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      discoverRepositoryCandidates: discover,
      prompts,
    });
    expect(result.status).toBe("declined");
    expect(discover).toHaveBeenCalledOnce();
    expect(messages.filter((message) => message.startsWith("Enter one copy path"))).toHaveLength(2);
    expect(messages.join("\n")).toContain(".env\\u007f");
    expect(messages.join("\n")).not.toContain("comma-separated repository-relative");
  });

  test("offers both Bash shorthand and interpreter-map repository hook editing", async () => {
    const { prompts, selections } = scriptedPrompts([
      "repository",
      "app",
      "pre-create",
      "edit",
      "inline-map",
      "echo bash",
      "Write-Host pwsh",
      "",
      false,
      false,
    ]);
    await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      prompts,
    });
    expect(
      selections.find(({ message }) => message === "Choose source for pre-create:")?.choices,
    ).toEqual(expect.arrayContaining(["Inline Bash command", "Inline interpreter map"]));
  });

  test("preserves plans accumulated across edits to different repositories", async () => {
    const configuration = baseConfig();
    configuration.repos.api = { path: "repos/api" };
    const { messages, prompts } = scriptedPrompts([
      "repository",
      "app",
      "pre-remove",
      "edit",
      "file",
      true,
      "repository",
      "api",
      "post-remove",
      "edit",
      "file",
      false,
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: configuration,
      prompts,
    });
    expect(result.status).toBe("declined");
    // The final preview is declined, but both plans must survive until that preview.
    const preview = messages.at(-1);
    expect(preview).toContain("repos/app/.arashi/hooks/pre-remove.sh");
    expect(preview).toContain("repos/api/.arashi/hooks/post-remove.sh");
  });

  test("preserves multiple plans across repeated edits to one repository", async () => {
    const { messages, prompts } = scriptedPrompts([
      "repository",
      "app",
      "pre-remove",
      "edit",
      "file",
      true,
      "repository",
      "app",
      "post-remove",
      "edit",
      "file",
      false,
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      prompts,
    });
    expect(result.status).toBe("declined");
    expect(messages.at(-1)).toContain("pre-remove.sh");
    expect(messages.at(-1)).toContain("post-remove.sh");
  });

  test("offers keep/skip for an observed existing native hook and creates no plan", async () => {
    const { messages, prompts, selections } = scriptedPrompts([
      "repository",
      "app",
      "pre-create",
      "keep-existing",
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      observeRepositoryActivePaths: () => existingNativeObserver,
      prompts,
    });
    expect(result).toEqual({ status: "no-changes" });
    expect(messages.some((message) => /keep existing|skip/i.test(message))).toBe(true);
    expect(messages.join("\n")).not.toContain("Active files to create");
    const actions = selections.find(({ message }) => message.includes("hooks.pre-create"));
    expect(actions?.choices).toEqual(["Keep existing active hook / skip"]);
    expect(actions?.choices.join("\n")).not.toMatch(/clear|edit|replace/i);
  });

  test("keeps an observed existing workspace hook without clearing or planning it", async () => {
    const { messages, prompts } = scriptedPrompts([
      "workspace-hooks",
      "hooks.scripts.pre-create",
      "keep-existing",
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      observeWorkspaceActivePaths: existingActiveObserver,
      prompts,
    });
    expect(result).toEqual({ status: "no-changes" });
    expect(messages.some((message) => /keep existing|skip/i.test(message))).toBe(true);
  });

  test("resolves repository remove hooks from the active linked execution tree", async () => {
    const { messages, prompts } = scriptedPrompts([
      "repository",
      "app",
      "pre-remove",
      "edit",
      "file",
      false,
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/bare/config-root",
      executionRoot: "/linked/feature",
      config: baseConfig(),
      prompts,
    });
    expect(result.status).toBe("declined");
    expect(messages.at(-1)).toContain("/linked/feature/repos/app/.arashi/hooks/pre-remove.sh");
  });
  test("retries an invalid repository branch at the owning value prompt", async () => {
    const { messages, prompts } = scriptedPrompts([
      "repository",
      "app",
      "baseBranch",
      "edit",
      "bad branch",
      "feature/valid",
      false,
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      prompts,
    });
    expect(result.status).toBe("declined");
    expect(messages.filter((message) => message === "Enter base branch:")).toHaveLength(2);
    expect(messages.filter((message) => message === "Choose configured repository:")).toHaveLength(
      1,
    );
  });

  test("retries empty workspace inline input at the lifecycle source prompt", async () => {
    const { messages, prompts } = scriptedPrompts([
      "workspace-hooks",
      "hooks.scripts.pre-create",
      "edit",
      "inline-bash",
      "",
      "inline-bash",
      "echo valid",
      false,
      false,
    ]);
    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      prompts,
    });
    expect(result.status).toBe("declined");
    expect(messages.filter((message) => message === "Choose configuration scope:")).toHaveLength(1);
    expect(messages.filter((message) => message === "Choose source for pre-create:")).toHaveLength(
      2,
    );
  });

  test("repository setting labels include safe configured values", async () => {
    const configuration = baseConfig();
    configuration.repos.app.groups = ["frontend"];
    configuration.repos.app.baseBranch = "release";
    configuration.repos.app.copy = [".env"];
    configuration.repos.app.symlink = ["node_modules"];
    const { prompts, selections } = scriptedPrompts(["repository", "app", "groups", "keep", false]);
    await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: configuration,
      prompts,
    });
    const settings = selections.find(({ message }) =>
      message.startsWith("Choose setting in repos.app"),
    );
    expect(settings?.choices.join("\n")).toContain('["frontend"]');
    expect(settings?.choices.join("\n")).toContain('"release"');
    expect(settings?.choices.join("\n")).toContain('[".env"]');
    expect(settings?.choices.join("\n")).toContain('["node_modules"]');
  });
  test("keeps ordinary views body-free but shows exact serialized bytes at final confirmation", async () => {
    const command = "printf NEW_VISIBLE_BODY";
    const { messages, prompts } = scriptedPrompts([
      "workspace-hooks",
      "hooks.scripts.pre-create",
      "edit",
      "inline-bash",
      command,
      false,
      true,
    ]);

    const result = await collectConfigurationEdits({
      activeConfigRoot: "/workspace",
      config: baseConfig(),
      prompts,
    });

    expect(result.status).toBe("confirmed");
    if (result.status !== "confirmed") return;
    expect(result.serialized).toContain(`"pre-create": "${command}"`);
    expect(messages.filter((message) => message.includes(command))).toHaveLength(1);
    expect(messages.at(-1)).toContain(result.serialized);
    expect(messages.slice(0, -1).join("\n")).not.toContain("BODY_CANARY");
  });

  test("renders active files separately without scaffold contents", () => {
    const session = planWorkspaceHookFile(createConfigurationSession(baseConfig()), "pre-create", {
      activeConfigRoot: "/workspace",
      platform: "linux",
    });
    const preview = buildConfigurationPreview(session);
    expect(preview.serialized).not.toContain("safe-no-op");
    expect(preview.message).toContain(preview.serialized);
    expect(preview.message).toContain(
      "pre-create: /workspace/.arashi/hooks/pre-create.sh (active safe no-op; runtime-ready)",
    );
    expect(preview.message).not.toContain("#!/usr/bin/env bash");
    expect(preview.message).not.toContain("exit 0");
  });

  test("cancels without producing a mutating result", async () => {
    const prompts: ConfigurePrompts = {
      confirm: async () => ({ reason: "exit", status: "cancelled" }),
      input: async () => ({ reason: "exit", status: "cancelled" }),
      select: async () => ({ reason: "exit", status: "cancelled" }),
      showDiagnostic: () => {},
    };
    await expect(
      collectConfigurationEdits({ activeConfigRoot: "/workspace", config: baseConfig(), prompts }),
    ).resolves.toEqual({ reason: "exit", status: "cancelled" });
  });
});
