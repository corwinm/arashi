import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { T3HandoffError } from "../../src/lib/t3-error.ts";
import { createCommand as createCreateCommand } from "../../src/commands/create.ts";
import {
  acceptedHandoff,
  availableEnvironment,
  clearUserSettings,
  initGit,
  invokeSwitch,
  nativeMockImplementation,
  setConfig,
  snapshot,
  switchFixture,
  userSettings,
  type ProposedSwitchOptions,
  type SwitchFixture,
} from "../helpers/switch-t3-command.ts";
import type { T3Settings } from "../../src/lib/t3-settings.ts";

const native = vi.hoisted(() => ({
  preflight: vi.fn(),
  dispatch: vi.fn(),
  launch: vi.fn(),
  discover: vi.fn(),
  select: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock("../../src/lib/t3-native.ts", async (original) => ({
  ...(await original<typeof import("../../src/lib/t3-native.ts")>()),
  preflightT3Native: native.preflight,
}));
vi.mock("../../src/lib/t3-handoff.ts", async (original) => ({
  ...(await original<typeof import("../../src/lib/t3-handoff.ts")>()),
  preflightT3Native: native.preflight,
  dispatchT3Handoff: native.dispatch,
}));
vi.mock("../../src/lib/switch-launcher.ts", async (original) => ({
  ...(await original<typeof import("../../src/lib/switch-launcher.ts")>()),
  launchSwitchTarget: native.launch,
}));
vi.mock("../../src/core/switch.ts", async (original) => ({
  ...(await original<typeof import("../../src/core/switch.ts")>()),
  discoverSwitchCandidates: native.discover,
  selectSwitchCandidate: native.select,
}));

const boundaries = ["Commander", "executor"] as const;
const formats = [false, true] as const;
const originalCwd = process.cwd();
const ttyDescriptors = [
  Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
];
let f: SwitchFixture;
let standalone: SwitchFixture;
let target: string | undefined;
let afterSelection: (() => Promise<void>) | undefined;
let realCore: typeof import("../../src/core/switch.ts");
function tty(enabled: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: enabled });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: enabled });
}
beforeAll(async () => {
  f = await switchFixture();
  standalone = await switchFixture(false);
  realCore = await vi.importActual("../../src/core/switch.ts");
});
beforeEach(async () => {
  process.chdir(f.parent);
  tty(false);
  target = f.linked;
  afterSelection = undefined;
  vi.stubEnv("HOME", f.home);
  vi.stubEnv("NO_COLOR", "1");
  vi.stubEnv("T3CODE_HOME", join(f.root, "absent-runtime"));
  for (const mock of Object.values(native)) mock.mockReset();
  await setConfig(f);
  await clearUserSettings(f);
  await rm(join(f.root, "directive"), { force: true });
  native.launch.mockResolvedValue({
    command: ["never-executed-launcher"],
    disposition: "window",
    mode: "fallback",
  });
  native.preflight.mockImplementation(async (_cwd, _deps, settings) => ({
    ...availableEnvironment(),
    settings: settings ?? {},
  }));
  native.dispatch.mockImplementation(nativeMockImplementation);
  native.discover.mockImplementation(realCore.discoverSwitchCandidates);
  native.prompt.mockImplementation(async (_message, choices) => ({
    status: "ok",
    value: choices[0].value,
  }));
  native.select.mockImplementation(async (candidates, options) => {
    const selected =
      target && candidates.find((c: { worktreePath: string }) => c.worktreePath === target);
    const value =
      selected ??
      (await realCore.selectSwitchCandidate(candidates, options, { selectPrompt: native.prompt }));
    await afterSelection?.();
    return value;
  });
});
afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [i, stream] of [process.stdin, process.stdout].entries()) {
    const descriptor = ttyDescriptors[i];
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
});
afterAll(async () => {
  await Promise.all(
    [f, standalone].map((fixture) => rm(fixture.root, { recursive: true, force: true })),
  );
});

