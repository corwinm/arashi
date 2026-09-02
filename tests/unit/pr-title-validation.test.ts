import { SUPPORTED_TYPES, validatePullRequestTitle } from "../../scripts/validate-pr-title.mts";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const releaseConfig = JSON.parse(
  readFileSync(new URL("../../.releaserc.json", import.meta.url), "utf8"),
);
const releaseTypes = releaseConfig.plugins[0][1].releaseRules.map(
  ({ type }: { type: string }) => type,
);

const workflow = readFileSync(
  new URL("../../.github/workflows/pr-title.yml", import.meta.url),
  "utf8",
);

describe("pull request title validation", () => {
  it.each([
    "fix: clarify switch success output",
    "feat(cli): add title validation",
    "perf!: replace the execution model",
    "docs(openspec)!: define a breaking contract",
    "chore(deps): update dependencies",
  ])("accepts %s", (title) => {
    expect(validatePullRequestTitle(title)).toEqual({ valid: true });
  });

  it.each([
    "Clarify switch success output",
    "unknown: add behavior",
    "fix:add behavior",
    "fix(): add behavior",
    "fix(scope(with-paren)): add behavior",
    "fix: ",
    "fix: first line\nsecond line",
    "fix: first line\u2028second line",
    "fix: first line\u2029second line",
  ])("rejects %s", (title) => {
    expect(validatePullRequestTitle(title)).toMatchObject({ valid: false });
  });

  it("matches semantic-release's recognized type set", () => {
    expect(new Set(SUPPORTED_TYPES)).toEqual(new Set(releaseTypes));
    expect(SUPPORTED_TYPES).toHaveLength(releaseTypes.length);
  });

  it("runs a focused trusted-base check for every relevant title event", () => {
    expect(workflow).toContain("  pull_request_target:");
    expect(workflow).not.toContain("\n  pull_request:\n");
    expect(workflow).toContain("types: [opened, edited, reopened, synchronize]");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain(`ref: \${{ github.event.pull_request.base.sha }}`);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow.match(/uses: actions\/checkout@v7/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/github\.event\.pull_request\.head|github\.head_ref/);
    expect(workflow).toContain(`PR_TITLE: \${{ github.event.pull_request.title }}`);
    expect(workflow).toContain("run: node scripts/validate-pr-title.mts");
    expect(workflow.match(/github\.event\.pull_request\.title/g)).toHaveLength(1);
  });
});
