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

describe("generated config schema switch contract", () => {
  test("advertises one unified switch mode and preserves create launch defaults", async () => {
    const schemaPath = join(import.meta.dirname, "..", "..", "schema", "config.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as ConfigSchema;

    expect(schema.definitions.SwitchMode?.enum).toEqual(["auto", "cd", "launch", "sesh", "herdr"]);
    expect(schema.definitions.SwitchCommandDefaults?.properties).toEqual({
      mode: {
        $ref: "#/definitions/SwitchMode",
        description: "Preferred switch behavior and launcher when running switch",
      },
    });
    expect(schema.definitions.CreateCommandDefaults?.properties).toHaveProperty("launch");
    expect(schema.definitions.CreateCommandDefaults?.properties).toHaveProperty("launchMode");
    expect(schema.definitions.EditorCommandDefaults?.properties).toHaveProperty("create");
    expect(JSON.stringify(schema.definitions.SwitchCommandDefaults)).not.toContain("launchMode");
    expect(JSON.stringify(schema.definitions.SwitchCommandDefaults)).not.toContain("launch_mode");
  });
});
