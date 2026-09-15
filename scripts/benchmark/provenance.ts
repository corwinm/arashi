import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { RuntimeMetadata } from "./runtime.ts";

export const PROVENANCE_ENVIRONMENT_VARIABLE = "ARASHI_BENCHMARK_PROVENANCE";

export interface ArtifactIdentity {
  filename: string;
  sha256: string;
  sizeBytes: number;
}

export interface BuildProvenanceRecord {
  artifact: ArtifactIdentity;
  compiler: { name: "bun"; version: string };
  schemaVersion: 1;
}

export interface ArtifactMetadata extends Partial<ArtifactIdentity> {
  available: boolean;
  reason?: string;
}

export async function artifactIdentity(executablePath: string): Promise<ArtifactIdentity> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executablePath)) hash.update(chunk);
  return {
    filename: basename(executablePath),
    sha256: hash.digest("hex"),
    sizeBytes: (await stat(executablePath)).size,
  };
}

export async function writeBuildProvenance(
  provenancePath: string,
  executablePath: string,
  compilerVersion: string,
): Promise<void> {
  const record: BuildProvenanceRecord = {
    artifact: await artifactIdentity(executablePath),
    compiler: { name: "bun", version: compilerVersion },
    schemaVersion: 1,
  };
  await writeFile(provenancePath, `${JSON.stringify(record)}\n`, "utf8");
}

function unavailableBuild(reason: string): RuntimeMetadata {
  return {
    method: "unavailable-artifact-provenance",
    name: "bun",
    version: { available: false, reason },
  };
}

function isArtifactIdentity(value: unknown): value is ArtifactIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArtifactIdentity>;
  return (
    typeof candidate.filename === "string" &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.sha256) &&
    typeof candidate.sizeBytes === "number" &&
    Number.isSafeInteger(candidate.sizeBytes) &&
    candidate.sizeBytes >= 0
  );
}

function isBuildProvenanceRecord(value: unknown): value is BuildProvenanceRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BuildProvenanceRecord>;
  return (
    candidate.schemaVersion === 1 &&
    isArtifactIdentity(candidate.artifact) &&
    candidate.compiler?.name === "bun" &&
    typeof candidate.compiler.version === "string" &&
    candidate.compiler.version.trim().length > 0
  );
}

export async function buildRuntime(
  source: boolean,
  executablePath: string,
  provenancePath?: string,
): Promise<RuntimeMetadata> {
  if (source) {
    return {
      method: "not-applicable-source-mode",
      name: "bun",
      version: {
        available: false,
        reason: "Source mode does not build or invoke the Arashi executable.",
      },
    };
  }
  if (!provenancePath) {
    return unavailableBuild("No build provenance was supplied; compiler version is unavailable.");
  }

  let record: unknown;
  try {
    record = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch {
    return unavailableBuild("Build provenance could not be read or parsed.");
  }
  if (!isBuildProvenanceRecord(record)) {
    return unavailableBuild("Build provenance has an unsupported format.");
  }

  let actual: ArtifactIdentity;
  try {
    actual = await artifactIdentity(executablePath);
  } catch {
    return unavailableBuild(
      "The benchmark executable could not be hashed for provenance verification.",
    );
  }
  if (
    record.artifact.filename !== actual.filename ||
    record.artifact.sha256 !== actual.sha256 ||
    record.artifact.sizeBytes !== actual.sizeBytes
  ) {
    return unavailableBuild("Build provenance does not match the benchmark executable.");
  }
  return {
    method: "verified-artifact-provenance",
    name: "bun",
    version: { available: true, value: record.compiler.version },
  };
}

export async function artifactMetadata(
  source: boolean,
  executablePath: string,
): Promise<ArtifactMetadata> {
  if (source) {
    return { available: false, reason: "Source mode has no Arashi executable artifact." };
  }
  try {
    return { available: true, ...(await artifactIdentity(executablePath)) };
  } catch {
    return { available: false, reason: "The benchmark executable identity could not be read." };
  }
}
