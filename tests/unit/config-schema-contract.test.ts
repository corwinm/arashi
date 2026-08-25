import { describe, expect, test } from "vitest";
import { join } from "path";
import { readFile } from "fs/promises";

interface JsonSchemaDefinition {
  enum?: string[];
  properties?: Record<string, { minLength?: number; pattern?: string } & Record<string, unknown>>;
}

interface ConfigSchema {
  definitions: Record<string, JsonSchemaDefinition>;
}

describe("generated config schema contracts", () => {
  test("shares exact Git branch constraints across root, meta, and child base fields", async () => {
    const schemaPath = join(import.meta.dirname, "..", "..", "schema", "config.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as ConfigSchema;
    const fields = [
      schema.definitions.Config?.properties?.baseBranch,
      schema.definitions.MetaRepositoryConfig?.properties?.baseBranch,
      schema.definitions.RepoConfig?.properties?.baseBranch,
    ];

    const [root, ...overrides] = fields;
    for (const field of overrides) {
      expect(field).toMatchObject({ minLength: root?.minLength, pattern: root?.pattern });
    }
    for (const field of fields) {
      expect(field?.minLength).toBe(1);
      expect(field?.pattern).toBeTruthy();
    }
  });

  test("advertises canonical create launch and the unified switch mode", async () => {
    const schemaPath = join(import.meta.dirname, "..", "..", "schema", "config.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as ConfigSchema;

    expect(schema.definitions.CreateLaunchMode?.enum).toEqual(["none", "auto", "sesh", "herdr"]);
    expect(schema.definitions.CreateCommandDefaults?.properties).toEqual({
      launch: {
        $ref: "#/definitions/CreateLaunchMode",
        description: "Post-create launch choice; omitted preserves built-in no-launch behavior",
      },
      switch: {
        description: "Default to switching to the new worktree after create",
        type: "boolean",
      },
    });
    expect(schema.definitions.EditorCreateCommandDefaults?.properties).toEqual({
      launch: {
        $ref: "#/definitions/CreateLaunchMode",
        description: "Post-create launch choice; omitted preserves built-in no-launch behavior",
      },
      switch: {
        description: "Default to switching to the new worktree after create",
        type: "boolean",
      },
    });
    expect(JSON.stringify(schema.definitions.EditorCreateCommandDefaults)).not.toContain(
      "baseBranch",
    );
    expect(JSON.stringify(schema.definitions.CreateCommandDefaults)).not.toContain("launchMode");
    expect(JSON.stringify(schema.definitions.CreateCommandDefaults)).not.toContain("launch_mode");

    expect(schema.definitions.SwitchMode?.enum).toEqual(["auto", "cd", "launch", "sesh", "herdr"]);
    expect(schema.definitions.SwitchCommandDefaults?.properties).toEqual({
      mode: {
        $ref: "#/definitions/SwitchMode",
        description: "Preferred switch behavior and launcher when running switch",
      },
    });
    expect(schema.definitions.EditorCommandDefaults?.properties).toHaveProperty("create");
    expect(schema.definitions.Config?.properties?.hooks).toBeDefined();
    expect(JSON.stringify(schema.definitions.Config?.properties?.hooks)).not.toContain('"input"');
  });

  test("publishes the closed optional worktree naming policy without changing config version", async () => {
    const schemaPath = join(import.meta.dirname, "..", "..", "schema", "config.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as ConfigSchema;

    expect(schema.definitions.WorktreeNamingStyle?.enum).toEqual([
      "default",
      "branch",
      "repo-branch",
    ]);
    expect(schema.definitions.WorktreeNamingBranchSlashes?.enum).toEqual(["preserve", "flatten"]);
    expect(schema.definitions.WorktreeNamingConfig).toMatchObject({
      additionalProperties: false,
      properties: {
        branchSlashes: { $ref: "#/definitions/WorktreeNamingBranchSlashes" },
        maxPathLength: {
          description:
            "Maximum UTF-16 code units for each absolute newly planned configured-worktree destination",
          maximum: 2147483647,
          minimum: 1,
          multipleOf: 1,
          type: "number",
        },
        style: { $ref: "#/definitions/WorktreeNamingStyle" },
      },
      type: "object",
    });
    expect(schema.definitions.Config?.properties?.worktreeNaming).toEqual({
      $ref: "#/definitions/WorktreeNamingConfig",
      description: "Optional filesystem naming policy for configured create",
    });
    expect(schema.definitions.Config?.properties?.version).toMatchObject({
      $ref: "#/definitions/ConfigVersion",
    });
    expect(schema.definitions.ConfigVersion).toMatchObject({ const: "1.0.0" });
  });

  test.each([
    "feature branch",
    "-feature",
    "/feature",
    "feature/",
    "feature.",
    ".feature",
    "feature.lock",
    "feature..child",
    "feature@{child",
    "feature//child",
    "feature\u0001child",
    String.raw`feature\child`,
    "feature~child",
    "feature^child",
    "feature:child",
    "feature?child",
    "feature*child",
    "feature[child",
    "HEAD",
    "origin/HEAD",
    "origin/-feature",
  ])("schema pattern rejects representative malformed Git branch %j", async (branchName) => {
    const schemaPath = join(import.meta.dirname, "..", "..", "schema", "config.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as ConfigSchema;
    const pattern = schema.definitions.Config?.properties?.baseBranch?.pattern;

    expect(pattern).toBeDefined();
    expect(new RegExp(pattern!).test(branchName)).toBe(false);
  });
});
