import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

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
});