async function accepted(
  boundary: (typeof boundaries)[number],
  filter: string | undefined,
  options: ProposedSwitchOptions,
  expected = target!,
) {
  const out = await invokeSwitch(boundary, filter, {
    t3: "Continue the approved task",
    ...options,
  });
  expect(out.exitCode).toBe(0);
  expect(native.dispatch).toHaveBeenCalledTimes(1);
  const input = native.dispatch.mock.calls[0]![0];
  expect(input.workspacePath).toBe(await realpath(expected));
  expect(input.dryRun).toBe(false);
  expect(input.request.prompt).toBe(
    typeof options.t3 === "string" ? options.t3 : "Continue the approved task",
  );
  expect(native.launch).not.toHaveBeenCalled();
  expect(await readFile(join(f.root, "directive"), "utf8").catch(() => null)).toBeNull();
  expect(out.stdout()).not.toMatch(/Opened .* context/);
  return { out, input };
}
function noNativeEffects() {
  expect(native.preflight).not.toHaveBeenCalled();
  expect(native.dispatch).not.toHaveBeenCalled();
  expect(native.launch).not.toHaveBeenCalled();
}
function envelope(out: Awaited<ReturnType<typeof invokeSwitch>>) {
  expect(out.stderr()).toBe("");
  const value = JSON.parse(out.stdout());
  expect(value).toMatchObject({ command: "switch", schemaVersion: 1 });
  return value;
}

