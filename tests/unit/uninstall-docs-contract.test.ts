import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(import.meta.dirname, "../../README.md"), "utf8");
const installation = readFileSync(join(import.meta.dirname, "../../docs/INSTALLATION.md"), "utf8");
const uninstall = readFileSync(
  join(import.meta.dirname, "../../docs/commands/uninstall.md"),
  "utf8",
);

describe("conservative uninstall CLI documentation", () => {
  test("documents inspection, consent, channels, refresh guidance, and preservation", () => {
    expect(readme).toMatch(/aw uninstall --dry-run/);
    expect(readme).toMatch(/aw uninstall --yes/);
    expect(readme).toMatch(/aw shell uninstall/);
    for (const command of [
      "npm uninstall -g arashi",
      "pnpm remove -g arashi",
      "yarn global remove arashi",
      "bun remove -g arashi",
      "vp uninstall -g arashi",
    ])
      expect(readme).toContain(command);
    expect(readme).toMatch(/refresh.*official installer/is);
    expect(readme).toMatch(/workspaces.*repositories.*worktrees/is);
    expect(readme).toMatch(/uninstall\.sh/);
    expect(readme).toMatch(/uninstall\.ps1/);
    expect(readme).not.toMatch(/uninstall --(?:json|force)/);
  });

  test("keeps install and command guidance aligned with schema v2", () => {
    expect(installation).toMatch(/schema(?: version)? 2|schema-v2/i);
    expect(installation).toMatch(/uninstall\.sh/);
    expect(installation).toMatch(/uninstall\.ps1/);
    expect(uninstall).toMatch(/--dry-run/);
    expect(uninstall).toMatch(/--yes/);
    expect(uninstall).toMatch(/legacy.*refresh/is);
    expect(uninstall).not.toMatch(/--json|--force/);
  });
});
