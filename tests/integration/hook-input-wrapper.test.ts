import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const wrapperEntrypoints = ["bin/arashi", "bin/arashi.js", "bin/arashi.ps1", "bin/arashi.bat"];
const tempRoots: string[] = [];

const run = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};

const runPty = (
  cwd: string,
  prompt: string,
  response: string,
  command: string[],
  env: NodeJS.ProcessEnv,
) =>
  spawnSync(
    process.execPath,
    [
      join(root, "tests/helpers/pty-command.mjs"),
      cwd,
      prompt,
      response,
      "30",
      JSON.stringify(command),
    ],
    { cwd, encoding: "utf8", env },
  );

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("installed wrapper hook-input acceptance", () => {
  test("all package entrypoints preserve stdin for hook-eligible commands", async () => {
    const sources = new Map(
      await Promise.all(
        wrapperEntrypoints.map(
          async (entrypoint) =>
            [entrypoint, await readFile(join(root, entrypoint), "utf8")] as const,
        ),
      ),
    );

    expect(sources.get("bin/arashi")).toContain('[ "$command" = "list" ]');
    expect(sources.get("bin/arashi")).not.toMatch(/command" = "remove"[\s\S]{0,120}0<&-/);
    expect(sources.get("bin/arashi.js")).toMatch(/stdio:\s*"inherit"/);
    expect(sources.get("bin/arashi.ps1")).not.toMatch(/StandardInput|RedirectStandardInput/);
    expect(sources.get("bin/arashi.bat")).not.toMatch(/<\s*nul/i);
  });

  test.runIf(process.platform !== "win32" && process.env.ARASHI_WRAPPER_ACCEPTANCE === "1")(
    "executes the installed POSIX and JavaScript wrappers with prompt-gated terminal stdin",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "arashi-wrapper-hook-input-"));
      tempRoots.push(fixture);
      const repo = join(fixture, "repo");
      const home = join(fixture, "home");
      const hooks = join(home, ".arashi", "hooks");
      const record = join(fixture, "answers.txt");
      await mkdir(repo, { recursive: true });
      await mkdir(hooks, { recursive: true });
      run("git", ["init", "-b", "main"], repo);
      run("git", ["config", "user.email", "test@example.com"], repo);
      run("git", ["config", "user.name", "Test User"], repo);
      await writeFile(join(repo, "README.md"), "test\n");
      run("git", ["add", "README.md"], repo);
      run("git", ["commit", "-m", "initial"], repo);

      const wrapper = join(root, "bin", "arashi");
      const jsWrapper = join(root, "bin", "arashi.js");
      await chmod(wrapper, 0o755);
      const env = { ...process.env, HOME: home, HOOK_INPUT_RECORD: record, NO_COLOR: "1" };
      run(wrapper, ["init", "--zero-config"], repo, env);

      await writeFile(
        join(hooks, "pre-create.sh"),
        `#!/usr/bin/env bash\nprintf 'wrapper answer: ' >&2\nIFS= read -r answer\nprintf 'posix:%s\\n' "$answer" >> "$HOOK_INPUT_RECORD"\n[ "$answer" = yes ]\n`,
        { mode: 0o755 },
      );
      const posixCreate = runPty(
        repo,
        "wrapper answer:",
        "yes",
        [wrapper, "create", "feature/posix"],
        env,
      );
      expect(posixCreate.status, `${posixCreate.stdout}\n${posixCreate.stderr}`).toBe(0);

      const jsCreate = runPty(
        repo,
        "wrapper answer:",
        "yes",
        [process.execPath, jsWrapper, "create", "feature/javascript"],
        env,
      );
      expect(jsCreate.status, `${jsCreate.stdout}\n${jsCreate.stderr}`).toBe(0);

      await rm(join(hooks, "pre-create.sh"));
      await writeFile(
        join(hooks, "pre-remove.sh"),
        `#!/usr/bin/env bash\nprintf 'remove answer: ' >&2\nIFS= read -r answer\nprintf 'remove:%s\\n' "$answer" >> "$HOOK_INPUT_RECORD"\n[ "$answer" = yes ]\n`,
        { mode: 0o755 },
      );
      const redirected = join(fixture, "remove.stdout");
      const remove = runPty(
        repo,
        "remove answer:",
        "yes",
        [
          "/bin/bash",
          "-c",
          'exec "$1" remove feature/posix --force >"$2"',
          "arashi-wrapper-test",
          wrapper,
          redirected,
        ],
        env,
      );
      expect(remove.status, `${remove.stdout}\n${remove.stderr}`).toBe(0);
      expect(await readFile(record, "utf8")).toBe("posix:yes\nposix:yes\nremove:yes\n");
      expect(await readFile(redirected, "utf8")).toContain("Successfully removed");
    },
    60_000,
  );
});
