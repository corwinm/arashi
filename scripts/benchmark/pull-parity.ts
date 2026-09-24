import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Sample = { behavior: Record<string, unknown>; stdout: string };
type Case = {
  id: string;
  fixture: Record<string, unknown>;
  command: { argv: string[]; cwd: string; method: string; remote: string };
  timing: { warmup: number; iterations: number; medianMs: number; p95Ms: number };
  samples: Sample[];
};
type Artifact = {
  cases: Case[];
  host: { os: string; arch: string };
  runtime: { invocation: unknown };
  artifact: { sha256: string };
};

function comparable(sample: Sample) {
  const behavior = sample.behavior as {
    results?: { elapsedSeconds?: number }[];
    managedIgnore?: { targetPath?: string };
  };
  const target = behavior.managedIgnore?.targetPath;
  if (!target) throw new Error("Missing fixture-owned managed-ignore targetPath");
  const fixtureRoot = target.replace(/\/workspace\/\.git\/info\/exclude$/, "");
  if (fixtureRoot === target) throw new Error("Unexpected fixture targetPath");
  // Preserve every field. Replace only the fixture's temporary root and measured durations.
  const normalize = (value: unknown, key = ""): unknown => {
    if (key === "elapsedSeconds") return "<measured-duration>";
    if (typeof value === "string")
      return value
        .split(fixtureRoot)
        .join("<fixture-root>")
        .split(fixtureRoot.replace(/^\/private(?=\/var\/)/, ""))
        .join("<fixture-root>");
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, normalize(item, name)]),
      );
    return value;
  };
  const envelope = JSON.parse(sample.stdout) as { data?: unknown; command?: string; ok?: boolean };
  if (JSON.stringify(envelope.data) !== JSON.stringify(sample.behavior))
    throw new Error("stdout/behavior mismatch");
  return normalize(envelope);
}

function assertEqual(base: unknown, candidate: unknown, path: string) {
  if (base && candidate && typeof base === "object" && typeof candidate === "object") {
    const a = Object.keys(base),
      b = Object.keys(candidate);
    if (JSON.stringify(a.toSorted()) !== JSON.stringify(b.toSorted()))
      throw new Error(`${path}: keys differ`);
    for (const key of a)
      assertEqual(
        (base as Record<string, unknown>)[key],
        (candidate as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
  } else if (base !== candidate)
    throw new Error(`${path}: ${JSON.stringify(base)} != ${JSON.stringify(candidate)}`);
}

export function comparePullArtifacts(base: Artifact, candidate: Artifact) {
  assertEqual(base.host.os, candidate.host.os, "host.os");
  assertEqual(base.host.arch, candidate.host.arch, "host.arch");
  assertEqual(base.runtime.invocation, candidate.runtime.invocation, "runtime.invocation");
  if (base.artifact.sha256 === candidate.artifact.sha256)
    throw new Error("Identical binaries cannot establish speedup");
  assertEqual(
    base.cases.map((entry) => entry.id),
    candidate.cases.map((entry) => entry.id),
    "cases",
  );
  return base.cases.map((entry, index) => {
    const other = candidate.cases[index]!;
    assertEqual(entry.fixture, other.fixture, `${entry.id}.fixture`);
    assertEqual(
      [entry.command.cwd, entry.command.method, entry.command.remote],
      [other.command.cwd, other.command.method, other.command.remote],
      `${entry.id}.boundary`,
    );
    assertEqual(entry.command.argv, ["pull", "--json"], `${entry.id}.base.argv`);
    assertEqual(
      other.command.argv,
      ["pull", "--json", "--jobs", "4"],
      `${entry.id}.candidate.argv`,
    );
    assertEqual(
      [entry.timing.warmup, entry.timing.iterations],
      [other.timing.warmup, other.timing.iterations],
      `${entry.id}.iterations`,
    );
    if (entry.samples.length !== other.samples.length)
      throw new Error(`${entry.id}.samples length differs`);
    // Sorting samples by wall-time does not pair equivalent iterations. Each sample must
    // agree with the canonical first sample on its own side and across both binaries.
    const reference = comparable(entry.samples[0]!);
    for (const [side, samples] of [
      ["base", entry.samples],
      ["candidate", other.samples],
    ] as const)
      for (const [sampleIndex, sample] of samples.entries())
        assertEqual(reference, comparable(sample), `${entry.id}.${side}.samples[${sampleIndex}]`);
    return {
      id: entry.id,
      baseMedianMs: entry.timing.medianMs,
      candidateMedianMs: other.timing.medianMs,
      baseP95Ms: entry.timing.p95Ms,
      candidateP95Ms: other.timing.p95Ms,
      medianSpeedup: entry.timing.medianMs / other.timing.medianMs,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4)
    throw new Error("Usage: node pull-parity.ts BASE.json CANDIDATE.json");
  const base = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  const candidate = JSON.parse(await readFile(process.argv[3]!, "utf8"));
  console.log(JSON.stringify(comparePullArtifacts(base, candidate), null, 2));
}
