import { isAbsolute, relative, sep } from "path";
import type { Config } from "./config.ts";
import { resolveEffectivePersonalConfig } from "./user-config.ts";
import {
  resolveConfiguredBuiltInWorktreesDir,
  resolveGitMainWorktree,
} from "./workspace-context.ts";

/** Resolve ignore inputs independently of the workspace state being edited. */
export async function personalManagedIgnoreOptions(workspaceRoot: string, config: Config) {
  const mainRoot = (await resolveGitMainWorktree(workspaceRoot)) ?? workspaceRoot;
  const builtInWorktreesDir = await resolveConfiguredBuiltInWorktreesDir(workspaceRoot);
  const effective = await resolveEffectivePersonalConfig({
    mainRoot,
    workspaceConfig: config,
    workspaceRoot,
    workspaceWorktreesDirAuthored: config.worktreesDir !== undefined,
    builtInWorktreesDir,
  });
  const personal = effective.sources.worktreesDir === "user";
  // Personal roots belong to primary, but repository rules belong to the active
  // configuration checkout. Scoped reconciliation preserves that distinction.
  const ignoreRoot = personal ? mainRoot : workspaceRoot;
  const worktreesDir = personal
    ? relative(ignoreRoot, effective.worktreesBase)
    : (effective.config.worktreesDir ?? builtInWorktreesDir);
  return {
    reposDir: config.reposDir,
    workspaceRoot,
    worktreesWorkspaceRoot: personal ? ignoreRoot : undefined,
    worktreesDir,
    skipWorktreesDir:
      personal &&
      (worktreesDir === ".." || worktreesDir.startsWith(`..${sep}`) || isAbsolute(worktreesDir)),
  };
}