describe("issue392 A01 real configured discovery/scope/selection", () => {
  const cases = ["main", "linked-parent", "linked-child"].flatMap((invocation) =>
    ["parent", "repos", "all"].flatMap((scope) =>
      (scope === "parent"
        ? ["parent"]
        : scope === "repos"
          ? ["child-a", "child-b"]
          : ["parent", "child-a", "child-b"]
      ).flatMap((selected) =>
        ["filter", "path"].map((mode) => ({ invocation, scope, selected, mode })),
      ),
    ),
  );
  test.each(cases)(
    "$invocation scope=$scope $selected $mode",
    async ({ invocation, scope, selected, mode }) => {
      process.chdir(
        invocation === "main"
          ? f.parent
          : invocation === "linked-parent"
            ? f.linked
            : f.linkedChildren[0]!,
      );
      target =
        selected === "parent"
          ? invocation === "main"
            ? f.linked
            : f.linked
          : f.linkedChildren[selected === "child-a" ? 0 : 1]!;
      tty(true);
      const filter = mode === "path" ? target : scope === "repos" ? selected : "feature/shared";
      await accepted("executor", filter, {
        ...(scope === "repos" ? { repos: true } : scope === "all" ? { all: true } : {}),
        path: mode === "path",
      });
      const candidates = native.select.mock.calls[0]![0] as {
        repoName: string;
        worktreePath: string;
      }[];
      expect(candidates.some((c) => c.worktreePath === target)).toBe(true);
      if (scope === "repos") expect(candidates.every((c) => c.repoName === selected)).toBe(true);
      if (scope === "all" && mode === "filter")
        expect(new Set(candidates.map((c) => c.repoName)).size).toBe(3);
    },
  );
});
describe("issue392 A02 standalone main/linked discovery and invalid scopes", () => {
  test.each(
    ["main", "linked"].flatMap((invocation) =>
      ["main", "linked"].flatMap((selected) =>
        ["filter", "path"].flatMap((mode) =>
          boundaries.map((boundary) => ({ invocation, selected, mode, boundary })),
        ),
      ),
    ),
  )(
    "$boundary $invocation -> $selected $mode",
    async ({ invocation, selected, mode, boundary }) => {
      process.chdir(invocation === "main" ? standalone.parent : standalone.linked);
      target = selected === "main" ? standalone.parent : standalone.linked;
      await accepted(
        boundary,
        mode === "path" ? target : selected === "main" ? "main" : "feature/shared",
        { path: mode === "path" },
      );
    },
  );
  test.each(
    ["main", "linked"].flatMap((invocation) =>
      ["repos", "all", "both"].flatMap((scope) =>
        formats.flatMap((json) =>
          boundaries.map((boundary) => ({ invocation, scope, json, boundary })),
        ),
      ),
    ),
  )(
    "$boundary rejects standalone $invocation $scope json=$json",
    async ({ invocation, scope, json, boundary }) => {
      process.chdir(invocation === "main" ? standalone.parent : standalone.linked);
      const out = await invokeSwitch(boundary, undefined, {
        t3: "Task",
        json,
        repos: scope !== "all",
        all: scope !== "repos",
      });
      expect(out.exitCode).toBe(2);
      if (json) expect(envelope(out).error.code).toBe("CONFLICTING_SWITCH_OPTIONS");
      else if (boundary === "executor")
        expect(out.error).toMatchObject({ code: "CONFLICTING_SWITCH_OPTIONS" });
      else expect(out.stderr()).toMatch(/standalone|conflict/i);
      noNativeEffects();
    },
  );
  test.each(boundaries)("rejects configured repos+all at $boundary", async (boundary) => {
    const out = await invokeSwitch(boundary, f.linked, {
      path: true,
      repos: true,
      all: true,
      t3: "Task",
      json: true,
    });
    expect(out.exitCode).toBe(2);
    expect(envelope(out).error.code).toBe("CONFLICTING_SWITCH_OPTIONS");
    noNativeEffects();
  });
});
describe("issue392 A03 finite empty/no-match/ambiguous/cancel selection", () => {
  test.each(
    ["no-target", "no-match", "multiple"].flatMap((kind) =>
      ["human-TTY", "human-pipe", "JSON-TTY", "JSON-pipe"].flatMap((format) =>
        boundaries.map((boundary) => ({ kind, format, boundary })),
      ),
    ),
  )("$boundary $kind $format", async ({ kind, format, boundary }) => {
    target = undefined;
    tty(format.endsWith("TTY"));
    const json = format.startsWith("JSON");
    if (kind === "no-target")
      native.discover.mockResolvedValue({ candidates: [], skippedCount: 0 });
    const out = await invokeSwitch(boundary, kind === "no-match" ? "does-not-exist" : undefined, {
      t3: "Task",
      json,
    });
    if (kind === "multiple" && format === "human-TTY") {
      expect(out.exitCode).toBe(0);
      expect(native.prompt).toHaveBeenCalledTimes(1);
      expect(native.dispatch).toHaveBeenCalledTimes(1);
    } else {
      const code =
        kind === "no-target"
          ? "NO_TARGETS"
          : kind === "no-match"
            ? "NO_MATCHES"
            : "AMBIGUOUS_NON_INTERACTIVE";
      expect(out.exitCode).toBe(2);
      if (json) {
        const error = envelope(out).error;
        expect(error.code).toBe(code);
        if (kind === "multiple") expect(JSON.stringify(error)).toMatch(/--path/);
      } else if (boundary === "executor") expect(out.error).toMatchObject({ code });
      else
        expect(out.stderr()).toMatch(
          kind === "multiple"
            ? /matching|specific|ambig/i
            : kind === "no-target"
              ? /targets|worktree/i
              : /match/i,
        );
      expect(native.prompt).not.toHaveBeenCalled();
      noNativeEffects();
    }
  });
  test.each(boundaries)(
    "$boundary human interactive cancellation succeeds with zero effects",
    async (boundary) => {
      target = undefined;
      tty(true);
      native.prompt.mockResolvedValue({ status: "cancelled", reason: "exit" });
      const out = await invokeSwitch(boundary, undefined, { t3: "Task" });
      expect(out.exitCode).toBe(0);
      noNativeEffects();
    },
  );
});
describe("issue392 A04 physical aliases, scope paths and changed checkout", () => {
  test.each(["spaces", "unicode", "symlink", "Windows-case-simulation"])(
    "exact selected physical checkout: %s",
    async (kind) => {
      const physical = f.linked;
      if (kind === "symlink" || kind === "Windows-case-simulation") {
        const alias = join(
          f.root,
          kind === "symlink" ? "alias checkout" : "UPPERCASE-CHECKOUT-ALIAS",
        );
        await symlink(physical, alias, "junction");
        target = alias;
        native.discover.mockResolvedValue({
          candidates: [
            { worktreePath: alias, branchName: "feature/shared", repoName: basename(f.parent) },
          ],
          skippedCount: 0,
        });
      }
      await accepted("executor", target, { path: true }, physical);
    },
  );
  test.each(
    ["arbitrary-directory", "subdirectory", "undiscovered-alias"].flatMap((kind) =>
      formats.map((json) => ({ kind, json })),
    ),
  )("rejects $kind json=$json", async ({ kind, json }) => {
    const path = join(kind === "subdirectory" ? f.linked : f.root, kind + String(json));
    if (kind === "undiscovered-alias") await symlink(f.linked, path, "junction");
    else await mkdir(path);
    const out = await invokeSwitch("executor", path, { t3: "Task", path: true, json });
    expect(out.exitCode).toBe(2);
    if (json) expect(envelope(out).error.code).toBe("NO_MATCHES");
    else expect(out.error).toMatchObject({ code: "NO_MATCHES" });
    noNativeEffects();
  });
  test.each(["vanished", "replaced"].flatMap((kind) => formats.map((json) => ({ kind, json }))))(
    "blocks $kind after selection before remote json=$json",
    async ({ kind, json }) => {
      const local = await switchFixture(false);
      process.chdir(local.parent);
      target = local.linked;
      native.preflight.mockImplementation(async () => {
        await rename(local.linked, local.linked + "-saved");
        if (kind === "replaced") await initGit(local.linked);
        return availableEnvironment();
      });
      try {
        const out = await invokeSwitch("executor", target, { t3: "Task", path: true, json });
        expect(out.exitCode).toBe(1);
        expect(native.dispatch).not.toHaveBeenCalled();
        expect(native.launch).not.toHaveBeenCalled();
        if (json) expect(envelope(out).error.code).toMatch(/WORKSPACE|CHECKOUT|TARGET/);
        else
          expect(out.error).toMatchObject({
            code: expect.stringMatching(/WORKSPACE|CHECKOUT|TARGET/),
          });
      } finally {
        process.chdir(f.parent);
        await rm(local.root, { recursive: true, force: true });
      }
    },
  );
});
describe("issue392 A05 real dirty checkout preservation", () => {
  test.each(
    ["parent", "child-a", "child-b"].flatMap((selected) =>
      ["tracked", "untracked", "ignored", "all"].map((dirty) => ({ selected, dirty })),
    ),
  )("$selected dirty=$dirty with hook markers and refs", async ({ selected, dirty }) => {
    for (const path of [f.parent, f.linked, ...f.children, ...f.linkedChildren]) {
      if (dirty === "tracked" || dirty === "all")
        await writeFile(join(path, "tracked.txt"), "dirty tracked\n");
      if (dirty === "untracked" || dirty === "all")
        await writeFile(join(path, "untracked.txt"), "untracked bytes\n");
      if (dirty === "ignored" || dirty === "all")
        await writeFile(join(path, "ignored.txt"), "ignored bytes\n");
    }
    await setConfig(f, {
      ...f.config,
      hooks: { scripts: { "pre-create": "touch hook-ran", "post-create": "touch hook-ran" } },
    });
    target = selected === "parent" ? f.linked : f.linkedChildren[selected === "child-a" ? 0 : 1]!;
    const before = await snapshot(f);
    await accepted("executor", target, { path: true, all: true });
    expect(await snapshot(f)).toEqual(before);
  });
});
describe("issue392 A07 redundant opt-outs and legal scopes", () => {
  test.each(
    ["canonical", "legacy", "both"].flatMap((optout) =>
      ["parent", "repos", "all", "path"].flatMap((scope) =>
        boundaries.map((boundary) => ({ optout, scope, boundary })),
      ),
    ),
  )("$boundary $optout $scope", async ({ optout, scope, boundary }) => {
    tty(true);
    if (scope === "repos") target = f.linkedChildren[0]!;
    await accepted(
      boundary,
      scope === "path" ? target : scope === "repos" ? "child-a" : "feature/shared",
      {
        path: scope === "path",
        repos: scope === "repos",
        all: scope === "all",
        ignoreConfiguredLauncher: optout !== "legacy",
        legacyNoDefaultLaunch: optout !== "canonical",
      },
    );
  });
});
describe("issue392 A08 all configured/personal modes and contexts", () => {
  test.each(
    ["auto", "cd", "launch", "sesh", "herdr", "omitted"].flatMap((mode) =>
      formats.flatMap((shell) =>
        formats.flatMap((managed) =>
          ["workspace", "user"].flatMap((source) =>
            boundaries.map((boundary) => ({ mode, shell, managed, source, boundary })),
          ),
        ),
      ),
    ),
  )(
    "$boundary $source mode=$mode shell=$shell managed=$managed",
    async ({ mode, shell, managed, source, boundary }) => {
      if (mode !== "omitted") {
        if (source === "workspace")
          await setConfig(f, { ...f.config, defaults: { switch: { mode: mode as "auto" } } });
        else await userSettings(f, undefined, mode);
      }
      if (shell) {
        vi.stubEnv("ARASHI_DIRECTIVE_FILE", join(f.root, "directive"));
        vi.stubEnv("ARASHI_SHELL", "bash");
      }
      if (managed) {
        vi.stubEnv("TMUX", "/tmp/fixture-tmux");
        vi.stubEnv("HERDR_ENV", "1");
        vi.stubEnv("CMUX_WORKSPACE_ID", "managed");
      }
      await accepted(boundary, target, { path: true });
    },
  );
});
describe("issue392 A09 unsupported create-only CLI flags", () => {
  const supported = new Set([
    "--t3",
    "--prompt-file",
    "--permission",
    "--t3-base-dir",
    "--t3-cli",
    "--t3-provider",
    "--t3-model",
    "--t3-effort",
    "--t3-intent",
    "--json",
    "--launch",
    "--sesh",
    "--tmux",
    "--herdr",
    "--tab",
    "--vscode",
    "--cursor",
    "--kiro",
    "--no-default-launch",
    "--repos",
    "--all",
    "--help",
  ]);
  const unsupported = createCreateCommand()
    .options.filter((o) => o.long && !supported.has(o.long))
    .map((o) => ({ flag: o.long!, required: o.required }));
  test.each(unsupported)("retains unsupported create option $flag", async ({ flag, required }) => {
    const output: string[] = [];
    const { createCommand } = await import("../../src/commands/switch.ts");
    const command = createCommand()
      .exitOverride()
      .configureOutput({ writeErr: (s) => output.push(s) });
    await expect(
      command.parseAsync([flag, ...(required ? ["fixture-value"] : [])], { from: "user" }),
    ).rejects.toThrow(/unknown option/);
    noNativeEffects();
  });
});

