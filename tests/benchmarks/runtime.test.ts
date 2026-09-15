import { describe, expect, test, vi } from "vitest";
import { buildRuntime, cliRuntime, nodeRuntime } from "../../scripts/benchmark/runtime.ts";

describe("benchmark runtime metadata", () => {
  test("reports the PATH Bun compiler version without claiming an embedded runtime version", async () => {
    await expect(
      buildRuntime(false, async () => ({ exitCode: 0, stderr: "", stdout: "1.3.10\n" })),
    ).resolves.toEqual({
      method: "bun-version-path-probe",
      name: "bun",
      version: { available: true, value: "1.3.10" },
    });
    expect(cliRuntime(false)).toEqual({
      method: "compiled-executable",
      name: "bun",
      version: {
        available: false,
        reason:
          "The embedded Bun runtime version is not introspected from the compiled executable.",
      },
    });
  });

  test("marks compiler metadata unavailable when source mode does not build an executable", async () => {
    const probe = vi.fn();
    await expect(buildRuntime(true, probe)).resolves.toEqual({
      method: "not-applicable-source-mode",
      name: "bun",
      version: {
        available: false,
        reason: "Source mode does not build or invoke the Arashi executable.",
      },
    });
    expect(probe).not.toHaveBeenCalled();
    expect(cliRuntime(true)).toEqual(nodeRuntime("node-source"));
  });

  test("marks failed and empty Bun version probes explicitly unavailable", async () => {
    await expect(
      buildRuntime(false, async () => {
        throw new Error("spawn bun ENOENT");
      }),
    ).resolves.toEqual({
      method: "bun-version-path-probe",
      name: "bun",
      version: {
        available: false,
        reason: "Bun version probe failed: Error: spawn bun ENOENT",
      },
    });
    await expect(
      buildRuntime(false, async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    ).resolves.toEqual({
      method: "bun-version-path-probe",
      name: "bun",
      version: { available: false, reason: "Bun version probe returned no version." },
    });
  });
});
