import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

const jobs = (source: string): string => source.slice(source.indexOf("\njobs:\n") + 7);

const jobIds = (source: string): string[] =>
  [...jobs(source).matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((match) => match[1]);

const job = (source: string, id: string): string => {
  const start = source.search(new RegExp(`^  ${id}:\\s*$`, "m"));
  if (start < 0) return "";
  const remainder = source.slice(start + 1);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
};

const step = (source: string, name: string): string => {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const remainder = source.slice(start + marker.length);
  const next = remainder.indexOf("      - name:");
  return source.slice(start, next < 0 ? undefined : start + marker.length + next);
};

const ordered = (source: string, labels: string[]): boolean => {
  let previous = -1;
  for (const label of labels) {
    const current = source.indexOf(label);
    if (current < 0 || current <= previous) return false;
    previous = current;
  }
  return true;
};

const ciContractErrors = (source: string): string[] => {
  const errors: string[] = [];
  const ids = jobIds(source);
  const expectedIds = [
    "quality",
    "test",
    "hook-input-wrapper",
    "build",
    "windows-installer-acceptance",
    "hook-input-native",
  ];
  const unexpected = ids.filter((id) => !expectedIds.includes(id));
  const missing = expectedIds.filter((id) => !ids.includes(id));
  if (unexpected.length > 0 || missing.length > 0)
    errors.push(
      `topology: expected ${expectedIds.join(", ")}; missing=${missing}; unexpected=${unexpected}`,
    );

  const testJob = job(source, "test");
  if (!testJob.includes("os: [ubuntu-latest, windows-latest]"))
    errors.push("topology: test matrix must expand to Linux and Windows");

  const buildJob = job(source, "build");
  const platforms = [
    ["ubuntu-latest", "bun-linux-x64", "arashi-linux-x64", "build:linux"],
    ["macos-latest", "bun-darwin-arm64", "arashi-macos-arm64", "build:mac"],
    ["windows-latest", "bun-windows-x64", "arashi-windows-x64.exe", "build:windows"],
  ] as const;
  for (const [os, target, artifact, script] of platforms) {
    const entry = new RegExp(
      `- os: ${os}\\s+target: ${target}\\s+artifact: ${artifact.replace(".", "\\.")}\\s+script: ${script}`,
    );
    if (!entry.test(buildJob))
      errors.push(`native matrix: missing ${os}/${target}/${artifact}/${script}`);
  }
  if ((buildJob.match(/^\s+- os:/gm) ?? []).length !== 3)
    errors.push("native matrix: expected exactly three platform entries");
  if (!buildJob.includes("name: Native Build and Acceptance (${{ matrix.os }})"))
    errors.push("topology: consolidated native check name is missing");
  if (!buildJob.includes("runtime: node@24.18.0"))
    errors.push("native acceptance: Node 24 setup must be in the build job");
  if (!buildJob.includes("./bin/${{ matrix.artifact }} --version"))
    errors.push("native acceptance: version smoke check must use the local built binary");
  if (!buildJob.includes("for shell in bash zsh fish"))
    errors.push("native acceptance: bash, zsh, and fish completion smoke checks are missing");
  if (
    !buildJob.includes(
      'node --experimental-strip-types tests/native/materialization-native.ts "bin/${{ matrix.artifact }}"',
    )
  )
    errors.push("native acceptance: materialization must use the local built binary");
  if (buildJob.includes("continue-on-error:"))
    errors.push("failure semantics: native build and acceptance must remain fail-closed");
  for (const name of [
    "Run version and completion checks",
    "Exercise built-CLI materialization safety contract",
  ]) {
    if (/^\s+if:/m.test(step(buildJob, name)))
      errors.push(`failure semantics: ${name} must run on every native matrix entry`);
  }
  if (
    !ordered(buildJob, [
      "- name: Build binary",
      "- name: Run version and completion checks",
      "- name: Exercise built-CLI materialization safety contract",
      "- name: Upload accepted artifact",
    ])
  )
    errors.push(
      "artifact ordering: build, both native acceptances, and upload must be fail-closed",
    );
  if (!buildJob.includes("path: bin/${{ matrix.artifact }}"))
    errors.push("artifact upload: expected the accepted local binary path");

  const consumers = [
    ["hook-input-wrapper", "arashi-linux-x64"],
    ["windows-installer-acceptance", "arashi-windows-x64.exe"],
    ["hook-input-native", "arashi-windows-x64.exe"],
  ] as const;
  for (const [id, artifact] of consumers) {
    const section = job(source, id);
    if (!section.includes("needs: [build]"))
      errors.push(`consumer dependency: ${id} must need build`);
    if (!section.includes(`name: ${artifact}`))
      errors.push(`consumer artifact: ${id} must download ${artifact}`);
  }

  const expandedChecks = 1 + 2 + platforms.length + consumers.length;
  if (expandedChecks !== 9)
    errors.push(`topology: expected 9 expanded checks, got ${expandedChecks}`);
  return errors;
};

describe("CI workflow", () => {
  test("bounds native shell package downloads so tests retain the job timeout budget", () => {
    const installStep = workflow.slice(
      workflow.indexOf("- name: Install native completion shells"),
      workflow.indexOf(
        "- name: Install dependencies",
        workflow.indexOf("- name: Install native completion shells"),
      ),
    );

    expect(installStep).toContain("Acquire::Retries=3");
    expect(installStep).toContain("Acquire::http::Timeout=20");
    expect(installStep).toContain("Acquire::https::Timeout=20");
    expect(installStep).toMatch(/apt-get[^\n]*update/);
    expect(installStep).toMatch(/apt-get[^\n]*install --yes fish zsh/);
  });

  test("consolidates all general native acceptance into nine fail-closed checks", () => {
    expect(ciContractErrors(workflow)).toEqual([]);
  });

  test.each([
    [
      "separate validation job",
      (source: string) =>
        source.replace(
          "  hook-input-wrapper:",
          "  validate:\n    name: Restored validation\n    runs-on: ubuntu-latest\n\n  hook-input-wrapper:",
        ),
      /topology/,
    ],
    [
      "missing macOS native entry",
      (source: string) =>
        source.replace(
          /\n          - os: macos-latest\n            target: bun-darwin-arm64\n            artifact: arashi-macos-arm64\n            script: build:mac/,
          "",
        ),
      /native matrix/,
    ],
    [
      "version acceptance removed",
      (source: string) =>
        source.replace("./bin/${{ matrix.artifact }} --version", "true # removed"),
      /version smoke check/,
    ],
    [
      "materialization acceptance relocated",
      (source: string) =>
        source.replace(
          'node --experimental-strip-types tests/native/materialization-native.ts "bin/${{ matrix.artifact }}"',
          "true # relocated",
        ),
      /materialization/,
    ],
    [
      "acceptance conditionally skipped",
      (source: string) =>
        source.replace(
          "      - name: Run version and completion checks\n",
          "      - name: Run version and completion checks\n        if: runner.os == 'Linux'\n",
        ),
      /failure semantics/,
    ],
    [
      "acceptance failure hidden",
      (source: string) =>
        source.replace(
          "      - name: Exercise built-CLI materialization safety contract\n",
          "      - name: Exercise built-CLI materialization safety contract\n        continue-on-error: true\n",
        ),
      /failure semantics/,
    ],
    [
      "artifact uploaded before acceptance",
      (source: string) => {
        const section = job(source, "build");
        const uploadStart = section.indexOf("      - name: Upload accepted artifact");
        const upload = section.slice(uploadStart);
        const withoutUpload = section.slice(0, uploadStart);
        const buildEnd = withoutUpload.indexOf("      - name: Run version and completion checks");
        return source.replace(
          section,
          `${withoutUpload.slice(0, buildEnd)}${upload}\n${withoutUpload.slice(buildEnd)}`,
        );
      },
      /artifact ordering/,
    ],
    [
      "wrapper dependency disconnected",
      (source: string) =>
        source.replace(/(  hook-input-wrapper:[\s\S]*?)needs: \[build\]/, "$1needs: [quality]"),
      /consumer dependency/,
    ],
    [
      "installer artifact changed",
      (source: string) =>
        source.replace(
          /(  windows-installer-acceptance:[\s\S]*?name: )arashi-windows-x64\.exe/,
          "$1arashi-linux-x64",
        ),
      /consumer artifact/,
    ],
  ])("rejects controlled topology drift: %s", (_name, mutate, expected) => {
    expect(ciContractErrors(mutate(workflow))).toEqual(
      expect.arrayContaining([expect.stringMatching(expected)]),
    );
  });
});
