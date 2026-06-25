import {
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

  test("prints direct-binary manual guidance without mutating", async () => {
    const logs: string[] = [];

    await runDirectUpdate(
      { dryRun: true },
      {
        currentVersion: "1.0.0",
        fetchImpl: async () => createResponse("2.0.0") as unknown as Response,
        log: (message) => logs.push(message),
      },
    );

    const output = logs.join("\n");
    expect(output).toContain("Update available");
    expect(output).toContain("Automatic update is not available");
    expect(output).toContain("Dry run");
  });
});
