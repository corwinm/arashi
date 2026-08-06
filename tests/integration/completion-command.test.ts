import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const cli = ["src/index.ts"];
const run = (args: string[]) =>
  spawnSync(process.execPath, [...cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

describe("completion command and generated artifacts", () => {
  test.each(["bash", "zsh", "fish"])("emits isolated sourceable %s completion", (shell) => {
    const result = run(["completion", shell]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("command arashi");
    expect(result.stdout).not.toMatch(/Downloading|Installing|WARNING|Arashi v/);
    if (shell === "bash") {
      expect(result.stdout).toContain("complete -F _arashi arashi");
      expect(spawnSync("bash", ["-n"], { input: result.stdout }).status).toBe(0);
    } else if (shell === "zsh") {
      expect(result.stdout).toContain("autoload -Uz compinit && compinit -i");
      expect(result.stdout).toContain("compdef _arashi arashi");
      expect(spawnSync("zsh", ["-n"], { input: result.stdout }).status).toBe(0);
    } else {
      expect(result.stdout).toContain('string escape --no-quoted -- "$fields[$index]"');
      expect(result.stdout).toContain('"$fields[$description_index]"');
      expect(result.stdout).toContain("complete -c arashi");
    }
  });

  test.each([[[]], [["powershell"]]])("rejects missing or unsupported shell %j cleanly", (args) => {
    const result = run(["completion", ...args]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("bash, zsh, fish");
  });

  test("keeps wrapper generation separate from completion", () => {
    const wrapper = run(["shell", "init", "bash"]);
    expect(wrapper.status).toBe(0);
    expect(wrapper.stdout).toContain("ARASHI_DIRECTIVE_FILE");
    expect(wrapper.stdout).not.toContain("complete -F");
    expect(wrapper.stdout).not.toContain("arashi completion");
  });

  test("registers public completion and excludes the hidden query from help", () => {
    const root = run(["--help"]);
    const help = run(["completion", "--help"]);
    expect(root.stdout).toContain("completion");
    expect(help.stdout).not.toContain("__query");
  });
});
