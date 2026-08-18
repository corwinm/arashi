import {
  checkMaintainedCliDocs,
  findPreferredArashiInvocations,
} from "../../scripts/documented-command-policy";
import { describe, expect, test } from "vitest";

describe("primary documented command policy", () => {
  test("maintained CLI guidance uses aw for actionable examples", () => {
    expect(checkMaintainedCliDocs(process.cwd())).toEqual([]);
  });

  test("rejects preferred arashi invocations with source-specific locations", () => {
    expect(
      findPreferredArashiInvocations(
        "Use `arashi status` before running:\n```bash\narashi create topic\narashi -h\n```",
        "fixture.md",
      ),
    ).toEqual([
      { line: 1, source: "fixture.md", text: "Use `arashi status` before running:" },
      { line: 3, source: "fixture.md", text: "arashi create topic" },
      { line: 4, source: "fixture.md", text: "arashi -h" },
    ]);
  });

  test("accepts identifiers, history, compatibility, and aw commands", () => {
    const valid = [
      "npm install -g arashi",
      "https://github.com/corwinm/arashi",
      "`.arashi/config.json` and `ARASHI_CONFIG_PATH`",
      "`arashi-windows-x64.exe`, `arashi.ps1`, and `arashi.binaryPath`",
      "Historical release notes used the arashi spelling.",
      "The `arashi` executable remains supported for existing scripts and workflows; `arashi status` is still valid there.",
      "Run `aw status`.",
    ].join("\n");
    expect(findPreferredArashiInvocations(valid, "valid-fixture.md")).toEqual([]);
  });
});
