import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { basename, join } from "path";
import { runArashi, runArashiWithEnv } from "../helpers/inline-hook-test-utils.ts";
import { runtime } from "../helpers/node-runtime.ts";
import { tmpdir } from "os";

const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = runtime.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("legacy configured worktree layout compatibility", () => {
  test("keeps an existing inverted-layout registration operable through list, status, switch, and remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-legacy-layout-"));
    roots.push(root);
    const branch = "legacy-layout";
    const worktreesBase = join(root, ".arashi", "worktrees");
    const legacyPath = join(worktreesBase, `${basename(root)}-${branch}`);
    const correctedNewCreatePath = join(worktreesBase, branch);
    const directivePath = join(root, "switch-directive.sh");

    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test User"]);
    await mkdir(join(root, ".arashi"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".arashi/worktrees/\nswitch-directive.sh\n");
    await writeFile(join(root, "README.md"), "legacy layout fixture\n");
    await writeFile(
      join(root, ".arashi", "config.json"),
      `${JSON.stringify(
        {
          defaults: { switch: { mode: "cd" } },
          repos: {},
          reposDir: "./repos",
          version: "1.0.0",
          worktreesDir: "./.arashi/worktrees",
        },
        null,
        2,
      )}\n`,
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture"]);
    await mkdir(worktreesBase, { recursive: true });
    await git(root, ["worktree", "add", "-b", branch, legacyPath, "HEAD"]);
    const canonicalLegacyPath = await realpath(legacyPath);

    const list = await runArashi(root, ["list", "--json"]);
    expect(list.exitCode, `${list.stdout}\n${list.stderr}`).toBe(0);
    const listedPaths = (JSON.parse(list.stdout) as { data: { worktrees: { path: string }[] } })
      .data.worktrees;
    expect(await Promise.all(listedPaths.map(({ path }) => realpath(path)))).toContain(
      canonicalLegacyPath,
    );
    expect(await exists(correctedNewCreatePath)).toBe(false);

    const status = await runArashi(legacyPath, ["status", "--json"]);
    expect(status.exitCode, `${status.stdout}\n${status.stderr}`).toBe(0);
    const statusData = (
      JSON.parse(status.stdout) as {
        data: { repositories: { branch: { localBranch: string }; path: string }[] };
      }
    ).data;
    expect(statusData.repositories).toHaveLength(1);
    expect(statusData.repositories[0]?.branch.localBranch).toBe(branch);
    expect(await realpath(statusData.repositories[0]!.path)).toBe(canonicalLegacyPath);
    expect(await exists(correctedNewCreatePath)).toBe(false);

    const switched = await runArashiWithEnv(
      root,
      ["switch", canonicalLegacyPath, "--path", "--cd"],
      { ARASHI_DIRECTIVE_FILE: directivePath, ARASHI_SHELL: "bash" },
    );
    expect(switched.exitCode, `${switched.stdout}\n${switched.stderr}`).toBe(0);
    expect(
      await realpath(
        (await readFile(directivePath, "utf8"))
          .trim()
          .replace(/^cd -- '/, "")
          .replace(/'$/, ""),
      ),
    ).toBe(canonicalLegacyPath);
    expect(await exists(legacyPath)).toBe(true);
    expect(await exists(correctedNewCreatePath)).toBe(false);

    const removed = await runArashi(root, ["remove", branch, "--force", "--json"]);
    expect(removed.exitCode, `${removed.stdout}\n${removed.stderr}`).toBe(0);
    expect(await exists(legacyPath)).toBe(false);
    expect(await exists(correctedNewCreatePath)).toBe(false);
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(canonicalLegacyPath);
  });
});
