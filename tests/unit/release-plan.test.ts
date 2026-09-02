import { describe, expect, test } from "vitest";
import { releasePlanPlugins } from "../../scripts/release/release-plan.mjs";

describe("credential-free release planning", () => {
  test("preserves configured analyzer and release-notes options", () => {
    const config: {
      plugins: (string | [string, Record<string, unknown>])[];
    } = {
      plugins: [
        [
          "@semantic-release/commit-analyzer",
          { preset: "conventionalcommits", releaseRules: [{ release: "patch", type: "refactor" }] },
        ],
        ["@semantic-release/npm", { npmPublish: true }],
        [
          "@semantic-release/release-notes-generator",
          {
            preset: "conventionalcommits",
            presetConfig: { types: [{ section: "Code Refactoring", type: "refactor" }] },
          },
        ],
      ],
    };

    expect(releasePlanPlugins(config)).toEqual([config.plugins[0], config.plugins[2]]);
  });
});