describe("issue392 A10 exact prompt bytes and invalid prompts before effects", () => {
  const invalid = [
    "missing",
    "both",
    "empty-inline",
    "whitespace-inline",
    "empty-file",
    "whitespace-file",
    "unreadable",
    "invalid-UTF8",
  ];
  test.each(
    invalid.flatMap((kind) =>
      formats.flatMap((json) => boundaries.map((boundary) => ({ kind, json, boundary }))),
    ),
  )("$boundary $kind json=$json", async ({ kind, json, boundary }) => {
    const path = join(f.parent, "task-input.md");
    await writeFile(
      path,
      kind === "invalid-UTF8" ? Buffer.from([0xff, 0xfe]) : kind === "empty-file" ? "" : " \n\t",
    );
    const options: ProposedSwitchOptions = { t3: true, path: true, json };
    if (kind === "both") {
      options.t3 = "inline";
      options.promptFile = path;
    }
    if (kind === "empty-inline" || kind === "whitespace-inline")
      options.t3 = kind === "empty-inline" ? "" : " \n\t";
    if (["empty-file", "whitespace-file", "invalid-UTF8"].includes(kind)) options.promptFile = path;
    if (kind === "unreadable") options.promptFile = path + "-absent";
    const out = await invokeSwitch(boundary, f.linked, options);
    expect(out.exitCode).toBe(2);
    if (json) expect(envelope(out).error.code).toMatch(/^T3_PROMPT_/);
    else if (boundary === "executor")
      expect(out.error).toMatchObject({ code: expect.stringMatching(/^T3_PROMPT_/) });
    noNativeEffects();
  });
  test.each(
    ["inline-multiline", "file-relative", "file-absolute"].flatMap((source) =>
      formats.flatMap((json) => boundaries.map((boundary) => ({ source, json, boundary }))),
    ),
  )("$boundary $source exact bytes/read-once json=$json", async ({ source, json, boundary }) => {
    const text = "Exact ü task\n  $HOME `literal` 'quote'\r\n";
    const path = join(f.parent, "original-cwd-task.md");
    await writeFile(path, text);
    afterSelection = async () => {
      await writeFile(path, "changed after selection");
    };
    const options: ProposedSwitchOptions = {
      t3: source === "inline-multiline" ? text : true,
      json,
      path: true,
      ...(source === "file-relative"
        ? { promptFile: "original-cwd-task.md" }
        : source === "file-absolute"
          ? { promptFile: path }
          : {}),
    };
    const out = await invokeSwitch(boundary, target, options);
    expect(out.exitCode).toBe(0);
    expect(native.dispatch).toHaveBeenCalledTimes(1);
    expect(native.dispatch.mock.calls[0]![0].request.prompt).toBe(text);
    expect(native.launch).not.toHaveBeenCalled();
    expect(out.stdout() + out.stderr()).not.toContain(text);
  });
});
describe("issue392 A11 permissions independent of runtime defaults", () => {
  test.each(
    ["omitted", "approval-required", "auto-accept-edits", "full-access", "invalid"].flatMap(
      (permission) =>
        ["approval-required", "full-access"].flatMap((runtime) =>
          formats.flatMap((json) =>
            boundaries.map((boundary) => ({ permission, runtime, json, boundary })),
          ),
        ),
    ),
  )(
    "$boundary permission=$permission runtime=$runtime json=$json",
    async ({ permission, runtime, json, boundary }) => {
      native.preflight.mockImplementation(async () => ({
        ...availableEnvironment(),
        config: { ...availableEnvironment().config, settings: { runtimeMode: runtime } },
      }));
      const out = await invokeSwitch(boundary, target, {
        t3: "Task",
        path: true,
        json,
        ...(permission === "omitted" ? {} : { permission }),
      });
      if (permission === "invalid") {
        expect(out.exitCode).toBe(2);
        noNativeEffects();
        if (json) expect(envelope(out).error.code).toBe("T3_PERMISSION_INVALID");
      } else {
        expect(out.exitCode).toBe(0);
        expect(native.dispatch).toHaveBeenCalledTimes(1);
        expect(native.dispatch.mock.calls[0]![0].request.permission).toBe(
          permission === "omitted" ? "full-access" : permission,
        );
        expect(out.stdout()).toContain(permission === "omitted" ? "full-access" : permission);
      }
    },
  );
});
describe("issue392 A12 per-leaf settings and invalid applicable config", () => {
  const leaves = ["baseDir", "cli", "provider", "model", "effort"] as const;
  const values = (leaf: (typeof leaves)[number], source: string) =>
    leaf === "baseDir"
      ? join(f.root, source + "-t3")
      : leaf === "cli"
        ? source + "-t3"
        : source + "-" + leaf;
  test.each(
    leaves.flatMap((leaf) =>
      ["explicit", "workspace", "user", "omitted"].flatMap((source) =>
        boundaries.map((boundary) => ({ leaf, source, boundary })),
      ),
    ),
  )("$boundary $leaf source=$source", async ({ leaf, source, boundary }) => {
    if (source !== "omitted") await userSettings(f, { [leaf]: values(leaf, "user") });
    if (source === "explicit" || source === "workspace")
      await setConfig(f, { ...f.config, defaults: { t3: { [leaf]: values(leaf, "workspace") } } });
    const key = "t3" + leaf[0]!.toUpperCase() + leaf.slice(1);
    const options: ProposedSwitchOptions = {
      t3: "Task",
      path: true,
      ...(source === "explicit" ? { [key]: values(leaf, "explicit") } : {}),
    };
    const out = await invokeSwitch(boundary, target, options);
    expect(out.exitCode).toBe(0);
    expect(native.preflight).toHaveBeenCalledTimes(1);
    const settings = native.preflight.mock.calls[0]![2] as T3Settings;
    expect(settings?.[leaf]).toBe(source === "omitted" ? undefined : values(leaf, source));
    expect(native.preflight.mock.calls[0]![0]).toBe(target);
    expect(native.dispatch).toHaveBeenCalledTimes(1);
    expect(native.dispatch.mock.calls[0]![0].switch.provenance[leaf]).toBe(
      source === "omitted" ? "native" : source === "explicit" ? "cli" : source,
    );
  });
  test.each(boundaries)("$boundary merges partial nested sibling leaves", async (boundary) => {
    await userSettings(f, {
      provider: "user-provider",
      effort: "medium",
      baseDir: join(f.root, "user-t3"),
    });
    await setConfig(f, {
      ...f.config,
      defaults: { t3: { model: "workspace-model", cli: "workspace-t3" } },
    });
    const out = await invokeSwitch(boundary, target, { path: true, t3: "Task", t3Effort: "high" });
    expect(out.exitCode).toBe(0);
    expect(native.preflight).toHaveBeenCalledTimes(1);
    expect(native.preflight.mock.calls[0]![2]).toEqual({
      provider: "user-provider",
      model: "workspace-model",
      effort: "high",
      cli: "workspace-t3",
      baseDir: join(f.root, "user-t3"),
    });
  });
  test.each(
    ["workspace", "user"].flatMap((source) =>
      formats.flatMap((explicit) =>
        formats.flatMap((json) =>
          boundaries.map((boundary) => ({ source, explicit, json, boundary })),
        ),
      ),
    ),
  )(
    "$boundary invalid $source explicit=$explicit json=$json",
    async ({ source, explicit, json, boundary }) => {
      if (source === "workspace")
        await writeFile(
          f.configPath,
          JSON.stringify({ ...f.config, defaults: { t3: { effort: 42 } } }),
        );
      else {
        await userSettings(f);
        await writeFile(join(f.home, ".arashi/config.json"), "{");
      }
      const out = await invokeSwitch(boundary, target, {
        t3: "Task",
        path: true,
        json,
        ...(explicit ? { t3Effort: "high", t3BaseDir: join(f.root, "explicit") } : {}),
      });
      expect(out.exitCode).toBe(2);
      noNativeEffects();
      if (json) expect(envelope(out).ok).toBe(false);
      else expect(out.error ?? out.stderr()).toBeTruthy();
    },
  );
});
describe("issue392 A13 command settings validation", () => {
  test.each(
    ["command", "absolute", "invalid-relative"].flatMap((cli) =>
      boundaries.map((boundary) => ({ cli, boundary })),
    ),
  )("$boundary CLI $cli at selected CWD", async ({ cli, boundary }) => {
    const value =
      cli === "command" ? "t3-selected" : cli === "absolute" ? join(f.root, "bin/t3") : "./bin/t3";
    const out = await invokeSwitch(boundary, target, { t3: "Task", path: true, t3Cli: value });
    if (cli === "invalid-relative") {
      expect(out.exitCode).toBe(2);
      noNativeEffects();
    } else {
      expect(out.exitCode).toBe(0);
      expect(native.preflight).toHaveBeenCalledTimes(1);
      expect(native.preflight.mock.calls[0]![0]).toBe(target);
      expect(native.preflight.mock.calls[0]![2].cli).toBe(value);
    }
  });
});

