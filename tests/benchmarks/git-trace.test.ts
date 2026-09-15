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
    });
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
