import { describe, expect, test } from "bun:test";
import { classifyRemoteTrackingFetchFailure } from "../../src/lib/git-remote.ts";

describe("classifyRemoteTrackingFetchFailure", () => {
  test("classifies missing remote refs and normalizes the message", () => {
    const result = classifyRemoteTrackingFetchFailure(
      "Git command failed: fatal: couldn't find remote ref refs/heads/feature-123",
      {
        branch: "feature-123",
        remote: "origin",
        upstream: "origin/feature-123",
      },
    );

    expect(result).toEqual({
      error: "Git command failed: fatal: couldn't find remote ref refs/heads/feature-123",
      kind: "missing-remote-ref",
      message: "couldn't find remote ref refs/heads/feature-123",
      ok: false,
    });
  });

  test("keeps generic fetch failures as generic warnings", () => {
    const result = classifyRemoteTrackingFetchFailure(
      "Git command failed: authentication required",
      {
        branch: "main",
        remote: "origin",
        upstream: "origin/main",
      },
    );

    expect(result).toEqual({
      error: "Git command failed: authentication required",
      kind: "generic",
      message: "Git command failed: authentication required",
      ok: false,
    });
  });
});
