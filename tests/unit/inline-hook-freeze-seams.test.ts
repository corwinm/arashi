import { afterEach, describe, expect, test, vi } from "vitest";
import { join, win32 } from "node:path";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  executeInlineHook,
  resolveInlineHookForConsumer,
  resolveInlineHookInterpreter,
  type AvailableInlineHookInterpreterResolution,
  type InlineHookSourceMetadata,
} from "../../src/lib/hooks.ts";

const roots: string[] = [];
const canary = "INLINE_FREEZE_SECRET_6a880a0d_DO_NOT_DISCLOSE";

const availableBashResolution = async (): Promise<AvailableInlineHookInterpreterResolution> => {
  const resolution = await resolveInlineHookInterpreter({
    env: process.env,
    interpreters: { bash: "printf resolver" },
    isExecutableFile: async (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    platform: process.platform,
    realpath,
  });
  expect(resolution.available).toBe(true);
  if (!resolution.available) {
    throw new Error("Expected Bash to be available for inline executor tests");
  }
  return resolution;
};

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "arashi-inline-freeze-"));
  roots.push(root);
  return root;
};

const forbiddenCanaryForms = [
  canary,
  canary.slice(0, 12),
  Buffer.from(canary).toString("base64"),
  createHash("sha256").update(canary).digest("hex"),
];

