import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildProgram } from "../../src/cli-program.ts";
import { renderAllCompletions } from "../../src/completion/render.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
} from "../../src/contracts/cli-commands.ts";

const contract = generateCommandContract(
  buildProgram({ includeHelpBanner: false }),
  commandSemantics,
  optionAuditPolicies,
);
const completions = renderAllCompletions(contract);

describe("dual-name generated completion", () => {
  test("registers one Bash model for arashi and conditionally for aw with canonical backend queries", () => {
    expect(completions.bash).toContain("complete -F _arashi arashi");
    expect(completions.bash).toContain("complete -F _arashi aw");
    expect(completions.bash).toMatch(
      /alias aw[\s\S]*declare -F aw[\s\S]*arashi-managed-shell-wrapper:aw:v1/,
    );
    expect(completions.bash.match(/command arashi completion __query/g)).toHaveLength(1);
    expect(completions.bash).not.toContain("command aw completion __query");
  });

  test("registers one Zsh model for arashi and conditionally for aw without resetting initialized state", () => {
    expect(completions.zsh).toContain("compdef _arashi arashi");
    expect(completions.zsh).toContain("compdef _arashi aw");
    expect(completions.zsh).toMatch(
      /aliases\[aw\][\s\S]*functions\[aw\][\s\S]*arashi-managed-shell-wrapper:aw:v1/,
    );
    expect(completions.zsh.match(/command arashi completion __query/g)).toHaveLength(1);
    expect(completions.zsh).not.toContain("command aw completion __query");
  });

  test("registers one Fish model for arashi and conditionally for aw", () => {
    expect(completions.fish).toContain("complete -c arashi -f -a '(__arashi_complete)'");
    expect(completions.fish).toContain("complete -c aw -f -a '(__arashi_complete)'");
    expect(completions.fish).toMatch(/functions -q aw[\s\S]*arashi-managed-shell-wrapper:aw:v1/);
    expect(completions.fish.match(/command arashi completion __query/g)).toHaveLength(1);
    expect(completions.fish).not.toContain("command aw completion __query");
  });

  test.each(["bash", "zsh", "fish"] as const)(
    "accepts aw as the root token in %s without a second candidate model",
    (shell) => {
      expect(completions[shell]).toContain("aw");
      expect(completions[shell]).toContain("_arashi");
      expect(completions[shell]).not.toContain("_aw()");
    },
  );

  test.each([
    {
      args: ["--noprofile", "--norc"],
      inspect: "complete -p aw",
      setup: "aw() { :; }; _other() { :; }; complete -F _other aw",
      shell: "bash",
    },
    {
      args: ["-f"],
      inspect: "print -r -- $_comps[aw]",
      setup: "autoload -Uz compinit; compinit -i; aw() { :; }; _other() { :; }; compdef _other aw",
      shell: "zsh",
    },
    {
      args: ["--no-config"],
      inspect: "complete -c aw",
      setup: "function aw; true; end; complete -c aw -f -a other",
      shell: "fish",
    },
  ])("preserves unrelated $shell completion ownership", ({ args, inspect, setup, shell }) => {
    const available = spawnSync(shell, ["--version"], { encoding: "utf8" }).status === 0;
    if (!available) {
      return;
    }
    const fixture = mkdtempSync(join(tmpdir(), `arashi-completion-${shell}-`));
    const script = join(fixture, `completion.${shell}`);
    writeFileSync(
      script,
      `${setup}\n${completions[shell as keyof typeof completions]}\n${inspect}\n`,
    );
    try {
      const result = spawnSync(shell, [...args, script], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("other");
      expect(result.stdout).not.toContain("__arashi_complete");
      expect(result.stdout).not.toContain("_arashi");
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });
});
