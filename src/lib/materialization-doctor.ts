import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { WorkspaceRepository } from "./config.ts";
import { exec } from "./git.ts";
import { normalizeMaterializationPath, resolveMaterializationPath } from "./materialization.ts";

export interface CollectedMaterializationDiagnostic {
  action: "copy" | "symlink" | null;
  actualKind?: "directory" | "file" | "junction" | "symlink";
  ancestorKind?: "directory" | "file" | "junction" | "symlink";
  capability?: "available" | "unavailable" | "unknown";
  destinationStatus?:
    | "ancestor-unsafe"
    | "broken"
    | "kind-mismatch"
    | "missing"
    | "misdirected"
    | "present";
  expectedKind?: "directory" | "file";
  normalizedWorktreePath?: string | null;
  path: string | null;
  repositoryId: string;
  sourceStatus?: "missing" | "present" | "unavailable";
  worktreePath?: string | null;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const entryKind = (entry: Awaited<ReturnType<typeof lstat>>) =>
  entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";

async function linkedWorktrees(
  repositoryPath: string,
  sourcePath: string,
  workspaceRoot?: string,
): Promise<string[]> {
  const output = (await exec(["worktree", "list", "--porcelain"], repositoryPath)).stdout;
  const primary = resolve(sourcePath);
  const result: string[] = [];
  for (const record of output.split(/\r?\n\r?\n/)) {
    const line = record.split(/\r?\n/).find((value) => value.startsWith("worktree "));
    if (!line || record.split(/\r?\n/).includes("bare")) continue;
    const path = line.slice("worktree ".length);
    let canonical = resolve(path);
    try {
      canonical = await realpath(path);
    } catch {
      // Prunable/missing worktrees are diagnosed by the existing worktree phase.
      continue;
    }
    if (canonical !== primary) {
      if (workspaceRoot) {
        const canonicalWorkspace = await realpath(workspaceRoot);
        const fromWorkspace = relative(canonicalWorkspace, canonical);
        if (
          resolve(workspaceRoot) !== canonicalWorkspace &&
          fromWorkspace !== ".." &&
          !fromWorkspace.startsWith(`..${sep}`)
        ) {
          result.push(resolve(workspaceRoot, fromWorkspace));
          continue;
        }
      }
      const canonicalTempRoot = await realpath(tmpdir());
      const fromTempRoot = relative(canonicalTempRoot, canonical);
      if (fromTempRoot !== ".." && !fromTempRoot.startsWith(`..${sep}`)) {
        result.push(resolve(tmpdir(), fromTempRoot));
      } else {
        result.push(resolve(path));
      }
    }
  }
  return result;
}

async function inspectDestination(
  worktreePath: string,
  normalizedPath: string,
): Promise<{
  actualKind?: "directory" | "file" | "junction" | "symlink";
  ancestorKind?: "directory" | "file" | "junction" | "symlink";
  destinationStatus: "ancestor-unsafe" | "missing" | "present";
  destinationPath: string;
}> {
  const destinationPath = resolveMaterializationPath(worktreePath, normalizedPath);
  const parts = relative(worktreePath, destinationPath).split(sep).filter(Boolean);
  let current = resolve(worktreePath);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    try {
      const entry = await lstat(current);
      const kind = entryKind(entry);
      if (index === parts.length - 1) {
        return { actualKind: kind, destinationPath, destinationStatus: "present" };
      }
      if (kind !== "directory") {
        return {
          ancestorKind: kind,
          destinationPath,
          destinationStatus: "ancestor-unsafe",
        };
      }
    } catch (error) {
      if (isMissing(error)) return { destinationPath, destinationStatus: "missing" };
      throw error;
    }
  }
  return { destinationPath, destinationStatus: "missing" };
}

export async function collectMaterializationDiagnostics(
  repositories: readonly WorkspaceRepository[],
  workspaceRoot?: string,
): Promise<CollectedMaterializationDiagnostic[]> {
  const diagnostics: CollectedMaterializationDiagnostic[] = [];
  for (const repository of repositories) {
    const copy = repository.copy ?? [];
    const symlink = repository.symlink ?? [];
    if (copy.length === 0 && symlink.length === 0) continue;
    if (!repository.sourcePath) {
      diagnostics.push({
        action: null,
        path: null,
        repositoryId: repository.name,
        sourceStatus: "unavailable",
        worktreePath: null,
      });
      continue;
    }
    const worktrees = await linkedWorktrees(repository.path, repository.sourcePath, workspaceRoot);
    if (symlink.length > 0) {
      diagnostics.push({
        action: null,
        capability: "unknown",
        path: null,
        repositoryId: repository.name,
        worktreePath: null,
      });
    }
    for (const [action, paths] of [
      ["copy", copy],
      ["symlink", symlink],
    ] as const) {
      for (const configuredPath of paths) {
        const normalizedPath = normalizeMaterializationPath(configuredPath).path;
        const sourcePath = resolveMaterializationPath(repository.sourcePath, normalizedPath);
        let expectedKind: "directory" | "file" | undefined;
        let expectedTarget: string | undefined;
        try {
          const [canonicalRoot, canonicalTarget, sourceEntry] = await Promise.all([
            realpath(repository.sourcePath),
            realpath(sourcePath),
            stat(sourcePath),
          ]);
          const fromRoot = relative(canonicalRoot, canonicalTarget);
          if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
            diagnostics.push({
              action,
              path: normalizedPath,
              repositoryId: repository.name,
              sourceStatus: "unavailable",
              worktreePath: null,
            });
          } else {
            expectedKind = sourceEntry.isDirectory() ? "directory" : "file";
            expectedTarget = canonicalTarget;
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
          diagnostics.push({
            action,
            path: normalizedPath,
            repositoryId: repository.name,
            sourceStatus: "missing",
            worktreePath: null,
          });
        }
        for (const worktreePath of worktrees) {
          const inspected = await inspectDestination(worktreePath, normalizedPath);
          const base = {
            action,
            actualKind: inspected.actualKind,
            ancestorKind: inspected.ancestorKind,
            expectedKind,
            normalizedWorktreePath: worktreePath,
            path: normalizedPath,
            repositoryId: repository.name,
            sourceStatus: "present" as const,
            worktreePath,
          };
          if (inspected.destinationStatus === "ancestor-unsafe") {
            diagnostics.push({ ...base, destinationStatus: "ancestor-unsafe" });
          } else if (!expectedKind) {
            // Missing optional sources still require ancestor-safety inspection, but
            // do not create destination ownership, freshness, or kind claims.
            continue;
          } else if (inspected.destinationStatus === "missing") {
            diagnostics.push({
              ...base,
              destinationStatus: action === "symlink" ? "broken" : "missing",
            });
          } else if (action === "copy") {
            diagnostics.push({
              ...base,
              destinationStatus:
                inspected.actualKind === expectedKind ? "present" : "kind-mismatch",
            });
          } else if (inspected.actualKind !== "symlink") {
            diagnostics.push({ ...base, destinationStatus: "misdirected" });
          } else {
            try {
              const actualTarget = await readlink(inspected.destinationPath);
              diagnostics.push({
                ...base,
                destinationStatus:
                  expectedTarget !== undefined && actualTarget === expectedTarget
                    ? "present"
                    : "misdirected",
              });
            } catch (error) {
              diagnostics.push({
                ...base,
                destinationStatus: isMissing(error) ? "broken" : "misdirected",
              });
            }
          }
        }
      }
    }
  }
  return diagnostics;
}
