import {
  buildInstallerUpdatePlan,
  compareVersions,
  createCommand,
  fetchLatestRelease,
  runDirectUpdate,
} from "../../../src/commands/update.ts";
import { describe, expect, test, vi } from "vitest";

interface MockResponse {
  headers?: Headers;
  json: () => Promise<{ html_url: string; tag_name: string }>;
  ok: boolean;
  status: number;
  statusText: string;
}

interface RateLimitCase {
  body: unknown;
  headers: Record<string, string>;
  name: string;
  signal: "primary" | "secondary";
  status: 403 | 429;
}

function createResponse(version: string): MockResponse {
  return {
    json: async () => ({
      html_url: "https://github.com/corwinm/arashi/releases/tag/v2.0.0",
      tag_name: `v${version}`,
    }),
    ok: true,
    status: 200,
    statusText: "OK",
  };
}

function createFailedResponse(
  status: number,
  statusText: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Response {
  return {
    headers: new Headers(options.headers),
    json: async () => options.body ?? {},
    ok: false,
    status,
    statusText,
  } as Response;
}

const windowsInstallDir = ["C:", "Users", "me", ".arashi", "bin"].join("\\");
const windowsExecPath = [windowsInstallDir, "arashi.bin.exe"].join("\\");

describe("update command", () => {
  test("registers visible options", () => {
    const command = createCommand("1.0.0");

    expect(command.name()).toBe("update");
    expect(command.description()).toContain("updates");
    expect(command.helpInformation()).toContain("--check");
    expect(command.helpInformation()).toContain("--dry-run");
    expect(command.helpInformation()).toContain("--yes");
  });

  test("compares versions", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "v1.0.0")).toBe(0);
  });

  test("fetches latest GitHub release with injectable fetch", async () => {
    const release = await fetchLatestRelease(
      async () => createResponse("2.0.0") as unknown as Response,
    );

    expect(release).toEqual({
      htmlUrl: "https://github.com/corwinm/arashi/releases/tag/v2.0.0",
      version: "2.0.0",
    });
  });

  test.each([
    {
      body: {},
      headers: { "x-ratelimit-remaining": "0" },
      name: "primary 403",
      signal: "primary",
      status: 403,
    },
    {
      body: {},
      headers: { "x-ratelimit-remaining": "0" },
      name: "primary 429",
      signal: "primary",
      status: 429,
    },
    {
      body: {},
      headers: { "retry-after": "60" },
      name: "secondary-header 403",
      signal: "secondary",
      status: 403,
    },
    {
      body: {},
      headers: { "retry-after": "60" },
      name: "secondary-header 429",
      signal: "secondary",
      status: 429,
    },
    {
      body: { message: "You have exceeded a secondary rate limit." },
      headers: {},
      name: "secondary-message 403",
      signal: "secondary",
      status: 403,
    },
    {
      body: { message: "You have exceeded a SECONDARY RATE LIMIT. Please wait." },
      headers: {},
      name: "secondary-message 429",
      signal: "secondary",
      status: 429,
    },
  ] satisfies RateLimitCase[])(
    "classifies GitHub $name rate-limit responses",
    async ({ body, headers, signal, status }) => {
      await expect(
        fetchLatestRelease(async () =>
          createFailedResponse(status, status === 403 ? "Forbidden" : "Too Many Requests", {
            body,
            headers: headers as Record<string, string>,
          }),
        ),
      ).rejects.toMatchObject({
        code: "GITHUB_RATE_LIMITED",
        details: {
          fallbackAvailable: true,
          signal,
          status,
          versionPinned: false,
        },
      });
    },
  );

  test("keeps generic GitHub 403 responses fail-closed", async () => {
    await expect(
      fetchLatestRelease(async () => createFailedResponse(403, "Forbidden")),
    ).rejects.toThrow("GitHub releases returned 403 Forbidden");
  });

  test("keeps generic GitHub 429 responses fail-closed", async () => {
    await expect(
      fetchLatestRelease(async () =>
        createFailedResponse(429, "Too Many Requests", {
          body: { message: "Slow down" },
        }),
      ),
    ).rejects.toThrow("GitHub releases returned 429 Too Many Requests");
  });

  test("does not offer or run the fallback for a generic GitHub 403", async () => {
    let promptCount = 0;
    let spawnCount = 0;

    await expect(
      runDirectUpdate(
        { yes: true },
        {
          confirmImpl: async () => {
            promptCount += 1;
            return { status: "ok", value: true };
          },
          fetchImpl: async () => createFailedResponse(403, "Forbidden"),
          spawnSyncImpl: (() => {
            spawnCount += 1;
            return { status: 0 };
          }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
        },
      ),
    ).rejects.toThrow("GitHub releases returned 403 Forbidden");
    expect(promptCount).toBe(0);
    expect(spawnCount).toBe(0);
  });

  test("exported direct updater rejects conflicting inspection modes before release lookup", async () => {
    let lookupCount = 0;
    let mutationCount = 0;
    await expect(
      runDirectUpdate(
        { check: true, dryRun: true },
        {
          fetchImpl: async () => {
            lookupCount += 1;
            throw new Error("network sentinel");
          },
          spawnSyncImpl: (() => {
            mutationCount += 1;
            return { status: 0 };
          }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
        },
      ),
    ).rejects.toMatchObject({ code: "UPDATE_INSPECTION_CONFLICT" });
    expect(lookupCount).toBe(0);
    expect(mutationCount).toBe(0);
  });

  test.each([
    ["human long", ["--check", "--dry-run"], false],
    ["human short", ["--check", "-n"], false],
    ["JSON long", ["--check", "--dry-run", "--json"], true],
    ["JSON short", ["--check", "-n", "-j"], true],
    ["JSON apply long", ["--check", "--dry-run", "--json", "--yes"], true],
    ["JSON apply short", ["--check", "-n", "-j", "-y"], true],
  ])("Commander rejects conflicting inspection modes in %s mode", async (_name, argv, json) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk).trim());
      return true;
    });
    const error = vi.spyOn(console, "error").mockImplementation((...values) => {
      stderr.push(values.map(String).join(" "));
    });
    try {
      await createCommand("1.0.0").parseAsync(argv as string[], { from: "user" });
      expect(process.exitCode).toBe(2);
      if (json) {
        expect(stderr).toEqual([]);
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0])).toMatchObject({
          command: "update",
          error: { code: "UPDATE_INSPECTION_CONFLICT" },
          ok: false,
        });
      } else {
        expect(stdout).toEqual([]);
        expect(stderr.join("\n")).toContain("--check cannot be combined with --dry-run");
      }
    } finally {
      output.mockRestore();
      error.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  test("builds installer update plan for POSIX direct binaries", () => {
    const plan = buildInstallerUpdatePlan("2.0.0", "/home/user/.arashi/bin/arashi", {
      platform: "linux",
    });

    expect(plan.command).toBe("bash");
    expect(plan.args.join(" ")).toContain("https://arashi.haphazard.dev/install");
    expect(plan.deferred).toBe(false);
    expect(plan.env.ARASHI_VERSION).toBe("2.0.0");
    expect(plan.env.ARASHI_INSTALL_DIR).toBe("/home/user/.arashi/bin");
    expect(plan.env.ARASHI_SHELL_INTEGRATION).toBe("no");
    expect(plan.label).toContain("POSIX");
  });

  test("builds an unpinned POSIX installer fallback plan", () => {
    const plan = buildInstallerUpdatePlan(undefined, "/home/user/.arashi/bin/arashi", {
      platform: "linux",
    });

    expect(plan.env).not.toHaveProperty("ARASHI_VERSION");
    expect(plan.env.ARASHI_INSTALL_DIR).toBe("/home/user/.arashi/bin");
    expect(plan.env.ARASHI_SHELL_INTEGRATION).toBe("no");
  });

  test("builds installer update plan for Windows PowerShell direct binaries", () => {
    const plan = buildInstallerUpdatePlan("2.0.0", windowsExecPath, {
      parentProcessId: 1234,
      platform: "win32",
    });

    expect(plan.command).toBe("powershell");
    expect(plan.args).toEqual([
      "-NoProfile",
      "-c",
      "Start-Process -FilePath powershell -ArgumentList @('-NoProfile', '-c', 'irm https://arashi.haphazard.dev/install.ps1 | iex') -NoNewWindow",
    ]);
    expect(plan.deferred).toBe(true);
    expect(plan.env.ARASHI_VERSION).toBe("2.0.0");
    expect(plan.env.ARASHI_INSTALL_DIR).toBe(windowsInstallDir);
    expect(plan.env.ARASHI_NO_MODIFY_PATH).toBe("1");
    expect(plan.env.ARASHI_WAIT_FOR_PID).toBe("1234");
    expect(plan.label).toContain("PowerShell");
  });

  test("builds an unpinned deferred Windows installer fallback plan", () => {
    const plan = buildInstallerUpdatePlan(undefined, windowsExecPath, {
      parentProcessId: 1234,
      platform: "win32",
    });

    expect(plan.env).not.toHaveProperty("ARASHI_VERSION");
    expect(plan.env.ARASHI_INSTALL_DIR).toBe(windowsInstallDir);
    expect(plan.env.ARASHI_NO_MODIFY_PATH).toBe("1");
    expect(plan.env.ARASHI_WAIT_FOR_PID).toBe("1234");
  });

  test("prompts and runs an unpinned installer after primary rate limiting", async () => {
    const logs: string[] = [];
    const prompts: string[] = [];
    const spawnedEnvironments: NodeJS.ProcessEnv[] = [];

    await runDirectUpdate(
      {},
      {
        confirmImpl: async (message) => {
          prompts.push(message);
          return { status: "ok", value: true };
        },
        currentVersion: "1.0.0",
        env: { ...process.env, ARASHI_VERSION: "0.9.0" },
        execPath: "/home/user/.arashi/bin/arashi",
        fetchImpl: async () =>
          createFailedResponse(403, "Forbidden", {
            headers: { "x-ratelimit-remaining": "0" },
          }),
        isInteractive: true,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: ((
          _command: string,
          _args: string[],
          options: { env?: NodeJS.ProcessEnv },
        ) => {
          spawnedEnvironments.push(options.env ?? {});
          return { status: 0 };
        }) as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("without verifying the latest version");
    expect(spawnedEnvironments).toHaveLength(1);
    expect(spawnedEnvironments[0]).not.toHaveProperty("ARASHI_VERSION");
    expect(logs.join("\n")).toContain("GitHub API rate limit");
    expect(logs.join("\n")).toContain("latest-release installer attempt completed");
    expect(logs.join("\n")).not.toContain("v0.9.0");
  });

  test("uses --yes without prompting for a message-identified 429 fallback", async () => {
    let promptCount = 0;
    let spawnCount = 0;

    await runDirectUpdate(
      { yes: true },
      {
        confirmImpl: async () => {
          promptCount += 1;
          return { status: "ok", value: false };
        },
        currentVersion: "1.0.0",
        fetchImpl: async () =>
          createFailedResponse(429, "Too Many Requests", {
            body: { message: "You have exceeded a secondary rate limit." },
          }),
        log: () => {},
        platform: "linux",
        spawnSyncImpl: (() => {
          spawnCount += 1;
          return { status: 0 };
        }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(promptCount).toBe(0);
    expect(spawnCount).toBe(1);
  });

  test("removes an inherited version from a deferred Windows fallback spawn", async () => {
    const logs: string[] = [];
    const spawnedEnvironments: NodeJS.ProcessEnv[] = [];

    await runDirectUpdate(
      { yes: true },
      {
        env: { ...process.env, arashi_version: "0.9.0" },
        execPath: windowsExecPath,
        fetchImpl: async () =>
          createFailedResponse(403, "Forbidden", {
            headers: { "x-ratelimit-remaining": "0" },
          }),
        log: (message) => logs.push(message),
        platform: "win32",
        spawnSyncImpl: ((
          _command: string,
          _args: string[],
          options: { env?: NodeJS.ProcessEnv },
        ) => {
          spawnedEnvironments.push(options.env ?? {});
          return { status: 0 };
        }) as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(spawnedEnvironments).toHaveLength(1);
    expect(Object.keys(spawnedEnvironments[0]).map((key) => key.toUpperCase())).not.toContain(
      "ARASHI_VERSION",
    );
    expect(logs.join("\n")).toContain("Scheduled the Arashi latest-release installer attempt");
    expect(logs.join("\n")).not.toContain("v0.9.0");
  });

  test.each([
    ["declined", { status: "ok", value: false } as const],
    ["cancelled", { reason: "exit", status: "cancelled" } as const],
  ])("does not mutate when a rate-limit fallback is %s", async (_name, confirmation) => {
    let spawnCount = 0;

    await runDirectUpdate(
      {},
      {
        confirmImpl: async () => confirmation,
        fetchImpl: async () =>
          createFailedResponse(403, "Forbidden", {
            headers: { "x-ratelimit-remaining": "0" },
          }),
        isInteractive: true,
        log: () => {},
        platform: "linux",
        spawnSyncImpl: (() => {
          spawnCount += 1;
          return { status: 0 };
        }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(spawnCount).toBe(0);
  });

  test("requires --yes for a non-interactive rate-limit fallback", async () => {
    const logs: string[] = [];
    let spawnCount = 0;

    await runDirectUpdate(
      {},
      {
        fetchImpl: async () =>
          createFailedResponse(403, "Forbidden", {
            headers: { "x-ratelimit-remaining": "0" },
          }),
        isInteractive: false,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: (() => {
          spawnCount += 1;
          return { status: 0 };
        }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(spawnCount).toBe(0);
    expect(logs.join("\n")).toContain("Rerun with --yes");
  });

  test("keeps human dry-run non-mutating while showing the unpinned fallback plan", async () => {
    const logs: string[] = [];
    let promptCount = 0;
    let spawnCount = 0;

    await runDirectUpdate(
      { dryRun: true },
      {
        confirmImpl: async () => {
          promptCount += 1;
          return { status: "ok", value: true };
        },
        fetchImpl: async () =>
          createFailedResponse(403, "Forbidden", { headers: { "retry-after": "60" } }),
        isInteractive: true,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: (() => {
          spawnCount += 1;
          return { status: 0 };
        }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(promptCount).toBe(0);
    expect(spawnCount).toBe(0);
    expect(logs.join("\n")).toContain("Unpinned latest-release attempt");
    expect(logs.join("\n")).toContain("Dry run");
  });

  test("keeps human check mode fail-closed after rate limiting", async () => {
    let spawnCount = 0;

    await expect(
      runDirectUpdate(
        { check: true },
        {
          fetchImpl: async () =>
            createFailedResponse(403, "Forbidden", {
              headers: { "x-ratelimit-remaining": "0" },
            }),
          spawnSyncImpl: (() => {
            spawnCount += 1;
            return { status: 0 };
          }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
        },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
    expect(spawnCount).toBe(0);
  });

  test.each([["--json"], ["--json", "--check"], ["--json", "--dry-run"]])(
    "returns the typed JSON rate-limit error for %s",
    async (...argv) => {
      const stdout: string[] = [];
      const originalExitCode = process.exitCode;
      process.exitCode = undefined;
      const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout.push(String(chunk).trim());
        return true;
      });
      try {
        await createCommand("1.0.0", {
          fetchImpl: async () =>
            createFailedResponse(403, "Forbidden", {
              headers: { "x-ratelimit-remaining": "0" },
            }),
        }).parseAsync(argv, { from: "user" });

        expect(process.exitCode).toBe(1);
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0])).toMatchObject({
          command: "update",
          error: {
            code: "GITHUB_RATE_LIMITED",
            details: {
              fallbackAvailable: true,
              signal: "primary",
              status: 403,
              versionPinned: false,
            },
          },
          ok: false,
        });
      } finally {
        output.mockRestore();
        process.exitCode = originalExitCode;
      }
    },
  );

  test("serializes a message-identified secondary 429 in JSON", async () => {
    const stdout: string[] = [];
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk).trim());
      return true;
    });
    try {
      await createCommand("1.0.0", {
        fetchImpl: async () =>
          createFailedResponse(429, "Too Many Requests", {
            body: { message: "You have exceeded a secondary rate limit." },
          }),
      }).parseAsync(["--json"], { from: "user" });

      expect(process.exitCode).toBe(1);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toMatchObject({
        command: "update",
        error: {
          code: "GITHUB_RATE_LIMITED",
          details: {
            fallbackAvailable: true,
            signal: "secondary",
            status: 429,
            versionPinned: false,
          },
        },
        ok: false,
      });
    } finally {
      output.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  test("prints installer update plan without mutating", async () => {
    const logs: string[] = [];

    await runDirectUpdate(
      { dryRun: true },
      {
        currentVersion: "1.0.0",
        execPath: "/home/user/.arashi/bin/arashi",
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        log: (message) => logs.push(message),
        platform: "linux",
      },
    );

    const output = logs.join("\n");
    expect(output).toContain("Update available");
    expect(output).toContain("official POSIX installer");
    expect(output).toContain("/home/user/.arashi/bin");
    expect(output).toContain("Dry run");
  });

  test("bare JSON is inspection-only in an interactive direct update", async () => {
    const logs: string[] = [];
    let mutationCount = 0;
    let promptCount = 0;

    await runDirectUpdate(
      { json: true },
      {
        confirmImpl: async () => {
          promptCount += 1;
          return { status: "ok", value: true };
        },
        currentVersion: "1.0.0",
        execPath: "/home/user/.arashi/bin/arashi",
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        isInteractive: true,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: (() => {
          mutationCount += 1;
          return { status: 0 };
        }) as unknown as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(promptCount).toBe(0);
    expect(mutationCount).toBe(0);
    expect(logs).toContain("JSON inspection: no changes made.");
  });

  test("prompts before running official installer in interactive direct-binary updates", async () => {
    const logs: string[] = [];
    const calls: { args: string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const prompts: string[] = [];

    await runDirectUpdate(
      {},
      {
        confirmImpl: async (message) => {
          prompts.push(message);
          return { status: "ok", value: true };
        },
        currentVersion: "1.0.0",
        execPath: "/home/user/.arashi/bin/arashi",
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        isInteractive: true,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ args, command, env: options.env });
          return { status: 0 };
        }) as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(prompts).toEqual(["Apply arashi update to v2.0.0?"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("bash");
    expect(logs.join("\n")).toContain("Updated arashi to v2.0.0");
  });

  test("skips direct-binary update when interactive confirmation is declined", async () => {
    const logs: string[] = [];
    const calls: { args: string[]; command: string }[] = [];

    await runDirectUpdate(
      {},
      {
        confirmImpl: async () => ({ status: "ok", value: false }),
        currentVersion: "1.0.0",
        execPath: "/home/user/.arashi/bin/arashi",
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        isInteractive: true,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: ((command: string, args: string[]) => {
          calls.push({ args, command });
          return { status: 0 };
        }) as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("Update skipped");
  });

  test("keeps non-interactive direct-binary updates opt-in with --yes", async () => {
    const logs: string[] = [];
    const calls: { args: string[]; command: string }[] = [];
    const prompts: string[] = [];

    await runDirectUpdate(
      {},
      {
        confirmImpl: async (message) => {
          prompts.push(message);
          return { status: "ok", value: true };
        },
        currentVersion: "1.0.0",
        execPath: "/home/user/.arashi/bin/arashi",
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        isInteractive: false,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: ((command: string, args: string[]) => {
          calls.push({ args, command });
          return { status: 0 };
        }) as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(prompts).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("Rerun with --yes");
  });

  test("runs official installer when confirmed", async () => {
    const logs: string[] = [];
    const calls: { args: string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];

    await runDirectUpdate(
      { yes: true },
      {
        currentVersion: "1.0.0",
        execPath: "/home/user/.arashi/bin/arashi",
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        log: (message) => logs.push(message),
        platform: "linux",
        spawnSyncImpl: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ args, command, env: options.env });
          return { status: 0 };
        }) as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("bash");
    expect(calls[0].args.join(" ")).toContain("arashi.haphazard.dev/install");
    expect(calls[0].env?.ARASHI_INSTALL_DIR).toBe("/home/user/.arashi/bin");
    expect(calls[0].env?.ARASHI_VERSION).toBe("2.0.0");
    expect(logs.join("\n")).toContain("Updated arashi to v2.0.0");
  });

  test("schedules Windows PowerShell installer when confirmed", async () => {
    const logs: string[] = [];
    const calls: { args: string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];

    await runDirectUpdate(
      { yes: true },
      {
        currentVersion: "1.0.0",
        execPath: windowsExecPath,
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        log: (message) => logs.push(message),
        platform: "win32",
        spawnSyncImpl: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ args, command, env: options.env });
          return { status: 0 };
        }) as NonNullable<Parameters<typeof runDirectUpdate>[1]>["spawnSyncImpl"],
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("powershell");
    expect(calls[0].args.join(" ")).toContain("Start-Process");
    expect(calls[0].args.join(" ")).toContain("install.ps1");
    expect(calls[0].env?.ARASHI_INSTALL_DIR).toBe(windowsInstallDir);
    expect(calls[0].env?.ARASHI_NO_MODIFY_PATH).toBe("1");
    expect(calls[0].env?.ARASHI_VERSION).toBe("2.0.0");
    expect(calls[0].env?.ARASHI_WAIT_FOR_PID).toBeTruthy();
    expect(logs.join("\n")).toContain("Scheduled arashi update to v2.0.0");
  });
});
