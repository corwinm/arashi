import { expect, test } from "vitest";
import { comparePullArtifacts } from "../../scripts/benchmark/pull-parity.ts";
import base from "../../benchmark-results/pull-baseline.json";

test("baseline records external harness independently of source binary", () => {
  expect(base.binarySourceHead).toBe("ac9a04358db5f6f56143b9ae944322f867eb7ac4");
  expect(base.harnessHead).toBe("e02303ec2025fce4db41d0b8b3f2d585929967ef");
});

test("parity checks fixture, command boundary and all behavioral fields", () => {
  const candidate = structuredClone(base);
  candidate.artifact.sha256 = "candidate-artifact";
  for (const [index, entry] of candidate.cases.entries()) {
    entry.command.argv = ["pull", "--json", "--jobs", "4"];
    for (const sample of entry.samples) {
      sample.behavior.results[0]!.elapsedSeconds += 1;
      sample.stdout = JSON.stringify({ ...JSON.parse(sample.stdout), data: sample.behavior });
    }
    expect(index).toBeLessThan(candidate.cases.length);
  }
  expect(comparePullArtifacts(base, candidate)).toHaveLength(2);
  candidate.cases[0]!.samples[0]!.behavior.results[1]!.status = "skipped";
  candidate.cases[0]!.samples[0]!.stdout = JSON.stringify({
    ...JSON.parse(candidate.cases[0]!.samples[0]!.stdout),
    data: candidate.cases[0]!.samples[0]!.behavior,
  });
  expect(() => comparePullArtifacts(base, candidate)).toThrow(/status/);
  candidate.cases[0]!.samples[0]!.behavior.results[1]!.status = "updated";
  candidate.cases[0]!.fixture.fingerprint = "wrong";
  expect(() => comparePullArtifacts(base, candidate)).toThrow(/fingerprint/);
});
