import { isAbsolute, relative, sep } from "path";
import type { Config } from "./config.ts";
import { resolveEffectivePersonalConfig } from "./user-config.ts";
import { DEFAULT_WORKTREES_DIR } from "./worktree-location.ts";
import { resolveGitMainWorktree } from "./workspace-context.ts";

/** Resolve ignore inputs independently of the workspace state being edited. */
export async function personalManagedIgnoreOptions(workspaceRoot: string, config: Config) {
  const mainRoot = (await resolveGitMainWorktree(workspaceRoot)) ?? workspaceRoot;
  const effective = await resolveEffectivePersonalConfig({
    mainRoot,
    workspaceConfig: config,
    workspaceWorktreesDirAuthored: config.worktreesDir !== undefined,
    builtInWorktreesDir: DEFAULT_WORKTREES_DIR,
  });
  const personal = effective.sources.worktreesDir === "user";
  const worktreesDir = personal
    ? relative(workspaceRoot, effective.worktreesBase)
    : (config.worktreesDir ?? DEFAULT_WORKTREES_DIR);
  return {
    reposDir: config.reposDir,
    workspaceRoot,
    worktreesDir,
    skipWorktreesDir:
      personal &&
      (worktreesDir === ".." || worktreesDir.startsWith(`..${sep}`) || isAbsolute(worktreesDir)),
  };
}
