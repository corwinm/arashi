import { describe, expect, test, vi } from "vitest";

describe("Git invocation trace availability", () => {
  test.each([
    ["missing", Object.assign(new Error("missing"), { code: "ENOENT" })],
    ["unreadable", Object.assign(new Error("unreadable"), { code: "EACCES" })],
  ])("marks a %s trace unavailable", async (_label, error) => {
    const { readGitInvocationTrace } = await import("../../scripts/benchmark/git-trace.ts");

    await expect(
      readGitInvocationTrace("trace.json", vi.fn().mockRejectedValue(error)),
    ).resolves.toEqual(
      expect.objectContaining({
        available: false,
        method: "git-trace2-event-root-sessions",
        reason: expect.stringContaining("Could not read Git trace output"),
      }),
    );
  });

  test("keeps supported instrumentation available when no Git process starts", async () => {
    const { readGitInvocationTrace } = await import("../../scripts/benchmark/git-trace.ts");
    const supportedTrace = `${JSON.stringify({ event: "version", evt: "2", sid: "session" })}\n`;

    await expect(
      readGitInvocationTrace("trace.json", vi.fn().mockResolvedValue(supportedTrace)),
    ).resolves.toEqual({
      available: true,
      count: 0,
      method: "git-trace2-event-root-sessions",
      repositories: [],
    });
  });

  test("attributes root sessions to canonical repositories even when def_repo follows start", async () => {
    const { readGitInvocationTrace } = await import("../../scripts/benchmark/git-trace.ts");
    const trace = [
      { event: "version", sid: "root-a" },
      { argv: ["git", "status"], event: "start", sid: "root-a" },
      { event: "def_repo", sid: "root-a", worktree: "/repo-a" },
      { event: "version", sid: "root-a/child" },
      { argv: ["git", "maintenance"], event: "start", sid: "root-a/child" },
      { event: "version", sid: "root-b" },
      { argv: ["git", "rev-parse"], event: "start", sid: "root-b" },
      { event: "def_repo", sid: "root-b", worktree: "/repo-b" },
      { event: "version", sid: "root-c" },
      { argv: ["git", "--version"], event: "start", sid: "root-c" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    await expect(
      readGitInvocationTrace(
        "trace.json",
        vi.fn().mockResolvedValue(trace),
        async (path) => `/canonical${path}`,
      ),
    ).resolves.toEqual({
      available: true,
      count: 3,
      method: "git-trace2-event-root-sessions",
      repositories: [
        { count: 1, path: "/canonical/repo-a" },
        { count: 1, path: "/canonical/repo-b" },
      ],
      unattributed: {
        count: 1,
        reason: "Trace2 emitted no repository identity for these root sessions.",
      },
    });
  });

  test("counts root fetch starts without reparsing unavailable trace files", async () => {
    const { readGitInvocationTrace } = await import("../../scripts/benchmark/git-trace.ts");
    const trace = [
      { event: "version", sid: "root" },
      { argv: ["git", "fetch", "origin"], event: "start", sid: "root" },
      { event: "def_repo", sid: "root", worktree: "/repo" },
      { argv: ["git", "fetch"], event: "start", sid: "root/child" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    await expect(
      readGitInvocationTrace("trace.json", vi.fn().mockResolvedValue(trace), async (path) => path),
    ).resolves.toMatchObject({ available: true, count: 1, fetchCount: 1 });
  });

  test.each(["", `${JSON.stringify({ unrelated: true })}\n`])(
    "marks unsupported trace contents unavailable",
    async (contents) => {
      const { readGitInvocationTrace } = await import("../../scripts/benchmark/git-trace.ts");

      await expect(
        readGitInvocationTrace("trace.json", vi.fn().mockResolvedValue(contents)),
      ).resolves.toEqual(
        expect.objectContaining({
          available: false,
          method: "git-trace2-event-root-sessions",
          reason: expect.stringContaining("recognized Trace2 events"),
        }),
      );
    },
  );
});
