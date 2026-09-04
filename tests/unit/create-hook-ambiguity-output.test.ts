import { describe, expect, test } from "vitest";
import { formatHookSourceAmbiguityMessage } from "../../src/core/worktree.ts";

describe("create hook ambiguity output", () => {
  test("reports every conflicting native candidate path", () => {
    expect(
      formatHookSourceAmbiguityMessage("pre-create.alpha", {
        sourceKinds: ["file", "file"],
        sourceScriptPaths: [
          "C:\\workspace\\.arashi\\hooks\\pre-create.alpha.ps1",
          "C:\\workspace\\.arashi\\hooks\\pre-create.alpha.cmd",
        ],
      }),
    ).toBe(
      "Hook source is ambiguous for pre-create.alpha: file and file are both configured (C:\\workspace\\.arashi\\hooks\\pre-create.alpha.ps1, C:\\workspace\\.arashi\\hooks\\pre-create.alpha.cmd)",
    );
  });
});