describe("issue392 A27 truthful command outcomes and one JSON envelope", () => {
  test.each(
    [
      "accepted",
      "replayed",
      "prerequisite",
      "partial",
      "uncertain",
      "locked",
      "validation",
      "selection",
    ].flatMap((stage) =>
      formats.flatMap((json) => boundaries.map((boundary) => ({ stage, json, boundary }))),
    ),
  )("$boundary $stage json=$json", async ({ stage, json, boundary }) => {
    const result = acceptedHandoff(target!);
    if (stage === "prerequisite")
      native.preflight.mockRejectedValue(
        new T3HandoffError("T3_CLI_NOT_FOUND", "Install the matching official T3 CLI."),
      );
    if (["partial", "uncertain", "locked"].includes(stage)) {
      result.status =
        stage === "partial" ? "failed" : stage === "locked" ? "dispatching" : "indeterminate";
      result.dispatch.status = result.status;
      result.native!.phase = stage === "partial" ? "preparing" : "submitting";
      if (stage === "partial") result.thread.id = null;
      native.dispatch.mockRejectedValue(
        new T3HandoffError(
          stage === "partial"
            ? "T3_HANDOFF_FAILED"
            : stage === "locked"
              ? "T3_HANDOFF_LOCKED"
              : "T3_DISPATCH_UNCERTAIN",
          "Reconcile the exact selected checkout with the same intent; never resubmit an uncertain task.",
          { receiptPath: result.receiptPath },
          result,
        ),
      );
    }
    const out = await invokeSwitch(boundary, stage === "selection" ? "no-such-target" : target, {
      t3: stage === "validation" ? " " : "Task",
      path: true,
      json,
      t3Intent: "default",
    });
    const expectedExit = ["accepted", "replayed"].includes(stage)
      ? 0
      : ["validation", "selection"].includes(stage)
        ? 2
        : 1;
    expect(out.exitCode).toBe(expectedExit);
    expect(native.launch).not.toHaveBeenCalled();
    if (["validation", "selection"].includes(stage)) noNativeEffects();
    else {
      expect(native.preflight).toHaveBeenCalledTimes(1);
      expect(native.dispatch).toHaveBeenCalledTimes(stage === "prerequisite" ? 0 : 1);
    }
    if (json) {
      const e = envelope(out);
      expect(e.ok).toBe(expectedExit === 0);
      if (stage === "validation") expect(e.error.code).toMatch(/^T3_PROMPT_/);
      if (stage === "selection") expect(e.error.code).toBe("NO_MATCHES");
      const details = e.ok ? e.data : e.error.details;
      if (!["validation", "selection"].includes(stage)) {
        expect(details.selected).toMatchObject({
          branchName: "feature/shared",
          repoName: basename(f.parent),
          worktreePath: target,
        });
        expect(details.workspace.mode).toBe("configured");
        expect(details.t3Handoff).toMatchObject({
          intentId: "default",
          ui: { mode: "none", status: "skipped" },
          permission: "full-access",
        });
        if (stage === "prerequisite") {
          expect(details.t3Handoff.environment.id).toBeNull();
          expect(details.t3Handoff.project.id).toBeNull();
          expect(details.t3Handoff.thread.id).toBeNull();
        } else {
          expect(details.t3Handoff.dispatch.status).toBe(result.dispatch.status);
          expect(details.t3Handoff.project.id).toBe("project-1");
          expect(details.t3Handoff.native.messageId).toBe("message-1");
        }
      }
    } else if (expectedExit === 0) {
      expect(out.stdout()).toContain("feature/shared");
      expect(out.stdout()).toContain(basename(f.parent));
      expect(out.stdout()).toContain(target!);
      expect(out.stdout()).toContain("full-access");
      expect(out.stdout()).toContain("thread-1");
      expect(out.stdout()).not.toMatch(/Opened .* context/);
    }
  });
});
describe("issue392 A28 command allowlisted outputs and secrecy", () => {
  const canaries = [
    "prompt",
    "token",
    "session-output",
    "URL",
    "config-secret",
    "control-characters",
  ];
  test.each(
    canaries.flatMap((kind) =>
      ["stdout", "stderr", "error"].flatMap((surface) =>
        formats.flatMap((json) =>
          boundaries.map((boundary) => ({ kind, surface, json, boundary })),
        ),
      ),
    ),
  )("$boundary $kind $surface json=$json", async ({ kind, surface, json, boundary }) => {
    const secret = "CANARY_392_" + kind.toUpperCase();
    const result = {
      ...acceptedHandoff(target!),
      token: secret,
      sessionOutput: secret,
      origin: "http://token@localhost/?secret=" + secret,
      config: { secret },
      rawOutput: secret,
    };
    if (kind === "control-characters") {
      native.discover.mockResolvedValue({
        candidates: [
          {
            branchName: "feature\u001b[31m/shared",
            repoName: "parent\u0007",
            worktreePath: target,
          },
        ],
        skippedCount: 0,
      });
      result.project.id = "project-1\u001b[31m";
    }
    if (surface === "error")
      native.dispatch.mockRejectedValue(
        Object.assign(new Error(secret), { token: secret, config: { secret }, result }),
      );
    else native.dispatch.mockResolvedValue(result);
    const out = await invokeSwitch(boundary, target, {
      t3: kind === "prompt" ? secret : "Task",
      path: true,
      json,
    });
    expect(out.exitCode).toBe(surface === "error" ? 1 : 0);
    expect(native.dispatch).toHaveBeenCalledTimes(1);
    expect(native.launch).not.toHaveBeenCalled();
    const text =
      surface === "stdout"
        ? out.stdout()
        : surface === "stderr"
          ? out.stderr()
          : !json && boundary === "Commander"
            ? out.stdout() + out.stderr()
            : JSON.stringify(
                out.error instanceof Error
                  ? {
                      message: out.error.message,
                      ...("result" in out.error ? { result: out.error.result } : {}),
                    }
                  : envelope(out).error,
              );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("http://token@");
    if (kind === "control-characters") {
      const rendered = json && out.stdout() ? JSON.stringify(JSON.parse(out.stdout())) : text;
      expect(rendered).not.toMatch(/\\u001b|\\u0007/u);
      expect(rendered).not.toContain(String.fromCharCode(27));
      expect(rendered).not.toContain(String.fromCharCode(7));
    }
  });
});

