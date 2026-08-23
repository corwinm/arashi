import { Command } from "commander";
import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildProgram } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
} from "../../src/contracts/cli-commands.ts";

const readProjectFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const maintainedSwitchDocs = [
  "docs/configuration.md",
  "docs/commands/switch.md",
  "docs/commands/shell.md",
] as const;

const canonicalSwitchDocs = ["docs/configuration.md", "docs/commands/switch.md"] as const;

describe("unified switch mode documentation contract", () => {
  test("uses one canonical switch mode vocabulary without stale switch launch fields", () => {
    for (const path of maintainedSwitchDocs) {
      const contents = readProjectFile(path);
      expect(contents, path).not.toMatch(/defaults\.switch\.(?:launchMode|launch_mode)/);
      expect(contents, path).not.toMatch(/"switch"\s*:\s*\{[^}]*"launchMode"/s);
    }

    for (const path of canonicalSwitchDocs) {
      expect(readProjectFile(path), path).toContain("auto` | `cd` | `launch` | `sesh` | `herdr");
    }
  });

  test("uses canonical switch spellings for actionable guidance while retaining migration metadata", () => {
    for (const path of canonicalSwitchDocs) {
      const contents = readProjectFile(path);
      expect(contents, path).toContain("--launch");
      expect(contents, path).toContain("--ignore-configured-launcher");
      const lines = contents.split("\n");
      for (const line of lines.filter((candidate) => candidate.includes("arashi switch"))) {
        expect(line, `${path}: ${line}`).not.toContain("--no-cd");
        expect(line, `${path}: ${line}`).not.toContain("--no-default-launch");
      }
      for (const line of lines.filter((candidate) =>
        /--no-(?:cd|default-launch)/.test(candidate),
      )) {
        expect(line.toLowerCase(), `${path}: ${line}`).toContain("deprecated");
        expect(line.toLowerCase(), `${path}: ${line}`).toContain("compatibility");
      }
    }

    const switchDocs = readProjectFile("docs/commands/switch.md");
    expect(switchDocs).toContain("`--no-cd` is a deprecated compatibility spelling for `--launch`");
    expect(switchDocs).toContain(
      "`--no-default-launch` is a deprecated compatibility spelling for `--ignore-configured-launcher`",
    );
    const optionsSection = switchDocs.split("## Options")[1]?.split("## Examples")[0] ?? "";
    expect(optionsSection).not.toMatch(/^- `--no-(?:cd|default-launch)`/m);
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

  test("documents canonical create launch as an independent default", () => {
    const configuration = readProjectFile("docs/configuration.md");
    expect(configuration).toContain("### `defaults.create`");
    expect(configuration).toContain("`launch` (`none` | `auto` | `sesh` | `herdr`)");
    expect(configuration).toContain("`switch` (boolean): independent");
    expect(configuration).not.toContain("Create defaults are unchanged");
  });

  test("publishes explicit switch flag precedence in docs and CLI help", () => {
    const configuration = readProjectFile("docs/configuration.md");
    expect(configuration).toContain(
      "Explicit launcher flags > `--cd` / `--launch` > configured mode > automatic context detection",
    );

    const program = buildProgram({ includeHelpBanner: false });
    const command = program.commands.find((candidate: Command) => candidate.name() === "switch");
    expect(command?.description()).toBe(
      "Switch to an existing worktree using explicit, configured, or contextual modes",
    );
    expect(command?.options.find((option) => option.long === "--launch")?.description).toBe(
      "Launch the selected worktree while preserving a configured launcher",
    );
    expect(
      command?.options.find((option) => option.long === "--ignore-configured-launcher")
        ?.description,
    ).toBe("Bypass a configured sesh or Herdr launcher for this invocation");
  });

  test("documents tab as bypassing configured launchers on every maintained switch surface", () => {
    for (const path of canonicalSwitchDocs) {
      const contents = readProjectFile(path);
      expect(contents, path).toContain("bypasses configured `sesh` or `herdr` launch defaults");
      expect(contents, path).toContain("explicit launcher selector remains authoritative");
    }
  });

  test("documents explicit tmux switch and create launch without changing config modes", () => {
    const configuration = readProjectFile("docs/configuration.md");
    const switchDocs = readProjectFile("docs/commands/switch.md");
    expect(switchDocs).toContain("aw switch --tmux feature-auth");
    for (const contents of [configuration, switchDocs]) {
      expect(contents).toContain("non-empty after trimming");
      expect(contents).toContain("does not fall back");
      expect(contents).toContain("per-invocation");
    }
    expect(configuration).toContain("`--tmux` + `--launch`");
    expect(configuration).toContain("`--tmux` + `--ignore-configured-launcher`");
    expect(switchDocs).toContain("--tmux --sesh");
    expect(switchDocs).toContain("JSON_UNSUPPORTED_FOR_MODE");
  });

  test("publishes canonical descriptions and explicit legacy deprecation metadata", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const options = contract.commands.find((command) => command.path === "switch")?.options;
    const byLong = (long: string) => options?.find((option) => option.long === long);

    expect(byLong("--launch")).toMatchObject({
      deprecated: false,
      description: "Launch the selected worktree while preserving a configured launcher",
      hidden: false,
    });
    expect(byLong("--ignore-configured-launcher")).toMatchObject({
      deprecated: false,
      description: "Bypass a configured sesh or Herdr launcher for this invocation",
      hidden: false,
    });
    expect(byLong("--no-cd")).toMatchObject({
      deprecated: true,
      description: "Deprecated compatibility spelling for --launch",
      hidden: true,
    });
    expect(byLong("--no-default-launch")).toMatchObject({
      deprecated: true,
      description: "Deprecated compatibility spelling for --ignore-configured-launcher",
      hidden: true,
    });
  });
});
