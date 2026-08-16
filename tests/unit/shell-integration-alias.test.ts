import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { buildShellInitScript, buildShellInstallBlock } from "../../src/lib/shell-integration.ts";

const fixtures: string[] = [];
const available = (shell: string): boolean => spawnSync(shell, ["--version"]).status === 0;
let builtFixture = "";

beforeAll(() => {
  builtFixture = mkdtempSync(join(tmpdir(), "arashi-aw-built-shell-"));
  execFileSync(
    "bun",
    ["build", "src/index.ts", "--compile", "--outfile", join(builtFixture, "arashi.bin")],
    {
      cwd: join(import.meta.dirname, "../.."),
      encoding: "utf8",
    },
  );
  chmodSync(join(builtFixture, "arashi.bin"), 0o755);
});

afterAll(() => {
  if (builtFixture) rmSync(builtFixture, { force: true, recursive: true });
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function createRealSwitchFixture(): { bin: string; root: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "arashi-aw-real-switch-"));
  fixtures.push(root);
  const workspace = join(root, "workspace");
  const repository = join(workspace, "repos", "fixture");
  const target = join(workspace, ".arashi", "worktrees", "fixture", "target with space");
  const bin = join(root, "bin");
  mkdirSync(join(workspace, ".arashi"), { recursive: true });
  mkdirSync(repository, { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(workspace, ".arashi", "config.json"),
    JSON.stringify({
      repos: { fixture: { path: "repos/fixture" } },
      reposDir: "repos",
      version: "1.0.0",
      worktreesDir: "./.arashi/worktrees",
    }),
  );
  runGit(repository, ["init", "-b", "main"]);
  runGit(repository, ["config", "user.email", "shell-test@example.com"]);
  runGit(repository, ["config", "user.name", "Shell Test"]);
  runGit(repository, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repository, "README.md"), "real switch fixture\n");
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "-m", "real switch fixture"]);
  mkdirSync(dirname(target), { recursive: true });
  runGit(repository, ["worktree", "add", "-b", "real-shell-switch", target]);
  copyFileSync(join(import.meta.dirname, "../../bin/aw"), join(bin, "aw"));
  copyFileSync(join(builtFixture, "arashi.bin"), join(bin, "arashi.bin"));
  chmodSync(join(bin, "aw"), 0o755);
  chmodSync(join(bin, "arashi.bin"), 0o755);
  return { bin, root: workspace, target: realpathSync(target) };
}

describe("dual-name parent-shell integration", () => {
  test.each(["bash", "zsh", "fish"] as const)(
    "renders deterministic canonical and collision-guarded alias functions for %s",
    (shell) => {
      const first = buildShellInitScript(shell);
      expect(first).toBe(buildShellInitScript(shell));
      expect(first).toContain("arashi");
      expect(first).toContain("aw");
      expect(first).toMatch(shell === "fish" ? /command aw \$argv/ : /command aw "\$@"/);
      expect(first).toContain("ARASHI_DIRECTIVE_FILE");
      expect(first).toContain(`ARASHI_SHELL=${shell}`);
      expect(first).toMatch(/alias|functions|type/);
    },
  );

  test.each(["bash", "zsh"])(
    "preserves an unrelated %s aw function without executing it and defines after removal",
    (shell) => {
      if (!available(shell)) return;
      const fixture = mkdtempSync(join(tmpdir(), "arashi-aw-shell-"));
      fixtures.push(fixture);
      const init = join(fixture, "init.sh");
      writeFileSync(init, buildShellInitScript(shell as "bash" | "zsh"));
      const result = spawnSync(
        shell,
        [
          "-c",
          `aw(){ printf executed >> ${JSON.stringify(join(fixture, "sentinel"))}; }; source ${JSON.stringify(init)}; type aw; unset -f aw; source ${JSON.stringify(init)}; type aw`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(() => readFileSync(join(fixture, "sentinel"))).toThrow();
      expect(result.stdout.match(/function/g)?.length).toBeGreaterThanOrEqual(2);
    },
  );

  test.each(["bash", "zsh"])(
    "refreshes an existing managed %s aw wrapper on re-source",
    (shell) => {
      if (!available(shell)) return;
      const fixture = mkdtempSync(join(tmpdir(), "arashi-aw-managed-shell-"));
      fixtures.push(fixture);
      const init = join(fixture, "init.sh");
      writeFileSync(init, buildShellInitScript(shell as "bash" | "zsh"));
      const result = spawnSync(
        shell,
        [
          "-c",
          `aw(){ : arashi-managed-shell-wrapper:aw:v1; echo stale; }; source ${JSON.stringify(init)}; ${shell === "zsh" ? "functions aw" : "declare -f aw"}`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("ARASHI_DIRECTIVE_FILE");
      expect(result.stdout).not.toContain("echo stale");
    },
  );

  test.skipIf(!available("fish"))(
    "preserves an unrelated fish aw function without execution",
    () => {
      const fixture = mkdtempSync(join(tmpdir(), "arashi-aw-fish-"));
      fixtures.push(fixture);
      const init = join(fixture, "init.fish");
      writeFileSync(init, buildShellInitScript("fish"));
      const sentinel = join(fixture, "sentinel");
      const result = spawnSync(
        "fish",
        ["-c", `function aw; touch ${sentinel}; end; source ${init}; functions aw >/dev/null`],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(() => readFileSync(sentinel)).toThrow();
    },
  );

  test.each(["bash", "zsh", "fish"] as const)(
    "keeps one canonical managed activation block for %s",
    (shell) => {
      const block = buildShellInstallBlock(shell);
      expect(block.match(/>>> arashi shell integration >>>/g)).toHaveLength(1);
      expect(block.match(/shell init/g)).toHaveLength(1);
      expect(block.match(/arashi completion/g)).toHaveLength(1);
      expect(block).not.toContain(">>> aw shell integration >>>");
    },
  );

  test.each(["bash", "zsh", "fish"] as const)(
    "real built CLI switch --cd through actual aw changes the caller directory and cleans directives in %s",
    (shell) => {
      expect(available(shell), `${shell} must be installed for supported-shell acceptance`).toBe(
        true,
      );
      const fixture = createRealSwitchFixture();
      const command =
        shell === "fish"
          ? `command aw shell init fish | source; aw switch --all --path ${JSON.stringify(fixture.target)} --cd; set code $status; printf 'STATUS=%s\\nPWD=%s\\n' $code $PWD`
          : `eval "$(command aw shell init ${shell})"; aw switch --all --path ${JSON.stringify(fixture.target)} --cd; code=$?; printf 'STATUS=%s\\nPWD=%s\\n' "$code" "$PWD"`;
      const result = spawnSync(shell, [shell === "fish" ? "--no-config" : "-f", "-c", command], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
          PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
          TMPDIR: dirname(fixture.bin),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("STATUS=0");
      expect(result.stdout).toContain(`PWD=${fixture.target}`);
      expect(
        spawnSync("find", [dirname(fixture.bin), "-name", "arashi-directive.*"], {
          encoding: "utf8",
        }).stdout,
      ).toBe("");
    },
  );
});
