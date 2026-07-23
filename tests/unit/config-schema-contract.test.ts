import { describe, expect, test } from "vitest";
import { join } from "path";
import { readFile } from "fs/promises";

interface JsonSchemaDefinition {
  enum?: string[];
  properties?: Record<string, unknown>;
}

interface ConfigSchema {
  definitions: Record<string, JsonSchemaDefinition>;
}

describe("generated config schema contracts", () => {
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
    expect(JSON.stringify(schema.definitions.CreateCommandDefaults)).not.toContain("launchMode");
    expect(JSON.stringify(schema.definitions.CreateCommandDefaults)).not.toContain("launch_mode");

    expect(schema.definitions.SwitchMode?.enum).toEqual(["auto", "cd", "launch", "sesh", "herdr"]);
    expect(schema.definitions.EditorCommandDefaults?.properties).toHaveProperty("create");
  });
});