const assertNoCanaryProjection = (surfaces: Record<string, unknown>): void => {
  for (const [name, surface] of Object.entries(surfaces)) {
    const rendered = typeof surface === "string" ? surface : JSON.stringify(surface);
    for (const forbidden of forbiddenCanaryForms) {
      expect(rendered, `${name} disclosed a raw/hash/base64/truncated canary`).not.toContain(
        forbidden,
      );
    }
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("AC-06 direct shared inline interpreter resolver seam", () => {
  test("records the exact Windows probes and never probes pwsh, aliases, or terminal hosts", async () => {
    const resolve = resolveInlineHookInterpreter;
    const probes: string[] = [];
    const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    const cmd = String.raw`C:\Windows\System32\cmd.exe`;
    const bash = String.raw`D:\Git\bin\bash.exe`;

    const result = await resolve({
      env: {
        PATH: ["", String.raw`D:\Git\bin`, ""].join(win32.delimiter),
        SystemRoot: String.raw`C:\Windows`,
      },
      interpreters: { bash: "echo bash", cmd: "echo cmd", powershell: "Write-Output ps" },
      isExecutableFile: async (path) => {
        probes.push(path);
        return path === bash;
      },
      platform: "win32",
      realpath: async (path) => win32.normalize(path),
    });

    expect(result).toEqual({ available: true, executablePath: bash, interpreter: "bash" });
    expect(probes).toEqual([powershell, cmd, bash]);
    expect(probes.map((path) => win32.basename(path).toLowerCase())).not.toContain("pwsh.exe");
    expect(probes.map((path) => win32.basename(path).toLowerCase())).not.toContain("wt.exe");
    expect(probes.map((path) => win32.basename(path).toLowerCase())).not.toContain("cmd.com");
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["relative", String.raw`Windows`],
    ["drive-relative", String.raw`C:Windows`],
  ])(
    "%s SystemRoot never produces a trusted fixed executable probe",
    async (_label, systemRoot) => {
      const resolve = resolveInlineHookInterpreter;
      const probes: string[] = [];
      const bash = String.raw`D:\Git\bin\bash.exe`;

      const result = await resolve({
        env: { PATH: String.raw`D:\Git\bin`, SystemRoot: systemRoot },
        interpreters: { bash: "echo bash", cmd: "echo cmd", powershell: "Write-Output ps" },
        isExecutableFile: async (path) => {
          probes.push(path);
          return path === bash;
        },
        platform: "win32",
        realpath: async (path) => win32.normalize(path),
      });

      expect(result).toEqual({ available: true, executablePath: bash, interpreter: "bash" });
      expect(probes).toEqual([bash]);
    },
  );

  test("runtime, remove dry-run, and doctor project the same unavailable evidence without execution", async () => {
    const resolveForConsumer = resolveInlineHookForConsumer;
    const evidence = {
      env: { PATH: "/missing" },
      interpreters: { bash: "printf shared" } as const,
      isExecutableFile: async () => false,
      platform: "linux" as NodeJS.Platform,
      realpath: async (path: string) => path,
    };

    const results = await Promise.all(
      (["runtime", "remove-dry-run", "doctor"] as const).map((consumer) =>
        resolveForConsumer({ consumer, ...evidence }),
      ),
    );

    expect(results).toEqual([
      {
        available: false,
        consumer: "runtime",
        errorCode: "HOOK_INTERPRETER_UNAVAILABLE",
        outcome: { hookStatus: "validation_failed", reasonCode: "interpreter_unavailable" },
        reasonCode: "interpreter_unavailable",
      },
      {
        available: false,
        consumer: "remove-dry-run",
        preview: { availability: "unavailable", reasonCode: "interpreter_unavailable" },
        reasonCode: "interpreter_unavailable",
      },
      {
        available: false,
        consumer: "doctor",
        finding: { code: "HOOK_INTERPRETER_UNAVAILABLE", severity: "error" },
        reasonCode: "interpreter_unavailable",
      },
    ]);
  });
});

describe("AC-08 direct inline execution timeout and quiet seam", () => {
  test.each([
    { label: "valid", snippet: "printf exact", timedOut: false, timeout: 30000 },
    { label: "default", snippet: "printf exact", timedOut: false },
    { label: "expired", snippet: "sleep 1", timedOut: true, timeout: 20 },
  ] as const)(
    "$label timeout reaches execution independently of configuration parsing",
    async ({ snippet, timedOut, timeout }) => {
      const execute = executeInlineHook;
      const root = await makeRoot();
      const resolution = await availableBashResolution();
      const stdout = vi.spyOn(process.stdout, "write");
      const stderr = vi.spyOn(process.stderr, "write");
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      const spinnerStart = vi.fn(() => {
        throw new Error("quiet inline execution restarted progress output");
      });
      const spinnerStop = vi.fn(() => {
        throw new Error("quiet inline execution persisted progress output");
      });

      const { result } = await execute({
        context: { hookName: "pre-create", operationData: {}, repoPath: root },
        hookName: "pre-create",
        resolution,
        outputSpinner: {
          isSpinning: true,
          start: spinnerStart,
          stopAndPersist: spinnerStop,
        },
        progress: false,
        quiet: true,
        snippet,
        source: {
          sourceKind: "inline-config",
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
          sourceScriptPath: null,
        },
        timeout,
      });

      expect(result.timedOut).toBe(timedOut);
      expect(result.success).toBe(!timedOut);
      expect(logs).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(spinnerStart).not.toHaveBeenCalled();
      expect(spinnerStop).not.toHaveBeenCalled();
    },
  );

  test("uses the immutable preflight executable and omits its path from TTY attribution", async () => {
    const execute = executeInlineHook;
    const root = await makeRoot();
    const resolution = await availableBashResolution();
    const priorPath = process.env.PATH;
    process.env.PATH = "";
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const execution = await execute({
        context: { hookName: "pre-create", operationData: {}, repoPath: root },
        hookInputMode: "tty",
        hookName: "pre-create",
        quiet: false,
        resolution,
        snippet: ":",
        source: {
          sourceKind: "inline-config",
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
          sourceScriptPath: null,
        },
      });
      expect(execution.result.success).toBe(true);
      const output = logs.mock.calls.flat().join("\n");
      expect(output).toContain(
        "lifecycle=pre-create scope=workspace sourceKind=inline-config sourceOwnerKind=workspace sourceOwnerName=null",
      );
      expect(output).not.toContain(resolution.executablePath);
    } finally {
      process.env.PATH = priorPath;
    }
  });
});

describe("AC-09 additive metadata, exact capture, and exhaustive secrecy seam", () => {
  test("preserves exact stdout/stderr bytes and excludes every snippet projection surface", async () => {
    const execute = executeInlineHook;
    const root = await makeRoot();
    const resolution = await availableBashResolution();
    const persistedPath = join(root, "state.json");
    const source: InlineHookSourceMetadata = {
      sourceKind: "inline-config",
      sourceOwnerKind: "repository",
      sourceOwnerName: "alpha",
      sourceScriptPath: null,
    };

    const execution = await execute({
      context: { hookName: "post-create.alpha", operationData: {}, repoPath: root },
      hookName: "post-create.alpha",
      quiet: true,
      resolution,
      snippet: `printf 'OUT\\n\\n'; printf 'ERR\\n\\n' >&2; : '${canary}'`,
      source,
      timeout: 1000,
    });
    await writeFile(persistedPath, JSON.stringify({ outcome: execution.outcome }));

    expect(execution.result.stdout).toBe("OUT\n\n");
    expect(execution.result.stderr).toBe("ERR\n\n");
    expect(execution.outcome).toMatchObject({ hookName: "post-create.alpha", ...source });

    const projection = {
      environment: execution.outcome.environment,
      errors: execution.outcome.errors,
      findings: execution.outcome.findings,
      logs: execution.outcome.logs,
      outcomes: [execution.outcome],
      persistedState: await readFile(persistedPath, "utf8"),
      previews: execution.outcome.previews,
      stderr: execution.result.stderr,
      stdout: execution.result.stdout,
    };
    assertNoCanaryProjection(projection);
  });
});
