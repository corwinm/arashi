import { describe, expect, test } from "vitest";
import { createGenerator } from "ts-json-schema-generator";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface SchemaDefinition {
  properties?: Record<string, Record<string, unknown>>;
}

interface ConfigSchema {
  definitions: Record<string, SchemaDefinition>;
}

describe("repository materialization generated schema RED", () => {
  test("generates copy and symlink arrays in memory while leaving the checked artifact untouched", async () => {
    const repositoryRoot = join(import.meta.dirname, "..", "..");
    const generated = createGenerator({
      expose: "export",
      jsDoc: "extended",
      path: join(repositoryRoot, "src", "lib", "config.ts"),
      tsconfig: join(repositoryRoot, "tsconfig.schema.json"),
      type: "Config",
    }).createSchema("Config") as ConfigSchema;
    const artifact = JSON.parse(
      await readFile(join(repositoryRoot, "schema", "config.schema.json"), "utf8"),
    ) as ConfigSchema;

    expect(generated).toEqual(artifact);
    expect(generated.definitions.RepoConfig?.properties?.copy).toEqual({
      description: "Repository-relative paths copied into new worktrees in declaration order",
      items: { type: "string" },
      type: "array",
    });
    expect(generated.definitions.RepoConfig?.properties?.symlink).toEqual({
      description: "Repository-relative paths symlinked into new worktrees in declaration order",
      items: { type: "string" },
      type: "array",
    });
    expect(artifact.definitions.RepoConfig?.properties).toHaveProperty("copy");
    expect(artifact.definitions.RepoConfig?.properties).toHaveProperty("symlink");
  });
});
