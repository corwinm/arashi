import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import {
  createCommand,
  executeSwitch,
  type SwitchCommandDependencies,
  type SwitchCommandOptions,
} from "../../src/commands/switch.ts";
import { type Config, loadWorkspaceRepositories } from "../../src/lib/config.ts";
import {
  type SwitchCandidate,
  discoverSwitchCandidates,
  selectSwitchCandidate,
} from "../../src/core/switch.ts";
import { T3HandoffError } from "../../src/lib/t3-error.ts";
import type {
  T3HandoffDependencies,
  T3HandoffResult,
  dispatchT3Handoff,
} from "../../src/lib/t3-handoff.ts";
import type { T3Settings } from "../../src/lib/t3-settings.ts";
import { nativeEnvironment } from "./t3-native.ts";

export type ProposedSwitchOptions = SwitchCommandOptions & {
  t3?: boolean | string;
  promptFile?: string;
  permission?: string;
  t3BaseDir?: string;
  t3Cli?: string;
  t3Provider?: string;
  t3Model?: string;
  t3Effort?: string;
  t3Intent?: string;
};
export type ProposedSwitchDependencies = SwitchCommandDependencies & {
  t3?: T3HandoffDependencies;
  dispatchT3Handoff?: typeof dispatchT3Handoff;
};
const run = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-c", "commit.gpgsign=false", ...args], { cwd })).stdout;
}
export async function initGit(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "Issue392 Fixture");
  await git(path, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(path, "tracked.txt"), "original\n");
  await writeFile(join(path, ".gitignore"), ".arashi/\n.worktrees/\nrepos/\nignored.txt\n");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "fixture");
}
export interface SwitchFixture {
  root: string;
  home: string;
  parent: string;
  linked: string;
  children: string[];
  linkedChildren: string[];
  configPath: string;
  config: Config;
  repositories: { name: string; path: string }[];
}
export async function switchFixture(configured = true): Promise<SwitchFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "arashi-392 ü '$-")));
  const home = join(root, "isolated-home");
  const parent = join(root, "parent ü with spaces");
  await mkdir(home);
  await initGit(parent);
  const config: Config = {
    version: "1.0.0",
    reposDir: "repos",
    repos: {},
    worktreesDir: ".arashi/worktrees",
  };
  const configPath = join(parent, ".arashi", "config.json");
  if (configured) {
    for (const name of ["child-a", "child-b"]) config.repos[name] = { path: join("repos", name) };
    await mkdir(join(parent, ".arashi"), { recursive: true });
    await writeFile(configPath, JSON.stringify(config));
  }
  const linked = join(
    parent,
    configured ? ".arashi/worktrees" : ".worktrees",
    "selected ü '$ path",
  );
  await git(parent, "worktree", "add", "-b", "feature/shared", linked);
  const children: string[] = [];
  const linkedChildren: string[] = [];
  if (configured) {
    for (const name of ["child-a", "child-b"]) {
      const child = join(parent, "repos", name);
      const linkedChild = join(linked, "repos", name);
      await initGit(child);
      await git(child, "worktree", "add", "-b", "feature/shared", linkedChild);
      children.push(child);
      linkedChildren.push(linkedChild);
    }
  }
  return {
    root,
    home,
    parent,
    linked,
    children,
    linkedChildren,
    configPath,
    config,
    repositories: [
      { name: basename(parent), path: parent },
      ...children.map((path) => ({ name: basename(path), path })),
    ],
  };
}
export async function setConfig(f: SwitchFixture, config: Config = f.config) {
  await writeFile(f.configPath, JSON.stringify(config));
}
export async function userSettings(f: SwitchFixture, t3?: T3Settings, mode?: string) {
  await mkdir(join(f.home, ".arashi"), { recursive: true });
  await writeFile(
    join(f.home, ".arashi", "config.json"),
    JSON.stringify({
      version: "1.0.0",
      defaults: { ...(t3 ? { t3 } : {}), ...(mode ? { switch: { mode } } : {}) },
    }),
  );
}
export async function clearUserSettings(f: SwitchFixture) {
  await rm(join(f.home, ".arashi"), { recursive: true, force: true });
}
export async function snapshot(f: SwitchFixture) {
  const checkouts = [f.parent, f.linked, ...f.children, ...f.linkedChildren];
  return Promise.all(
    checkouts.map(async (path) => ({
      path,
      status: await git(path, "status", "--porcelain=v1", "--untracked-files=all"),
      refs: await git(path, "show-ref"),
      worktrees: await git(path, "worktree", "list", "--porcelain"),
      files: await Promise.all(
        ["tracked.txt", "untracked.txt", "ignored.txt", ".gitignore"].map(async (name) => [
          name,
          await readFile(join(path, name), "utf8").catch(() => null),
        ]),
      ),
      config: await readFile(join(path, ".arashi/config.json"), "utf8").catch(() => null),
      hook: await readFile(join(path, "hook-ran"), "utf8").catch(() => null),
    })),
  );
}
export function acceptedHandoff(
  path: string,
  permission: T3HandoffResult["permission"] = "full-access",
): T3HandoffResult {
  return {
    adapter: "native",
    adapterVersion: "1",
    status: "succeeded",
    workspacePath: path,
    permission,
    promptDigest: "0".repeat(64),
    environment: { id: "environment-1", serverVersion: "0.0.43" },
    project: { id: "project-1", title: null, created: false },
    thread: { id: "thread-1", title: null },
    native: {
      environmentId: "environment-1",
      projectId: "project-1",
      threadId: "thread-1",
      messageId: "message-1",
      phase: "accepted",
    },
    selection: {
      instanceId: "codex",
      model: "catalog-default",
      options: [{ id: "reasoningEffort", value: "medium" }],
    },
    dispatch: { status: "succeeded" },
    ui: { mode: "none", kind: "none", exactThread: false, status: "skipped" },
    receiptPath: join(path, ".git/.arashi-t3-handoffs/fixture.switch/i-64656661756c74.json"),
    retry: {
      safe: false,
      guidance:
        "Manually select the reported project/thread in the same connected T3 client. The original conversation remains attached to its original checkout.",
    },
  };
}
export function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...args) =>
    stdout.push(args.map(String).join(" ") + "\n"),
  );
  vi.spyOn(console, "info").mockImplementation((...args) =>
    stdout.push(args.map(String).join(" ") + "\n"),
  );
  vi.spyOn(console, "error").mockImplementation((...args) =>
    stderr.push(args.map(String).join(" ") + "\n"),
  );
  vi.spyOn(console, "warn").mockImplementation((...args) =>
    stderr.push(args.map(String).join(" ") + "\n"),
  );
  return { stdout: () => stdout.join(""), stderr: () => stderr.join("") };
}
export function cliArgs(options: ProposedSwitchOptions): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue;
    const flag =
      key === "legacyNoCd"
        ? "--no-cd"
        : key === "legacyNoDefaultLaunch"
          ? "--no-default-launch"
          : "--" + key.replace(/[A-Z]/gu, (c) => "-" + c.toLowerCase());
    args.push(flag);
    if (typeof value === "string") args.push(value);
  }
  return args;
}
export async function invokeSwitch(
  boundary: "Commander" | "executor",
  filter: string | undefined,
  options: ProposedSwitchOptions,
  deps: ProposedSwitchDependencies = {},
) {
  const output = captureOutput();
  let value: unknown;
  let error: unknown;
  const exits: number[] = [];
  if (boundary === "Commander") {
    // Record the first native exit decision. Returning from the mock prevents
    // synthetic thrown-exit exceptions from contaminating command error output.
    vi.spyOn(process, "exit").mockImplementation((code) => {
      exits.push(Number(code ?? 0));
      return undefined as never;
    });
    const command = createCommand()
      .exitOverride()
      .configureOutput({
        writeOut: (s) => process.stdout.write(s),
        writeErr: (s) => process.stderr.write(s),
      });
    try {
      value = await command.parseAsync([...(filter ? [filter] : []), ...cliArgs(options)], {
        from: "user",
      });
    } catch (caught) {
      error = caught;
    }
  } else {
    try {
      value = await executeSwitch(filter, options, deps);
    } catch (caught) {
      error = caught;
    }
  }
  const operational =
    error instanceof T3HandoffError &&
    !(
      /^T3_(?:PROMPT|PERMISSION|CONFIG)_/u.test(error.code) ||
      ["T3_OPTIONS_INVALID", "T3_OPTIONS_REQUIRE_T3", "T3_INTENT_INVALID"].includes(error.code)
    );
  const parserExit =
    error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number"
      ? error.exitCode
      : undefined;
  const exitCode =
    exits[0] ??
    parserExit ??
    (typeof value === "number" ? value : error ? (operational ? 1 : 2) : 0);
  return { ...output, value, error, exitCode };
}
export function jsonDetails(
  out: Awaited<ReturnType<typeof invokeSwitch>>,
): Record<string, unknown> {
  const envelope = JSON.parse(out.stdout());
  return envelope.ok ? envelope.data : envelope.error.details;
}
export function nativeMockImplementation(input: Parameters<typeof dispatchT3Handoff>[0]) {
  return Promise.resolve({
    ...acceptedHandoff(input.workspacePath, input.request.permission),
    promptDigest: input.request.promptDigest,
  });
}
export const availableEnvironment = nativeEnvironment;
export { loadWorkspaceRepositories, discoverSwitchCandidates, selectSwitchCandidate };
export type { SwitchCandidate };
