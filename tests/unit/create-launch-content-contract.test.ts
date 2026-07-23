import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");

describe("maintained create launch contracts", () => {
  test("semantic manifest records the normalized cross-repository contract", async () => {
    const contract = JSON.parse(
      await readFile(join(root, "contracts", "create-launch-config.json"), "utf8"),
    );
    expect(contract).toEqual({
      absentMode: "none",
      acceptedMigrations: [
        "launcher-without-boolean",
        "true-with-absent-or-launcher",
        "false-without-launcher",
        "canonical-with-compatible-launcher",
        "equal-launcher-aliases",
      ],
      canonicalField: "defaults.create.launch",
      cliPrecedence: ["explicit-launcher", "launch", "no-launch", "configured", "none"],
      editorHosts: ["vscode", "cursor", "kiro"],
      editorScope: "defaults.editors.<host>.create",
      editorScopeFallback: "none",
      failurePreservesCreatedWorktrees: true,
      jsonRestrictedModes: ["auto", "sesh", "herdr"],
      legacyFields: ["launch:boolean", "launchMode", "launch_mode"],
      modes: ["none", "auto", "sesh", "herdr"],
      rejectedMigrations: [
        "false-with-launcher",
        "conflicting-launcher-aliases",
        "none-with-launcher",
        "auto-with-explicit-launcher",
        "opposite-explicit-launchers",
        "invalid-values",
      ],
      schemaVersion: 1,
      switch: {
        field: "defaults.create.switch",
        type: "boolean",
        independent: true,
        launchImpliesSwitch: true,
      },
    });
  });

  test.each(["README.md", "docs/configuration.md"])(
    "%s documents one create launch field and migration behavior",
    async (relativePath) => {
      const content = await readFile(join(root, relativePath), "utf8");
      expect(content).toContain('"launch": "sesh"');
      expect(content).toContain("`none` | `auto` | `sesh` | `herdr`");
      expect(content).toContain("launch implies switch");
      expect(content).toContain("does not fall back");
      expect(content).toContain("bounded compatibility window");
      expect(content).not.toContain('"launch": true');
      expect(content).not.toContain("defaults.create.launchMode remains");
    },
  );
});
