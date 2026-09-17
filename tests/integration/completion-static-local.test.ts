import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { renderAllCompletions } from "../../src/completion/render.ts";
import { GENERATED_COMPLETIONS } from "../../src/generated/completions.ts";
import { contract, owner, ownership } from "../fixtures/completion/static-ownership.ts";
import auditedOwnership from "../fixtures/completion/static-ownership.json";

type Shell = keyof typeof GENERATED_COMPLETIONS;
type Case = {
  name: string;
  words: string[];
  include?: string[];
  exclude?: string[];
  exact?: string[];
  dynamic?: boolean;
  normalized?: string[];
  aliasFixture?: boolean;
};
const cases: Case[] = [
  {
    name: "contract-derived command alias",
    words: ["arashi", "sh-test", "i"],
    exact: ["init", "install"],
    aliasFixture: true,
  },
  {
    name: "contract-derived alias suggestion",
    words: ["arashi", "sh-t"],
    exact: ["sh-test"],
    aliasFixture: true,
  },
  { name: "root", words: ["arashi", "cr"], exact: ["create"] },
  { name: "aw registration", words: ["aw", "cr"], exact: ["create"] },
  { name: "nested", words: ["arashi", "shell", "i"], exact: ["init", "install"] },
  { name: "root options", words: ["arashi", "--"], include: ["--help", "--version"] },
  {
    name: "short options",
    words: ["arashi", "create", "topic", "-"],
    include: ["-o", "-g", "--only"],
  },
  { name: "shell choices", words: ["arashi", "completion", "b"], exact: ["bash"] },
  {
    name: "options after completed static positional",
    words: ["arashi", "completion", "bash", "--"],
    include: ["--help"],
  },
  {
    name: "inline choices",
    words: ["arashi", "create", "topic", "--conflict=R"],
    exact: ["--conflict=REUSE_EXISTING"],
  },
  {
    name: "consumed inline value",
    words: ["arashi", "create", "topic", "--conflict=ABORT", "--"],
    include: ["--dry-run"],
    exclude: ["--conflict", "ABORT", "REUSE_EXISTING"],
  },
  {
    name: "conflicts and nonrepeatability",
    words: ["arashi", "create", "topic", "--tmux", ""],
    include: ["--dry-run"],
    exclude: ["--tmux", "--herdr", "--sesh"],
  },
  {
    name: "short spelling consumes long option",
    words: ["arashi", "create", "topic", "-h", "--"],
    exclude: ["--help"],
    include: ["--dry-run"],
  },
  {
    name: "repeatable option",
    words: ["arashi", "handoff", "--risk", "first", "--"],
    include: ["--risk", "--link"],
  },
  {
    name: "repeatable selector",
    words: ["arashi", "create", "topic", "-o", "first", "--"],
    include: ["--only"],
  },
  { name: "hidden command", words: ["arashi", "completion", "__"], exact: [] },
  { name: "hidden option", words: ["arashi", "switch", "--no"], exact: [] },
  { name: "end of options", words: ["arashi", "create", "topic", "--", ""], exact: [] },
  { name: "variadic command boundary", words: ["arashi", "exec", "printf", ""], exact: [] },
  {
    name: "variadic option-like child argument",
    words: ["arashi", "exec", "printf", "--"],
    exact: [],
  },
  { name: "free-text branch", words: ["arashi", "create", ""], exact: [] },
  { name: "free-text URL", words: ["arashi", "add", ""], exact: [] },
  { name: "free-text inline", words: ["arashi", "create", "topic", "--base="], exact: [] },
  { name: "exhausted positional", words: ["arashi", "delete", "first", ""], exact: [] },
  { name: "dynamic aw", words: ["aw", "create", "topic", "-o", "p"], dynamic: true },
  { name: "dynamic inline", words: ["arashi", "create", "topic", "--only=p"], dynamic: true },
  { name: "dynamic after --", words: ["arashi", "switch", "--", "p"], dynamic: true },
  { name: "dynamic scope", words: ["arashi", "switch", "--repos", "p"], dynamic: true },
];
// Enumerate all canonical value owners, not just familiar examples. Preceding
// positionals are supplied so option values cannot accidentally own those slots.
for (const command of contract.commands.filter((command) => !command.hidden)) {
  const path = command.path.split(" ");
  for (const option of command.options.filter(
    (option) => !option.hidden && option.valueShape !== "boolean",
  )) {
    for (const spelling of [option.long, option.short].filter((value): value is string =>
      Boolean(value),
    )) {
      const classification = owner(option);
      cases.push({
        name: `owner ${command.path} ${spelling}`,
        words: [
          "arashi",
          ...path,
          ...command.arguments.filter((argument) => argument.required).map(() => "topic"),
          spelling,
          "",
        ],
        dynamic: classification.startsWith("dynamic"),
        exact:
          classification === "static"
            ? option.choices
            : classification === "none/free-text"
              ? []
              : undefined,
      });
    }
  }
  command.arguments.forEach((argument, index) => {
    const classification = owner(argument);
    cases.push({
      name: `owner ${command.path} positional ${index}`,
      words: ["arashi", ...path, ...Array.from({ length: index }, () => "topic"), ""],
      dynamic: classification.startsWith("dynamic"),
      exact:
        classification === "static"
          ? argument.choices
          : classification === "none/free-text"
            ? []
            : undefined,
    });
  });
  for (const alias of command.aliasPaths)
    cases.push({
      name: `canonical alias ${alias}`,
      words: ["arashi", ...alias.split(" "), "--h"],
      exact: ["--help"],
    });
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const available = (shell: string) =>
  spawnSync(shell, ["--version"], { encoding: "utf8" }).status === 0;
const shells: Shell[] = ["bash", "zsh", "fish", "powershell"];
let root: string;
let ledger: string;
const generated = renderAllCompletions(contract);
// No current command declares an alias. Exercise alias metadata by extending
// the real canonical contract in a test-only fixture, never production files.
const aliasContract = structuredClone(contract);
aliasContract.commands.find((command) => command.path === "shell")!.aliases.push("sh-test");
aliasContract.commands.find((command) => command.path === "shell")!.aliasPaths.push("sh-test");
for (const command of aliasContract.commands.filter((command) => command.path.startsWith("shell ")))
  command.aliasPaths.push(command.path.replace(/^shell /, "sh-test "));
const aliasGenerated = renderAllCompletions(aliasContract);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "arashi-static-ledger-"));
  ledger = join(root, "ledger.jsonl");
  for (const shell of shells) {
    writeFileSync(join(root, `${shell}.completion`), generated[shell]);
    writeFileSync(join(root, `${shell}.alias.completion`), aliasGenerated[shell]);
  }
  // Static dispatch fails closed. Dynamic output is a fixed NUL-framed record;
  // the shim never constructs the CLI or touches workspace metadata.
  for (const executable of ["arashi", "git"]) {
    const path = join(root, executable);
    writeFileSync(
      path,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.COMPLETION_LEDGER, JSON.stringify({ executable: ${JSON.stringify(executable)}, args }) + '\\n');\nif (${JSON.stringify(executable)} === 'git' || process.env.COMPLETION_DYNAMIC !== '1') process.exit(93);\nprocess.stdout.write(process.env.COMPLETION_VALUE + '\\0Fixture description\\0');\n`,
    );
    chmodSync(path, 0o755);
  }
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function run(shell: Shell, fixture: Case, sabotage = false) {
  writeFileSync(ledger, "");
  const words = fixture.words.map(quote).join(" ");
  const completionPath = join(root, `${shell}${fixture.aliasFixture ? ".alias" : ""}.completion`);
  const source = quote(completionPath);
  const dynamicValue = fixture.words.at(-1)!.startsWith("--only=") ? "--only=probe" : "probe";
  let script: string;
  let args: string[];
  if (shell === "bash") {
    script = `source ${source}\ncomplete -p arashi >/dev/null || exit 81\ncomplete -p aw >/dev/null || exit 82\nCOMP_WORDS=(${words})\nCOMP_CWORD=$((\${#COMP_WORDS[@]} - 1))\n${sabotage ? 'command arashi completion __query "$COMP_CWORD" -- "${COMP_WORDS[@]}" >/dev/null\n' : ""}_arashi\nfor candidate in "\${COMPREPLY[@]}"; do printf '%s\\n' "$candidate"; done\ntrue`;
    args = ["--noprofile", "--norc", "-c", script];
  } else if (shell === "zsh") {
    script = `source ${source}\n[[ "$_comps[arashi]" == _arashi && "$_comps[aw]" == _arashi ]] || exit 82\ncompadd() { local emit=0 arg; for arg in "$@"; do if (( emit )); then print -r -- "$arg"; fi; [[ "$arg" == -- ]] && emit=1; done; return 0; }\nwords=(${words})\nCURRENT=$#words\n_arashi\ntrue`;
    args = ["-f", "-c", script];
  } else if (shell === "fish") {
    const line = fixture.words.map((word) => (word === "" ? "" : word)).join(" ");
    script = `source ${source}\nfor record in (complete -C ${quote(line)})\nset -l fields (string split -m 1 \\t -- "$record")\nstring unescape -- "$fields[1]"\nend\ntrue`;
    args = ["--no-config", "-c", script];
  } else {
    // Capture only the registered native completer, then invoke with a real
    // PowerShell AST. This avoids TabExpansion2's unrelated filename fallback.
    script = `$ErrorActionPreference = 'Stop'
function Register-ArgumentCompleter { param([switch]$Native, $CommandName, [scriptblock]$ScriptBlock) $script:Completer = $ScriptBlock; $script:Names = $CommandName }
function arashi {
  $record = @{ executable = 'arashi'; args = @($args | ForEach-Object { [string]$_ }) } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($env:COMPLETION_LEDGER, $record + [Environment]::NewLine)
  if ($env:COMPLETION_DYNAMIC -eq '1') { $env:COMPLETION_VALUE + [char]0 + "Fixture description" + [char]0 } else { $global:LASTEXITCODE = 93 }
}
function git { [IO.File]::AppendAllText($env:COMPLETION_LEDGER, '{"executable":"git","args":[]}' + [Environment]::NewLine); $global:LASTEXITCODE = 93 }
. ${psQuote(completionPath)}
if ('arashi' -notin $script:Names -or 'aw' -notin $script:Names) { throw 'Missing native registration' }
$line = ${psQuote(fixture.words.join(" "))}
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$tokens, [ref]$parseErrors)
$commandAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)
& $script:Completer ${psQuote(fixture.words.at(-1)!)} $commandAst $line.Length | ForEach-Object { $_.ListItemText }
exit 0`;
    const scriptPath = join(root, "invoke.ps1");
    writeFileSync(scriptPath, script);
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath];
  }
  const result = spawnSync(shell === "powershell" ? "pwsh" : shell, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: root,
      ZDOTDIR: root,
      XDG_CONFIG_HOME: root,
      PATH: `${root}${delimiter}${process.env.PATH}`,
      COMPLETION_LEDGER: ledger,
      COMPLETION_VALUE: dynamicValue,
      COMPLETION_DYNAMIC: fixture.dynamic ? "1" : "0",
    },
  });
  expect(result.error, "shell must execute, not fail in fixture setup").toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr, "no shell syntax/fixture errors").toBe("");
  return {
    values: result.stdout.split(/\r?\n/).filter(Boolean).toSorted(),
    calls: readFileSync(ledger, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}
function assertLocal(calls: unknown[]) {
  expect(calls, "static/none completion must start zero arashi and git processes").toEqual([]);
}

describe("issue #362 shell-local static completion RED", () => {
  test("exhaustive canonical ownership matrix has no unreviewed slots", () => {
    expect(ownership).toEqual(auditedOwnership);
    expect(new Set(ownership.map((row) => row.at(-1)))).toEqual(
      new Set([
        "static",
        "dynamic repository",
        "dynamic group",
        "dynamic worktree",
        "none/free-text",
      ]),
    );
    expect(contract.schemaVersion).toBe(8);
  });
  test.each(shells)("%s generated marker is v7 and packaged source is synchronized", (shell) => {
    expect
      .soft(generated[shell].split("\n")[0])
      .toMatch(/^# arashi-completion-contract-v7:[a-f0-9]{64}$/);
    expect
      .soft(GENERATED_COMPLETIONS[shell].split("\n")[0])
      .toMatch(/^# arashi-completion-contract-v7:[a-f0-9]{64}$/);
    expect(GENERATED_COMPLETIONS[shell]).toBe(generated[shell]);
  });
  test("Windows requires real pwsh for its behavior gate", () => {
    if (process.platform === "win32") expect(available("pwsh")).toBe(true);
  });
  for (const shell of shells) {
    describe.skipIf(
      !available(shell === "powershell" ? "pwsh" : shell) ||
        (process.platform === "win32" && shell !== "powershell"),
    )(shell, () => {
      test.each(cases)("$name", (fixture) => {
        const { calls, values } = run(shell, fixture);
        if (fixture.dynamic) {
          const words = fixture.normalized ?? fixture.words;
          expect(calls, "one exact runtime query; no direct Git/discovery dispatch").toEqual([
            {
              executable: "arashi",
              args: ["completion", "__query", String(words.length - 1), "--", ...words],
            },
          ]);
          expect(values).toEqual([
            fixture.words.at(-1)!.startsWith("--only=") ? "--only=probe" : "probe",
          ]);
        } else {
          // Soft checks preserve both process and missing-candidate evidence.
          expect
            .soft(calls, "static/none completion must start zero arashi and git processes")
            .toEqual([]);
          if (fixture.exact) expect.soft(values).toEqual([...fixture.exact].toSorted());
          for (const value of fixture.include ?? []) expect.soft(values).toContain(value);
          for (const value of fixture.exclude ?? []) expect.soft(values).not.toContain(value);
        }
      });
    });
  }
  test.skipIf(!available("bash") || process.platform === "win32")(
    "sabotage: unconditional runtime dispatch is rejected even when no candidates are expected",
    () => {
      const { calls } = run(
        "bash",
        { name: "sabotage", words: ["arashi", "create", "topic", "--", ""], exact: [] },
        true,
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(() => assertLocal(calls)).toThrow("static/none completion must start zero");
    },
  );
  test.skipIf(!available("bash") || process.platform === "win32")(
    "Bash restores the caller's nocasematch setting",
    () => {
      const completionPath = join(root, "bash.completion");
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `source ${quote(completionPath)}
shopt -u nocasematch
COMP_WORDS=(arashi CR)
COMP_CWORD=1
_arashi
shopt -q nocasematch && exit 91
printf '%s\\n' "\${COMPREPLY[@]}"`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH}`,
            COMPLETION_LEDGER: ledger,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("create");
    },
  );
  test.skipIf(!available("bash") || process.platform === "win32")(
    "Bash parses command and option spellings case-sensitively when nocasematch is inherited",
    () => {
      const completionPath = join(root, "bash.completion");
      writeFileSync(ledger, "");
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `source ${quote(completionPath)}
shopt -s nocasematch
COMP_WORDS=(arashi -v --)
COMP_CWORD=2
_arashi
printf '%s\\n' "\${COMPREPLY[@]}"`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH}`,
            COMPLETION_LEDGER: ledger,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split(/\r?\n/)).toContain("--version");
      expect(readFileSync(ledger, "utf8")).toBe("");
    },
  );
  test.skipIf(!available("zsh") || process.platform === "win32")(
    "Zsh normalizes inherited ksharrays while preserving the caller setting",
    () => {
      const completionPath = join(root, "zsh.completion");
      const result = spawnSync(
        "zsh",
        [
          "-f",
          "-c",
          `source ${quote(completionPath)}
setopt ksharrays
compadd() { local emit=0 arg; for arg in "$@"; do if (( emit )); then print -r -- "$arg"; fi; [[ "$arg" == -- ]] && emit=1; done; return 0; }
words=(arashi cr)
CURRENT=2
_arashi
[[ -o ksharrays ]] || exit 92`,
        ],
        { encoding: "utf8", env: { ...process.env, HOME: root, ZDOTDIR: root } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split(/\r?\n/).filter(Boolean)).toEqual(["create"]);
    },
  );
  test.skipIf(!available("bash") || process.platform === "win32")(
    "Bash split inline equals is local",
    () => {
      const result = run("bash", {
        name: "split equals",
        words: ["arashi", "create", "topic", "--conflict", "=", "R"],
      });
      expect.soft(result.calls).toEqual([]);
      expect.soft(result.values).toEqual(["--conflict=REUSE_EXISTING"]);
    },
  );
  test.skipIf(!available("bash") || process.platform === "win32")(
    "Bash dynamic split equals dispatches exactly once with normalized argv/cursor",
    () => {
      const words = ["aw", "create", "topic", "--only", "=", "p"];
      const result = run("bash", { name: "dynamic split equals", words, dynamic: true });
      expect(result.calls).toEqual([
        {
          executable: "arashi",
          args: ["completion", "__query", "3", "--", "aw", "create", "topic", "--only=p"],
        },
      ]);
      expect(result.values).toEqual(["probe"]);
    },
  );
});
