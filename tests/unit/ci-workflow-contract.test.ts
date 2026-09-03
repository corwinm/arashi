import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

const jobs = (source: string): string => source.slice(source.indexOf("\njobs:\n") + 7);

const jobIds = (source: string): string[] =>
  [...jobs(source).matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((match) => match[1]);

const job = (source: string, id: string): string => {
  const start = jobs(source).search(new RegExp(`^  ${id}:\\s*$`, "m"));
  if (start < 0) return "";
  const area = jobs(source).slice(start);
  const next = area.slice(1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return area.slice(0, next < 0 ? undefined : next + 1);
};

const step = (source: string, name: string): string => {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const area = source.slice(start);
  const next = area.slice(marker.length).indexOf("      - name:");
  return area.slice(0, next < 0 ? undefined : marker.length + next);
};

const hasMatrixEntry = (source: string, os: string, artifact: string, extra: string): boolean =>
  new RegExp(`- os: ${os}\\s+artifact: ${artifact.replace(".", "\\.")}\\s+${extra}`).test(source);

const ciContractErrors = (source: string): string[] => {
  const errors: string[] = [];
  const expectedIds = ["quality", "test", "build", "native-acceptance"];
  const ids = jobIds(source);
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
  const buildPlatforms = [
    ["ubuntu-latest", "arashi-linux-x64", "target: bun-linux-x64\\s+", "build:linux"],
    ["macos-latest", "arashi-macos-arm64", "target: bun-darwin-arm64\\s+", "build:mac"],
    ["windows-latest", "arashi-windows-x64.exe", "target: bun-windows-x64\\s+", "build:windows"],
  ] as const;
  for (const [os, artifact, target, script] of buildPlatforms) {
    if (
      !new RegExp(
        `- os: ${os}\\s+${target}artifact: ${artifact.replace(".", "\\.")}\\s+script: ${script}`,
      ).test(buildJob)
    )
      errors.push(`build matrix: missing ${os}/${artifact}/${script}`);
  }
  if ((buildJob.match(/^\s+- os:/gm) ?? []).length !== 3)
    errors.push("build matrix: expected exactly three supported platforms");
  if (!buildJob.includes("name: Build (${{ matrix.os }})"))
    errors.push("topology: independent native build checks are missing");
  const upload = step(buildJob, "Upload artifact");
  if (!upload) errors.push("build artifacts: build must upload each named binary");
  if (upload.includes("if:") || buildJob.includes("continue-on-error:"))
    errors.push("build artifacts: upload must remain fail-closed after a successful build");
  if (
    buildJob.includes("Run version and completion checks") ||
    buildJob.includes("materialization-native")
  )
    errors.push("ownership: acceptance must not be folded into build");

  const acceptance = job(source, "native-acceptance");
  const acceptancePlatforms = [
    ["ubuntu-latest", "arashi-linux-x64", "install-dependencies: true"],
    ["macos-latest", "arashi-macos-arm64", "install-dependencies: false"],
    ["windows-latest", "arashi-windows-x64.exe", "install-dependencies: true"],
  ] as const;
  for (const [os, artifact, dependencies] of acceptancePlatforms) {
    if (!hasMatrixEntry(acceptance, os, artifact, dependencies))
      errors.push(`acceptance matrix: missing ${os}/${artifact}/${dependencies}`);
  }
  if ((acceptance.match(/^\s+- os:/gm) ?? []).length !== 3)
    errors.push("acceptance matrix: expected exactly three supported platforms");
  if (!acceptance.includes("name: Native Acceptance (${{ matrix.os }})"))
    errors.push("topology: native acceptance matrix check name is missing");
  if (!acceptance.includes("needs: [build]"))
    errors.push("acceptance dependency: native acceptance must need build");
  if (!acceptance.includes("fail-fast: false"))
    errors.push("failure isolation: native acceptance must disable matrix fail-fast");
  if (acceptance.includes("continue-on-error:"))
    errors.push("failure semantics: native acceptance must remain fatal");
  const nodeSetup = step(acceptance, "Setup Node.js");
  const dependencyRuntime = step(acceptance, "Setup pnpm and Node.js");
  if (
    !nodeSetup.includes("node-version: 24.18.0") ||
    !nodeSetup.includes("!matrix.install-dependencies")
  )
    errors.push("runtime: dependency-free acceptance must use pinned Node 24 only");
  if (
    !dependencyRuntime.includes("runtime: node@24.18.0") ||
    !dependencyRuntime.includes("matrix.install-dependencies")
  )
    errors.push("runtime: dependency-backed acceptance must use pinned pnpm and Node 24");
  if (!acceptance.includes("version: 11.22.0"))
    errors.push("runtime: dependency-backed acceptance must use pinned pnpm");
  if (!acceptance.includes("pnpm install --frozen-lockfile"))
    errors.push("runtime: dependency-backed acceptance must use the frozen lockfile");
  if (!acceptance.includes("path: bin"))
    errors.push("artifact reachability: native artifacts must download into bin");

  const requiredSteps = [
    [
      "Run version and completion checks",
      ["always()", "steps.artifact.outcome"],
      ["artifact", "executable"],
    ],
    [
      "Exercise built-CLI materialization safety contract",
      ["always()", "steps.artifact.outcome", "steps.node.outcome", "steps.runtime.outcome"],
      ["artifact", "node", "runtime", "executable"],
    ],
    [
      "Prepare installed package entrypoint",
      ["always()", "runner.os == 'Linux'", "steps.artifact.outcome"],
      ["artifact", "executable"],
    ],
    [
      "Verify installed package and built hook input acceptance",
      ["always()", "runner.os == 'Linux'", "steps.runtime.outcome", "steps.dependencies.outcome"],
      ["runtime", "dependencies", "wrapper-entrypoint"],
    ],
    [
      "Exercise transactional replacement and rollback",
      ["always()", "runner.os == 'Windows'", "steps.artifact.outcome"],
      ["checkout", "artifact"],
    ],
    [
      "Install with canonical defaults and verify fresh shells",
      ["always()", "runner.os == 'Windows'", "steps.artifact.outcome"],
      ["checkout", "artifact"],
    ],
    [
      "Exercise terminal and immediate-EOF hook input",
      [
        "always()",
        "runner.os == 'Windows'",
        "steps.artifact.outcome",
        "steps.runtime.outcome",
        "steps.dependencies.outcome",
      ],
      ["checkout", "artifact", "runtime", "dependencies"],
    ],
  ] as const;
  for (const [name, guardParts, allowedDependencies] of requiredSteps) {
    const section = step(acceptance, name);
    if (!section) {
      errors.push(`acceptance command: missing ${name}`);
      continue;
    }
    const condition = section.match(/^\s+if:\s*(.+)$/m)?.[1] ?? "";
    for (const part of guardParts)
      if (!condition.includes(part))
        errors.push(`failure continuation: ${name} condition must include ${part}`);
    const dependencies = [...condition.matchAll(/steps\.([a-z0-9-]+)\.outcome/g)].map(
      (match) => match[1],
    );
    const allowed = allowedDependencies as readonly string[];
    for (const dependency of dependencies)
      if (!allowed.includes(dependency))
        errors.push(`failure continuation: ${name} must not depend on sibling ${dependency}`);
  }

  const commands = [
    "./bin/${{ matrix.artifact }} --version",
    "for shell in bash zsh fish",
    'tests/native/materialization-native.ts "bin/${{ matrix.artifact }}"',
    "cp bin/arashi-linux-x64 bin/arashi.bin",
    "tests/integration/hook-input-built-posix.test.ts",
    "tests/integration/inline-hook-built-posix.test.ts",
    "tests/integration/hook-input-wrapper.test.ts",
    "tests/unit/arashi-wrapper.test.ts",
    "./tests/windows/install-transaction.ps1",
    "./tests/windows/default-installer-acceptance.ps1",
    "./tests/windows/hook-input-native.ps1",
  ];
  for (const command of commands)
    if (!acceptance.includes(command)) errors.push(`acceptance command: missing ${command}`);

  const expandedChecks =
    1 +
    (testJob.includes("os: [ubuntu-latest, windows-latest]") ? 2 : 0) +
    (buildJob.match(/^\s+- os:/gm) ?? []).length +
    (acceptance.match(/^\s+- os:/gm) ?? []).length;
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

  test("consolidates post-build acceptance into nine failure-isolated checks", () => {
    expect(ciContractErrors(workflow)).toEqual([]);
  });

  test.each([
    [
      "obsolete validation job restored",
      (source: string) =>
        source.replace(
          "  native-acceptance:",
          "  validate:\n    name: Restored validation\n    runs-on: ubuntu-latest\n\n  native-acceptance:",
        ),
      /topology/,
    ],
    [
      "macOS acceptance omitted",
      (source: string) =>
        source.replace(
          /\n          - os: macos-latest\n            artifact: arashi-macos-arm64\n            install-dependencies: false/,
          "",
        ),
      /acceptance matrix/,
    ],
    [
      "Windows artifact mismapped",
      (source: string) =>
        source.replace(
          /(  native-acceptance:[\s\S]*?artifact: )arashi-windows-x64\.exe/,
          "$1arashi-linux-x64",
        ),
      /acceptance matrix/,
    ],
    [
      "build dependency removed",
      (source: string) =>
        source.replace(/(  native-acceptance:[\s\S]*?)needs: \[build\]/, "$1needs: [quality]"),
      /acceptance dependency/,
    ],
    [
      "matrix fail-fast restored",
      (source: string) =>
        source.replace(/(  native-acceptance:[\s\S]*?)fail-fast: false/, "$1fail-fast: true"),
      /failure isolation/,
    ],
    [
      "materialization removed",
      (source: string) =>
        source.replace(
          'tests/native/materialization-native.ts "bin/${{ matrix.artifact }}"',
          "tests/native/removed.ts",
        ),
      /acceptance command/,
    ],
    [
      "later Windows installer short-circuited",
      (source: string) =>
        source.replace(
          /(      - name: Install with canonical defaults and verify fresh shells[\s\S]*?if: ).*/,
          "$1${{ steps.windows-transaction.outcome == 'success' }}",
        ),
      /failure continuation/,
    ],
    [
      "acceptance failure hidden",
      (source: string) =>
        source.replace(
          "      - name: Exercise terminal and immediate-EOF hook input\n",
          "      - name: Exercise terminal and immediate-EOF hook input\n        continue-on-error: true\n",
        ),
      /failure semantics/,
    ],
    [
      "build artifact upload bypasses failure",
      (source: string) =>
        source.replace(
          "      - name: Upload artifact\n",
          "      - name: Upload artifact\n        if: ${{ always() }}\n",
        ),
      /build artifacts/,
    ],
    [
      "build failure made non-fatal before upload",
      (source: string) =>
        source.replace(
          "      - name: Build binary\n",
          "      - name: Build binary\n        continue-on-error: true\n",
        ),
      /build artifacts/,
    ],
    [
      "materialization coupled to Linux wrapper preparation",
      (source: string) =>
        source.replace(
          /(      - name: Exercise built-CLI materialization safety contract[\s\S]*?if: .*?) }}/,
          "$1 && steps.wrapper-entrypoint.outcome == 'success' }}",
        ),
      /failure continuation/,
    ],
    [
      "Windows hook dependencies removed",
      (source: string) =>
        source.replace(
          /(      - name: Exercise terminal and immediate-EOF hook input[\s\S]*?if: .*)steps\.dependencies\.outcome[^\n]*/,
          "$1",
        ),
      /failure continuation/,
    ],
  ])("rejects controlled CI drift: %s", (_name, mutate, expected) => {
    expect(ciContractErrors(mutate(workflow))).toEqual(
      expect.arrayContaining([expect.stringMatching(expected)]),
    );
  });
});
