import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  artifactIdentity,
  buildRuntime,
  type BuildProvenanceRecord,
} from "../../scripts/benchmark/provenance.ts";

const temporaryPaths: string[] = [];

async function fixtureArtifact(contents = "arashi-binary") {
  const directory = await mkdtemp(join(tmpdir(), "arashi-provenance-test-"));
  temporaryPaths.push(directory);
  const executablePath = join(directory, "arashi.bin");
  await writeFile(executablePath, contents);
  return { directory, executablePath };
}

async function writeRecord(path: string, record: BuildProvenanceRecord): Promise<void> {
  await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true, maxRetries: 3, retryDelay: 10 })),
  );
});

describe("benchmark build provenance", () => {
  test("accepts compiler metadata only when the record matches the exact executable", async () => {
    const { directory, executablePath } = await fixtureArtifact();
    const identity = await artifactIdentity(executablePath);
    const provenancePath = join(directory, "provenance.json");
    await writeRecord(provenancePath, {
      artifact: identity,
      compiler: { name: "bun", version: "1.3.14" },
      schemaVersion: 1,
    });

    await expect(buildRuntime(false, executablePath, provenancePath)).resolves.toEqual({
      method: "verified-artifact-provenance",
      name: "bun",
      version: { available: true, value: "1.3.14" },
    });
  });

  test.each([
    ["missing", undefined],
    ["mismatched", "mismatch"],
  ])("marks %s provenance unavailable", async (_name, mismatch) => {
    const { directory, executablePath } = await fixtureArtifact();
    const provenancePath = mismatch ? join(directory, "provenance.json") : undefined;
    if (provenancePath) {
      const identity = await artifactIdentity(executablePath);
      await writeRecord(provenancePath, {
        artifact: { ...identity, sha256: "0".repeat(64) },
        compiler: { name: "bun", version: "99.0.0-from-path" },
        schemaVersion: 1,
      });
    }

    const runtime = await buildRuntime(false, executablePath, provenancePath);
    expect(runtime).toEqual({
      method: "unavailable-artifact-provenance",
      name: "bun",
      version: {
        available: false,
        reason: mismatch
          ? "Build provenance does not match the benchmark executable."
          : "No build provenance was supplied; compiler version is unavailable.",
      },
    });
    expect(JSON.stringify(runtime)).not.toContain("99.0.0-from-path");
  });

  test("computes a stable path-neutral artifact identity", async () => {
    const first = await fixtureArtifact("same executable bytes");
    const second = await fixtureArtifact("same executable bytes");
    const expectedHash = createHash("sha256").update("same executable bytes").digest("hex");

    await expect(artifactIdentity(first.executablePath)).resolves.toEqual({
      filename: "arashi.bin",
      sha256: expectedHash,
      sizeBytes: 21,
    });
    expect(await artifactIdentity(second.executablePath)).toEqual(
      await artifactIdentity(first.executablePath),
    );
  });

  test("preserves source mode without reading build provenance", async () => {
    const runtime = await buildRuntime(true, "/does/not/exist", "/does/not/exist.json");
    expect(runtime).toEqual({
      method: "not-applicable-source-mode",
      name: "bun",
      version: {
        available: false,
        reason: "Source mode does not build or invoke the Arashi executable.",
      },
    });
  });
});