describe("issue392 A18 command intent admission", () => {
  const valid = [
    undefined,
    "default",
    "A".repeat(64),
    "Followup",
    "followup",
    "CON",
    "NUL",
    "CON.txt",
    "NUL.txt",
    "followup.",
    "followup..",
  ];
  test.each(
    valid.flatMap((intent) =>
      boundaries.flatMap((boundary) => formats.map((json) => ({ intent, boundary, json }))),
    ),
  )("A18 $boundary JSON=$json literal=$intent", async ({ intent, boundary, json }) => {
    const { input } = await accepted(boundary, f.linked, {
      path: true,
      t3Intent: intent,
      json,
    });
    expect(input.switch.intentId).toBe(intent ?? "default");
  });
  test.each(
    ["", "-bad", "a/b", "a b", "é", "a".repeat(65), "a\n", "a\\b"].flatMap((intent) =>
      boundaries.flatMap((boundary) => formats.map((json) => ({ intent, boundary, json }))),
    ),
  )("A18 $boundary JSON=$json invalid literal=$intent", async ({ intent, boundary, json }) => {
    const out = await invokeSwitch(boundary, f.linked, {
      path: true,
      t3: "task",
      t3Intent: intent,
      json,
    });
    expect(out.exitCode).toBe(2);
    noNativeEffects();
    if (json) expect(envelope(out).error.code).toBe("T3_INTENT_INVALID");
    else if (boundary === "executor")
      expect(out.error).toMatchObject({ code: "T3_INTENT_INVALID" });
    else expect(out.stderr()).toMatch(/intent/i);
  });
});

describe("issue392 A27 native catalog failure classification", () => {
  test.each(boundaries.flatMap((boundary) => formats.map((json) => ({ boundary, json }))))(
    "$boundary JSON=$json unavailable native options are operational",
    async ({ boundary, json }) => {
      native.preflight.mockRejectedValue(
        new T3HandoffError(
          "T3_OPTIONS_UNSUPPORTED",
          "Native saved options are unavailable in the live catalog.",
        ),
      );
      const out = await invokeSwitch(boundary, target, { path: true, t3: "Task", json });
      expect(out.exitCode).toBe(1);
      expect(native.preflight).toHaveBeenCalledTimes(1);
      expect(native.dispatch).not.toHaveBeenCalled();
      expect(native.launch).not.toHaveBeenCalled();
      if (json) expect(envelope(out).error.code).toBe("T3_OPTIONS_UNSUPPORTED");
    },
  );
});
