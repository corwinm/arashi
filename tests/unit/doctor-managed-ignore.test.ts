import { describe, expect, test } from "vitest";
import { managedIgnoreToDoctorFindings } from "../../src/lib/doctor.ts";

describe("doctor managed ignore findings", () => {
  test("reports missing, unsafe, and stale state with stable codes", () => {
    const findings = managedIgnoreToDoctorFindings({
      localExcludePath: "/workspace/.git/info/exclude",
      paths: [
        { input: "repos", rule: "repos/", safety: "safe", status: "unignored" },
        {
          input: "../worktrees",
          safety: "unsafe",
          safetyReason: "parent-traversal",
          status: "unsafe",
        },
      ],
      scope: "local",
      staleRules: [{ path: "/workspace/.git/info/exclude", rule: "old-repos/", target: "local" }],
      storedPreference: null,
      trackedIgnorePath: "/workspace/.gitignore",
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "MANAGED_IGNORE_MISSING",
      "MANAGED_IGNORE_UNSAFE_PATH",
      "MANAGED_IGNORE_STALE_RULE",
    ]);
  });
});
