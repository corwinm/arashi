import {
  buildInstallerUpdatePlan,
  compareVersions,
  createCommand,
  fetchLatestRelease,
  runDirectUpdate,
} from "../../../src/commands/update.ts";
import { describe, expect, test } from "bun:test";

interface MockResponse {
  json: () => Promise<{ html_url: string; tag_name: string }>;
  ok: boolean;
  status: number;
  statusText: string;
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

  test("builds installer update plan for curl-installed binaries", () => {
    const plan = buildInstallerUpdatePlan("2.0.0", "/home/user/.arashi/bin/arashi");

    expect(plan.command).toBe("bash");
    expect(plan.args.join(" ")).toContain("https://arashi.haphazard.dev/install");
    expect(plan.env.ARASHI_VERSION).toBe("2.0.0");
    expect(plan.env.ARASHI_INSTALL_DIR).toBe("/home/user/.arashi/bin");
    expect(plan.env.ARASHI_SHELL_INTEGRATION).toBe("no");
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
      },
    );

    const output = logs.join("\n");
    expect(output).toContain("Update available");
    expect(output).toContain("official curl installer");
    expect(output).toContain("/home/user/.arashi/bin");
    expect(output).toContain("Dry run");
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
});
