import { describe, expect, test } from "vitest";
import { join } from "path";
import { readFile } from "fs/promises";

const readMaintainedDocs = async () => {
  const paths = ["README.md", "docs/configuration.md", "docs/hooks.md"];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await readFile(join(process.cwd(), path), "utf8")]),
    ),
  );
};

const allText = (docs: Record<string, string>): string => Object.values(docs).join("\n");

describe("CLI-maintained inline lifecycle hook guidance semantic RED", () => {
  test("documents sole root/repository ownership, all fields, shorthand, and closed interpreter maps", async () => {
    const docs = await readMaintainedDocs();
    expect(docs["docs/configuration.md"]).toContain("hooks.scripts.<lifecycle>");
    expect(docs["docs/configuration.md"]).toContain("repos.<name>.hooks.<lifecycle>");
    expect(docs["docs/configuration.md"]).toMatch(/string.*Bash shorthand/is);
    expect(docs["docs/configuration.md"]).toMatch(/bash.*powershell.*cmd/is);
    for (const lifecycle of ["pre-create", "post-create", "pre-remove", "post-remove"]) {
      expect(docs["docs/configuration.md"]).toContain(lifecycle);
    }
    expect(allText(docs)).not.toMatch(/hooks\.scripts\s*\[\s*["'](?:pre|post)-create\.<repo>/i);
  });

  test("documents native lookup/fallback, ambiguity, lifecycle parity, and file-only standalone boundary", async () => {
    const hooks = (await readMaintainedDocs())["docs/hooks.md"];
    expect(hooks).toMatch(/inline.*native.*same logical location.*ambiguous/is);
    expect(hooks).toMatch(/POSIX.*PATH.*absolute.*Bash/is);
    expect(hooks).toMatch(/SystemRoot.*PowerShell.*cmd.*Bash.*fallback/is);
    expect(hooks).toMatch(/repository.*workspace.*global repository-targeted.*global shared/is);
    expect(hooks).toMatch(/standalone.*file-only.*inline.*not available/is);
  });

  test("documents exact flags, input/timeout/quiet/JSON/dry-run/outcome and no-disclosure semantics", async () => {
    const docs = await readMaintainedDocs();
    const text = allText(docs);
    expect(text).toMatch(/--no-hooks.*create only/is);
    expect(text).toMatch(/--no-hook-input.*create.*remove/is);
    expect(text).toMatch(/inline.*hooks\.timeout/is);
    expect(text).toMatch(/JSON.*quiet.*one.*document/is);
    expect(text).toMatch(/remove.*dry-run.*preview.*inline/is);
    expect(text).toMatch(/create.*dry-run.*does not discover.*empty.*hookOutcomes/is);
    expect(text).toMatch(/sourceKind.*sourceOwnerKind.*sourceOwnerName.*sourceScriptPath/is);
    expect(text).toMatch(/inline.*sourceScriptPath.*null/is);
    expect(text).toMatch(/snippet.*never.*logs.*outcomes.*previews.*doctor/is);
  });

  test("keeps shell-native examples fail-fast and warns against secrets", async () => {
    const text = allText(await readMaintainedDocs());
    expect(text).toMatch(/Bash.*set -e/is);
    expect(text).toMatch(/PowerShell.*ErrorActionPreference/is);
    expect(text).toMatch(/cmd.*errorlevel/is);
    expect(text).toMatch(/do not.*secret.*inline/is);
  });
});
