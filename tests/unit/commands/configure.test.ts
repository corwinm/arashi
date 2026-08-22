import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import type { Config } from "../../../src/lib/config.ts";
import {
  executeConfigure,
  inspectConfigureSnapshot,
  loadConfigureSnapshot,
} from "../../../src/commands/configure.ts";

const canary = "printf JSON_BODY_CANARY";
const nativeExtension = process.platform === "win32" ? ".ps1" : ".sh";
const config: Config = {
  hooks: { scripts: { "pre-create": canary } },
  repos: { app: { hooks: { "post-remove": canary }, path: "repos/app" } },
  reposDir: "repos",
  version: "1.0.0",
};

describe("configure command", () => {
  test("passes the exact persisted snapshot into the interactive controller", async () => {
    const persisted = {
      version: "1",
      repos_dir: "repos",
      repos: { app: { path: "repos/app" } },
    };
    const collectEdits = vi.fn(async () => ({ status: "no-changes" as const }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await executeConfigure(
      { stdinIsTTY: true, stdoutIsTTY: true },
      {
        collectEdits,
        loadSnapshot: async () => ({
          bytes: new TextEncoder().encode(JSON.stringify(persisted)),
          config,
          persisted,
          workspaceRoot: "/workspace",
        }),
        transact: vi.fn(),
        writeJson: vi.fn(),
      },
    );
    expect(collectEdits).toHaveBeenCalledWith(expect.objectContaining({ persisted }));
    log.mockRestore();
  });

  test("reports no changes and exits before transaction", async () => {
    const transact = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await executeConfigure(
      { stdinIsTTY: true, stdoutIsTTY: true },
      {
        collectEdits: async () => ({ status: "no-changes" }),
        loadSnapshot: async () => ({
          bytes: new TextEncoder().encode(JSON.stringify(config)),
          config,
          workspaceRoot: "/workspace",
        }),
        transact,
        writeJson: vi.fn(),
      },
    );
    expect(log).toHaveBeenCalledWith("No configuration changes.");
    expect(transact).not.toHaveBeenCalled();
    log.mockRestore();
  });
  test("loads exact bytes and preserves raw field presence without migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-configure-load-"));
    const configPath = join(root, ".arashi", "config.json");
    await mkdir(join(root, ".arashi"));
    const original = '{\n  "version": "1",\n  "reposDir": "repos",\n  "repos": {}\n}\n';
    await writeFile(configPath, original);
    const snapshot = await loadConfigureSnapshot(root);
    expect(new TextDecoder().decode(snapshot.bytes)).toBe(original);
    expect(snapshot.persisted).not.toHaveProperty("worktreesDir");
    expect(snapshot.config.worktreesDir).toBeUndefined();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  test.each([
    ["malformed", "{"],
    ["semantic", '{"version":"1.0.0","reposDir":"","repos":{}}'],
    ["non-object defaults", '{"version":"1.0.0","reposDir":"repos","repos":{},"defaults":false}'],
    [
      "unknown nested defaults field",
      '{"version":"1.0.0","reposDir":"repos","repos":{},"defaults":{"switch":{"mode":"launch","extra":true}}}',
    ],
  ])("rejects %s config without rewriting it", async (_kind, original) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-configure-invalid-"));
    const configPath = join(root, ".arashi", "config.json");
    await mkdir(join(root, ".arashi"));
    await writeFile(configPath, original);
    await expect(loadConfigureSnapshot(root)).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
  test("emits one sanitized body-free JSON inspection and never prompts or mutates", async () => {
    const output: string[] = [];
    const collect = vi.fn();
    const transact = vi.fn();
    await executeConfigure(
      { json: true, stdinIsTTY: false, stdoutIsTTY: false },
      {
        collectEdits: collect,
        loadSnapshot: async () => ({
          bytes: new Uint8Array([1]),
          config,
          workspaceRoot: "/workspace",
        }),
        transact,
        writeJson: (value) => output.push(JSON.stringify(value)),
      },
    );
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toMatchObject({ command: "configure", ok: true });
    expect(output[0]).toContain("pre-create");
    expect(output[0]).toContain("bash");
    expect(output[0]).not.toContain(canary);
    expect(collect).not.toHaveBeenCalled();
    expect(transact).not.toHaveBeenCalled();
  });

  test("inspects existing workspace and repository native hooks without file bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-configure-native-inspect-"));
    const hooks = join(root, ".arashi", "hooks");
    await mkdir(hooks, { recursive: true });
    await mkdir(join(root, "repos", "app", ".arashi", "hooks"), { recursive: true });
    await writeFile(join(hooks, `pre-create${nativeExtension}`), "NATIVE_WORKSPACE_BODY");
    await writeFile(
      join(root, "repos", "app", ".arashi", "hooks", `post-remove${nativeExtension}`),
      "NATIVE_REPOSITORY_BODY",
    );
    const snapshot = {
      bytes: new Uint8Array(),
      config,
      executionRoot: root,
      persisted: config,
      workspaceRoot: root,
    };
    const inspection = await inspectConfigureSnapshot(snapshot);
    const serialized = JSON.stringify(inspection);
    expect(serialized).toContain('"sourceKind":"file"');
    expect(serialized).toContain('"lifecycle":"pre-create"');
    expect(serialized).toContain('"lifecycle":"post-remove"');
    expect(serialized).not.toContain("NATIVE_WORKSPACE_BODY");
    expect(serialized).not.toContain("NATIVE_REPOSITORY_BODY");
  });

  test("linked inspection observes workspace remove hooks at the configuration root", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-configure-linked-root-"));
    const linked = await mkdtemp(join(tmpdir(), "arashi-configure-linked-exec-"));
    await mkdir(join(root, ".arashi", "hooks"), { recursive: true });
    await mkdir(join(linked, ".arashi", "hooks"), { recursive: true });
    await writeFile(join(root, ".arashi", "hooks", `pre-remove${nativeExtension}`), "ROOT_ONLY");
    await writeFile(
      join(linked, ".arashi", "hooks", `post-remove${nativeExtension}`),
      "LINKED_ONLY",
    );
    const inspection = await inspectConfigureSnapshot({
      bytes: new Uint8Array(),
      config,
      executionRoot: linked,
      persisted: config,
      workspaceRoot: root,
    });
    const workspaceFiles = inspection.nativeSources.filter(({ scope }) => scope === "workspace");
    expect(workspaceFiles.map(({ lifecycle }) => lifecycle)).toContain("pre-remove");
    expect(workspaceFiles.map(({ lifecycle }) => lifecycle)).not.toContain("post-remove");
  });

  test("linked interactive editing observes workspace remove hooks at the configuration root", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-configure-linked-interactive-root-"));
    const linked = await mkdtemp(join(tmpdir(), "arashi-configure-linked-interactive-exec-"));
    await mkdir(join(root, ".arashi", "hooks"), { recursive: true });
    await mkdir(join(linked, ".arashi", "hooks"), { recursive: true });
    await writeFile(join(root, ".arashi", "hooks", `pre-remove${nativeExtension}`), "ROOT_ONLY");
    await writeFile(
      join(linked, ".arashi", "hooks", `post-remove${nativeExtension}`),
      "LINKED_ONLY",
    );
    const observed: Array<{ lifecycle: string; nativeCandidateCount?: number }> = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await executeConfigure(
      { stdinIsTTY: true, stdoutIsTTY: true },
      {
        collectEdits: async (options) => {
          observed.push(
            ...(await options.observeWorkspaceActivePaths!({
              lifecycles: [
                { inlineConfigured: false, lifecycle: "pre-remove", plannedPath: null },
                { inlineConfigured: false, lifecycle: "post-remove", plannedPath: null },
              ],
              repositoryName: "@workspace",
            })),
          );
          return { status: "no-changes" };
        },
        loadSnapshot: async () => ({
          bytes: new TextEncoder().encode(JSON.stringify(config)),
          config,
          executionRoot: linked,
          workspaceRoot: root,
        }),
        transact: vi.fn(),
        writeJson: vi.fn(),
      },
    );
    expect(observed.find(({ lifecycle }) => lifecycle === "pre-remove")?.nativeCandidateCount).toBe(
      1,
    );
    expect(
      observed.find(({ lifecycle }) => lifecycle === "post-remove")?.nativeCandidateCount,
    ).toBe(0);
    log.mockRestore();
  });

  test("JSON inspection failures emit exactly one standard error envelope", async () => {
    const output: unknown[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = await executeConfigure(
      { json: true },
      {
        collectEdits: vi.fn(),
        inspectSnapshot: async () => {
          throw Object.assign(new Error("observer denied"), { code: "EACCES" });
        },
        loadSnapshot: async () => ({
          bytes: new Uint8Array([1]),
          config,
          workspaceRoot: "/workspace",
        }),
        transact: vi.fn(),
        writeJson: (value) => output.push(value),
      },
    );
    expect(exitCode).toBe(1);
    expect(output).toEqual([
      expect.objectContaining({
        command: "configure",
        error: expect.objectContaining({ message: "observer denied" }),
        ok: false,
      }),
    ]);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });

  test("emits one JSON error envelope when strict loading fails", async () => {
    const output: unknown[] = [];
    const exitCode = await executeConfigure(
      { json: true },
      {
        collectEdits: vi.fn(),
        loadSnapshot: async () => {
          throw new Error("invalid persisted config");
        },
        transact: vi.fn(),
        writeJson: (value) => output.push(value),
      },
    );
    expect(output).toEqual([
      expect.objectContaining({
        command: "configure",
        error: expect.objectContaining({
          code: "CONFIG_LOAD_FAILED",
          message: "invalid persisted config",
        }),
        ok: false,
      }),
    ]);
    expect(exitCode).toBe(1);
  });

  test.each([
    [false, true],
    [true, false],
  ])("rejects human editing unless both streams are TTYs", async (stdinIsTTY, stdoutIsTTY) => {
    const transact = vi.fn();
    await expect(
      executeConfigure(
        { stdinIsTTY, stdoutIsTTY },
        {
          collectEdits: vi.fn(),
          loadSnapshot: async () => ({
            bytes: new Uint8Array([1]),
            config,
            workspaceRoot: "/workspace",
          }),
          transact,
          writeJson: vi.fn(),
        },
      ),
    ).rejects.toThrow(/stdin and stdout.*TTY/i);
    expect(transact).not.toHaveBeenCalled();
  });
});
