import { describe, expect, test } from "vitest";
import { createCommand as createSwitchCommand } from "../../src/commands/switch.ts";
import { readFileSync } from "fs";
import { resolve } from "path";

const readProjectFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const maintainedSwitchDocs = [
  "README.md",
  "docs/configuration.md",
  "docs/commands/switch.md",
  "docs/commands/shell.md",
] as const;

describe("unified switch mode documentation contract", () => {
  test("uses one canonical switch mode vocabulary without stale switch launch fields", () => {
    for (const path of maintainedSwitchDocs) {
      const contents = readProjectFile(path);
      expect(contents, path).not.toMatch(/defaults\.switch\.(?:launchMode|launch_mode)/);
      expect(contents, path).not.toMatch(/"switch"\s*:\s*\{[^}]*"launchMode"/s);
    }

    for (const path of ["README.md", "docs/configuration.md", "docs/commands/switch.md"] as const) {
      expect(readProjectFile(path), path).toContain("auto` | `cd` | `launch` | `sesh` | `herdr");
    }
  });

  test("documents contextual auto ordering, fallbacks, and absent compatibility", () => {
    const configuration = readProjectFile("docs/configuration.md");
    expect(configuration).toContain("tmux → Herdr → cmux → integrated IDE");
    expect(configuration).toContain("no managed context is detected");
    expect(configuration).toContain("terminal and platform launch fallback");
    expect(configuration).toContain("When `defaults.switch.mode` is absent");
    expect(configuration).toContain("built-in `launch` behavior");
  });

  test("documents the legacy migration table and exact diagnostic guidance", () => {
    const configuration = readProjectFile("docs/configuration.md");
    expect(configuration).toContain("## Legacy switch configuration migration");
    expect(configuration).toMatch(/\| absent \/ `launch`\s+\| `auto`\s+\| `launch`\s+\|/);
    expect(configuration).toMatch(
      /\| `cd`\s+\| `sesh` \/ `herdr`\s+\| Rejected; choose `cd` or the explicit launcher\s+\|/,
    );
    expect(configuration).toContain('use defaults.switch.mode: "<replacement>" instead');
    expect(configuration).toContain("Migration warnings are written to stderr");
    expect(configuration).toContain("JSON stdout remains one structured document");
  });

  test("keeps create launchMode documented as an independent default", () => {
    const configuration = readProjectFile("docs/configuration.md");
    expect(configuration).toContain("### `defaults.create`");
    expect(configuration).toContain("`launchMode` (`auto` | `sesh` | `herdr`)");
    expect(configuration).toContain("Create defaults are unchanged");
  });

  test("publishes explicit switch flag precedence in docs and CLI help", () => {
    const configuration = readProjectFile("docs/configuration.md");
    expect(configuration).toContain(
      "Explicit launcher flags > `--cd` / `--no-cd` > configured mode > automatic context detection",
    );

    const command = createSwitchCommand();
    expect(command.description()).toBe(
      "Switch to an existing worktree using explicit, configured, or contextual modes",
    );
    expect(
      command.options.find(
        (option: { description: string; long?: string }) => option.long === "--no-default-launch",
      )?.description,
    ).toBe("Bypass a configured sesh or Herdr mode for this invocation");
  });
});
