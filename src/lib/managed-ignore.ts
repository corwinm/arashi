import { dirname, isAbsolute, posix, resolve, win32 } from "path";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { ArashiError } from "./errors.ts";
import { exec as gitExec } from "./git.ts";
import { runtime } from "./runtime.ts";
import { normalizeSpawnEnvironment } from "./shell-directives.ts";

export interface SafeManagedPath {
  input: string;
  rule: string;
  safety: "safe";
}

export type UnsafeManagedPathReason =
  | "absolute"
  | "control-character"
  | "parent-traversal"
  | "repository-root";

export interface UnsafeManagedPath {
  input: string;
  reason: UnsafeManagedPathReason;
  safety: "unsafe";
}

export type ManagedPathClassification = SafeManagedPath | UnsafeManagedPath;

export type ManagedIgnoreScope = "local" | "tracked" | "none";

export interface ManagedIgnoreSource {
  path: string;
  pattern: string;
  type: "tracked" | "local" | "global";
}

export interface ManagedIgnorePathResult {
  input: string;
  rule?: string;
  safety: "non-applicable" | "safe" | "unsafe";
  safetyReason?: UnsafeManagedPathReason;
  source?: ManagedIgnoreSource;
  status: "already-ignored" | "applied" | "non-applicable" | "planned" | "unignored" | "unsafe";
}

export interface ManagedIgnoreInspection {
  localExcludePath: string;
  paths: ManagedIgnorePathResult[];
  scope: ManagedIgnoreScope;
  staleRules: ManagedIgnoreStaleRule[];
  storedPreference: ManagedIgnoreScope | null;
  trackedIgnorePath: string;
}

export interface ManagedIgnoreStaleRule {
  path: string;
  rule: string;
  target: "local" | "tracked";
}

export interface InspectManagedIgnoreOptions {
  dryRun?: boolean;
  reposDir: string;
  requestedScope?: string;
  workspaceRoot: string;
  worktreesDir: string;
}

export interface RepositoryManagedIgnoreOptions extends InspectManagedIgnoreOptions {
  repositoryType?: "bare" | "non-bare";
}

export interface ManagedIgnoreReconciliation extends ManagedIgnoreInspection {
  appliedRules: string[];
  attempted: boolean;
  changed: boolean;
  fileChanges: { local: boolean; preference: boolean; tracked: boolean };
  plannedRules: string[];
  restored: boolean;
  staleRules: ManagedIgnoreStaleRule[];
  targetPath?: string;
  targetType?: "local" | "tracked";
  warnings: string[];
}

export class ManagedIgnoreError extends Error {
  readonly code = "MANAGED_IGNORE_RECONCILIATION_FAILED";
  readonly details: {
    attempted: boolean;
    changed: boolean;
    phase: "apply" | "inspection";
    restored: boolean;
    restorationError?: string;
    targetPath?: string;
  };

  constructor(message: string, details: ManagedIgnoreError["details"], options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedIgnoreError";
    this.details = details;
  }
}

interface ManagedIgnoreSnapshot {
  files: Array<{ content: string | null; path: string }>;
  preference: string | null;
  workspaceRoot: string;
}

const reconciliationSnapshots = new WeakMap<ManagedIgnoreReconciliation, ManagedIgnoreSnapshot>();
const BLOCK_START = "# BEGIN Arashi managed ignore rules";
const BLOCK_END = "# END Arashi managed ignore rules";

export const classifyManagedPaths = (paths: string[]): ManagedPathClassification[] => {
  const seen = new Set<string>();
  const candidates: ManagedPathClassification[] = [];

  for (const input of paths) {
    const hasControlCharacter = [...input].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    });
    if (hasControlCharacter) {
      candidates.push({ input, reason: "control-character", safety: "unsafe" });
      continue;
    }
    const slashPath = input.replaceAll("\\", "/");
    const normalized = posix.normalize(slashPath).replace(/^\.\//, "").replace(/\/$/, "");
    if (normalized === "" || normalized === ".") {
      candidates.push({ input, reason: "repository-root", safety: "unsafe" });
      continue;
    }
    if (posix.isAbsolute(normalized) || win32.isAbsolute(input)) {
      candidates.push({ input, reason: "absolute", safety: "unsafe" });
      continue;
    }
    if (normalized === ".." || normalized.startsWith("../")) {
      candidates.push({ input, reason: "parent-traversal", safety: "unsafe" });
      continue;
    }

    const escaped = normalized.replace(/([*?[\]])/g, "\\$1").replace(/^([#!])/, "\\$1");
    const rule = `/${escaped}/`;
    if (seen.has(rule)) {
      continue;
    }
    seen.add(rule);
    candidates.push({ input, rule, safety: "safe" });
  }

  return candidates;
};

const resolveGitPath = (workspaceRoot: string, path: string): string =>
  isAbsolute(path) ? path : resolve(workspaceRoot, path);

const inspectEffectiveSource = async (
  workspaceRoot: string,
  rule: string,
  localExcludePath: string,
): Promise<ManagedIgnoreSource | undefined> => {
  const args = ["check-ignore", "-z", "-v", "--no-index", "--stdin"];
  const process = runtime.spawn(["git", ...args], {
    cwd: workspaceRoot,
    env: normalizeSpawnEnvironment(globalThis.process.env),
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  process.stdin?.end(`${rule}\0`);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (process.spawnError) {
    throw new ArashiError(`Failed to spawn git command: ${process.spawnError.message}`, {
      args,
      cwd: workspaceRoot,
      exitCode: -1,
      stderr: process.spawnError.message,
      stdout,
    });
  }
  if (exitCode === 1) {
    return undefined;
  }
  if (exitCode !== 0) {
    const errorMessage = stderr.trim() || stdout.trim() || "Git command failed with no output";
    throw new ArashiError(`Git command failed: ${errorMessage}`, {
      args,
      cwd: workspaceRoot,
      exitCode,
      stderr,
      stdout,
    });
  }
  const [sourcePath = "", , pattern = ""] = stdout.split("\0");
  if (sourcePath.length === 0 || pattern.length === 0) {
    throw new Error("Git returned malformed managed-ignore source data.");
  }
  const absoluteSource = resolveGitPath(workspaceRoot, sourcePath);
  let type: ManagedIgnoreSource["type"] = "global";
  if (absoluteSource === localExcludePath) {
    type = "local";
  } else if (sourcePath === ".gitignore" || sourcePath.endsWith("/.gitignore")) {
    type = "tracked";
  }
  return { path: sourcePath, pattern, type };
};

export const inspectManagedIgnore = async ({
  reposDir,
  requestedScope,
  workspaceRoot,
  worktreesDir,
}: InspectManagedIgnoreOptions): Promise<ManagedIgnoreInspection> => {
  let storedValue: string | null = null;
  try {
    const result = await gitExec(
      ["config", "--local", "--get", "arashi.ignoreScope"],
      workspaceRoot,
    );
    storedValue = result.stdout.trim() || null;
  } catch (error) {
    if (!(error instanceof ArashiError && error.context.exitCode === 1)) {
      throw error;
    }
  }
  const validScopes = new Set<ManagedIgnoreScope>(["local", "tracked", "none"]);
  if (storedValue !== null && !validScopes.has(storedValue as ManagedIgnoreScope)) {
    throw new Error(
      `Invalid clone-local arashi.ignoreScope value '${storedValue}'. Run \`git config --local --unset arashi.ignoreScope\` or \`arashi init --ignore-scope local\`.`,
    );
  }
  if (requestedScope !== undefined && !validScopes.has(requestedScope as ManagedIgnoreScope)) {
    throw new Error("Invalid ignore scope. Expected one of: local, tracked, none.");
  }
  const storedPreference = storedValue as ManagedIgnoreScope | null;
  const scope = (requestedScope as ManagedIgnoreScope | undefined) ?? storedPreference ?? "local";
  const localPathResult = await gitExec(["rev-parse", "--git-path", "info/exclude"], workspaceRoot);
  const localExcludePath = resolveGitPath(workspaceRoot, localPathResult.stdout.trim());
  const trackedIgnorePath = resolve(workspaceRoot, ".gitignore");
  const classifications = classifyManagedPaths([reposDir, worktreesDir]);
  const paths: ManagedIgnorePathResult[] = [];

  for (const classification of classifications) {
    if (classification.safety === "unsafe") {
      paths.push({
        input: classification.input,
        safety: "unsafe",
        safetyReason: classification.reason,
        status: "unsafe",
      });
      continue;
    }
    const effectivePath = `${posix
      .normalize(classification.input.replaceAll("\\", "/"))
      .replace(/^\.\//, "")
      .replace(/\/$/, "")}/`;
    const source = await inspectEffectiveSource(workspaceRoot, effectivePath, localExcludePath);
    paths.push({
      input: classification.input,
      rule: classification.rule,
      safety: "safe",
      source,
      status: source ? "already-ignored" : "unignored",
    });
  }

  const safeRules = new Set(paths.flatMap((path) => (path.rule ? [path.rule] : [])));
  const staleRules: ManagedIgnoreStaleRule[] = [];
  for (const [target, path] of [
    ["local", localExcludePath],
    ["tracked", trackedIgnorePath],
  ] as const) {
    const rules = getOwnedRules(await readOptionalFile(path));
    staleRules.push(
      ...rules.filter((rule) => !safeRules.has(rule)).map((rule) => ({ path, rule, target })),
    );
  }

  return {
    localExcludePath,
    paths,
    scope,
    staleRules,
    storedPreference,
    trackedIgnorePath,
  };
};

const readOptionalFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const assertNotSymlink = async (path: string): Promise<void> => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to modify symbolic-link ignore file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const getOwnedRules = (content: string | null): string[] => {
  if (!content) {
    return [];
  }
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END, start + BLOCK_START.length);
  if (start === -1 || end === -1) {
    return [];
  }
  return content
    .slice(start + BLOCK_START.length, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
};

const replaceOwnedBlock = (content: string | null, rules: string[]): string | null => {
  if (content === null && rules.length === 0) {
    return null;
  }
  const original = content ?? "";
  const start = original.indexOf(BLOCK_START);
  const endMarkerIndex = original.indexOf(BLOCK_END, Math.max(0, start));
  const block = rules.length > 0 ? `${BLOCK_START}\n${rules.join("\n")}\n${BLOCK_END}` : "";
  let next = original;
  if (start !== -1 && endMarkerIndex !== -1) {
    const after = endMarkerIndex + BLOCK_END.length;
    next = `${original.slice(0, start)}${block}${original.slice(after)}`;
  } else if (block) {
    let separator = "\n\n";
    if (original.length === 0) {
      separator = "";
    } else if (original.endsWith("\n")) {
      separator = "\n";
    }
    next = `${original}${separator}${block}\n`;
  } else {
    next = original;
  }
  return next.replace(/^\n(?=# BEGIN)/, "");
};

const updateStoredPreference = async (
  workspaceRoot: string,
  scope: ManagedIgnoreScope,
): Promise<void> => {
  if (scope === "local") {
    try {
      await gitExec(["config", "--local", "--unset-all", "arashi.ignoreScope"], workspaceRoot);
    } catch (error) {
      if (!(error instanceof ArashiError && error.context.exitCode === 5)) {
        throw error;
      }
    }
    return;
  }
  await gitExec(["config", "--local", "arashi.ignoreScope", scope], workspaceRoot);
};

export const reconcileManagedIgnore = async (
  options: InspectManagedIgnoreOptions,
): Promise<ManagedIgnoreReconciliation> => {
  let inspection: ManagedIgnoreInspection;
  try {
    inspection = await inspectManagedIgnore(options);
  } catch (error) {
    throw new ManagedIgnoreError(
      error instanceof Error ? error.message : String(error),
      { attempted: false, changed: false, phase: "inspection", restored: false },
      { cause: error },
    );
  }
  const targetType = inspection.scope === "none" ? undefined : inspection.scope;
  const targetPath =
    targetType === "local"
      ? inspection.localExcludePath
      : targetType === "tracked"
        ? inspection.trackedIgnorePath
        : undefined;
  const fileStates = {
    local: {
      content: await readOptionalFile(inspection.localExcludePath),
      path: inspection.localExcludePath,
    },
    tracked: {
      content: await readOptionalFile(inspection.trackedIgnorePath),
      path: inspection.trackedIgnorePath,
    },
  };
  const ownedRules = {
    local: getOwnedRules(fileStates.local.content),
    tracked: getOwnedRules(fileStates.tracked.content),
  };
  const safeRules = new Set(
    inspection.paths.flatMap((path) => (path.safety === "safe" && path.rule ? [path.rule] : [])),
  );
  const staleRules = inspection.staleRules;
  const migrateOwnedRules =
    options.requestedScope !== undefined || inspection.storedPreference !== null;
  const otherType =
    migrateOwnedRules && targetType === "local"
      ? "tracked"
      : migrateOwnedRules && targetType === "tracked"
        ? "local"
        : undefined;
  const missingPaths = inspection.paths.filter((path) => {
    if (path.safety !== "safe" || !path.rule) {
      return false;
    }
    if (path.status === "unignored") {
      return true;
    }
    return (
      otherType !== undefined &&
      path.source?.type === otherType &&
      ownedRules[otherType].includes(path.rule)
    );
  });
  const plannedRules = targetType ? missingPaths.map((path) => path.rule as string) : [];
  const warnings =
    inspection.scope === "none"
      ? [
          ...missingPaths.map(
            (path) => `Managed path '${path.rule}' remains unignored because scope is none.`,
          ),
          ...staleRules.map(
            (stale) =>
              `Stale Arashi-owned rule '${stale.rule}' remains unchanged because scope is none.`,
          ),
        ]
      : [];
  const nextContents = {
    local:
      targetType === undefined
        ? fileStates.local.content
        : targetType === "local"
          ? replaceOwnedBlock(
              fileStates.local.content,
              [...ownedRules.local.filter((rule) => safeRules.has(rule)), ...plannedRules].filter(
                (rule, index, rules) => rules.indexOf(rule) === index,
              ),
            )
          : migrateOwnedRules
            ? replaceOwnedBlock(fileStates.local.content, [])
            : fileStates.local.content,
    tracked:
      targetType === undefined
        ? fileStates.tracked.content
        : targetType === "tracked"
          ? replaceOwnedBlock(
              fileStates.tracked.content,
              [...ownedRules.tracked.filter((rule) => safeRules.has(rule)), ...plannedRules].filter(
                (rule, index, rules) => rules.indexOf(rule) === index,
              ),
            )
          : migrateOwnedRules
            ? replaceOwnedBlock(fileStates.tracked.content, [])
            : fileStates.tracked.content,
  };
  const filePlans = (["local", "tracked"] as const).filter(
    (type) => nextContents[type] !== fileStates[type].content,
  );
  const preferenceWouldChange =
    options.requestedScope !== undefined &&
    (inspection.scope === "local"
      ? inspection.storedPreference !== null
      : inspection.storedPreference !== inspection.scope);
  const result: ManagedIgnoreReconciliation = {
    ...inspection,
    appliedRules: [],
    attempted: filePlans.length > 0 || preferenceWouldChange,
    changed: false,
    fileChanges: { local: false, preference: false, tracked: false },
    paths: inspection.paths.map((path) =>
      plannedRules.includes(path.rule ?? "")
        ? { ...path, status: options.dryRun ? "planned" : "applied" }
        : path,
    ),
    plannedRules,
    restored: false,
    staleRules,
    targetPath,
    targetType,
    warnings,
  };

  const snapshot: ManagedIgnoreSnapshot = {
    files: [],
    preference: inspection.storedPreference,
    workspaceRoot: options.workspaceRoot,
  };
  reconciliationSnapshots.set(result, snapshot);
  if (options.dryRun) {
    return result;
  }

  let mutationStarted = false;
  try {
    if (preferenceWouldChange) {
      mutationStarted = true;
      await updateStoredPreference(options.workspaceRoot, inspection.scope);
      result.fileChanges.preference = true;
    }
    for (const type of filePlans) {
      const nextContent = nextContents[type];
      if (nextContent === null) {
        continue;
      }
      mutationStarted = true;
      await mkdir(dirname(fileStates[type].path), { recursive: true });
      await assertNotSymlink(fileStates[type].path);
      snapshot.files.push({
        content: fileStates[type].content,
        path: fileStates[type].path,
      });
      await writeFile(fileStates[type].path, nextContent);
      result.fileChanges[type] = true;
    }
    result.appliedRules = plannedRules;
  } catch (error) {
    result.changed = mutationStarted;
    if (mutationStarted) {
      try {
        await restoreManagedIgnore(result);
      } catch (restoreError) {
        throw new ManagedIgnoreError(
          `Managed ignore reconciliation failed and restoration also failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            attempted: true,
            changed: result.changed,
            phase: "apply",
            restorationError:
              restoreError instanceof Error ? restoreError.message : String(restoreError),
            restored: false,
            ...(targetPath ? { targetPath } : {}),
          },
          {
            cause: new AggregateError(
              [error, restoreError],
              "Managed ignore apply and restore failed",
            ),
          },
        );
      }
    }
    throw new ManagedIgnoreError(
      error instanceof Error ? error.message : String(error),
      {
        attempted: mutationStarted,
        changed: result.changed,
        phase: "apply",
        restored: result.restored,
        ...(targetPath ? { targetPath } : {}),
      },
      { cause: error },
    );
  }
  result.changed = filePlans.length > 0 || preferenceWouldChange;
  return result;
};

/**
 * Report managed paths for configured init rooted at a bare Git directory.
 * These paths are administrative locations, not paths in a working tree, so
 * this flow intentionally avoids effective-ignore inspection and file writes.
 */
export const inspectBareManagedIgnore = async (
  options: InspectManagedIgnoreOptions,
): Promise<ManagedIgnoreInspection> => {
  const validScopes = new Set<ManagedIgnoreScope>(["local", "tracked", "none"]);
  let storedValue: string | null = null;
  try {
    const result = await gitExec(
      ["config", "--local", "--get", "arashi.ignoreScope"],
      options.workspaceRoot,
    );
    storedValue = result.stdout.trim() || null;
  } catch (error) {
    if (!(error instanceof ArashiError && error.context.exitCode === 1)) {
      throw error;
    }
  }
  if (storedValue !== null && !validScopes.has(storedValue as ManagedIgnoreScope)) {
    throw new Error(
      `Invalid clone-local arashi.ignoreScope value '${storedValue}'. Run \`git config --local --unset arashi.ignoreScope\` or \`arashi init --ignore-scope local\`.`,
    );
  }
  if (
    options.requestedScope !== undefined &&
    !validScopes.has(options.requestedScope as ManagedIgnoreScope)
  ) {
    throw new Error("Invalid ignore scope. Expected one of: local, tracked, none.");
  }

  const storedPreference = storedValue as ManagedIgnoreScope | null;
  const scope =
    (options.requestedScope as ManagedIgnoreScope | undefined) ?? storedPreference ?? "local";
  const paths: ManagedIgnorePathResult[] = classifyManagedPaths([
    options.reposDir,
    options.worktreesDir,
  ]).map((path) =>
    path.safety === "unsafe"
      ? {
          input: path.input,
          safety: "unsafe" as const,
          safetyReason: path.reason,
          status: "unsafe" as const,
        }
      : {
          input: path.input,
          rule: path.rule,
          safety: "non-applicable" as const,
          status: "non-applicable" as const,
        },
  );
  return {
    localExcludePath: resolve(options.workspaceRoot, "info/exclude"),
    paths,
    scope,
    staleRules: [],
    storedPreference,
    trackedIgnorePath: resolve(options.workspaceRoot, ".gitignore"),
  };
};

export const reconcileBareManagedIgnore = async (
  options: InspectManagedIgnoreOptions,
): Promise<ManagedIgnoreReconciliation> => {
  const inspection = await inspectBareManagedIgnore(options);
  const preferenceWouldChange =
    options.requestedScope !== undefined &&
    (inspection.scope === "local"
      ? inspection.storedPreference !== null
      : inspection.storedPreference !== inspection.scope);
  const result: ManagedIgnoreReconciliation = {
    ...inspection,
    appliedRules: [],
    attempted: preferenceWouldChange,
    changed: false,
    fileChanges: { local: false, preference: false, tracked: false },
    plannedRules: [],
    restored: false,
    warnings: [],
  };
  reconciliationSnapshots.set(result, {
    files: [],
    preference: inspection.storedPreference,
    workspaceRoot: options.workspaceRoot,
  });
  if (!options.dryRun && preferenceWouldChange) {
    await updateStoredPreference(options.workspaceRoot, inspection.scope);
    result.attempted = true;
    result.changed = true;
    result.fileChanges.preference = true;
  }
  return result;
};

const resolveManagedIgnoreRepositoryType = async (
  options: RepositoryManagedIgnoreOptions,
): Promise<"bare" | "non-bare"> => {
  if (options.repositoryType) return options.repositoryType;
  const result = await gitExec(["rev-parse", "--is-bare-repository"], options.workspaceRoot);
  const value = result.stdout.trim();
  if (value === "true") return "bare";
  if (value === "false") return "non-bare";
  throw new Error(`Git returned an invalid repository type: '${value}'.`);
};

/** Inspect configured managed paths according to the workspace repository type. */
export const inspectRepositoryManagedIgnore = async (
  options: RepositoryManagedIgnoreOptions,
): Promise<ManagedIgnoreInspection> =>
  (await resolveManagedIgnoreRepositoryType(options)) === "bare"
    ? await inspectBareManagedIgnore(options)
    : await inspectManagedIgnore(options);

/** Reconcile configured managed paths according to the workspace repository type. */
export const reconcileRepositoryManagedIgnore = async (
  options: RepositoryManagedIgnoreOptions,
): Promise<ManagedIgnoreReconciliation> =>
  (await resolveManagedIgnoreRepositoryType(options)) === "bare"
    ? await reconcileBareManagedIgnore(options)
    : await reconcileManagedIgnore(options);

export const restoreManagedIgnore = async (
  reconciliation: ManagedIgnoreReconciliation,
): Promise<void> => {
  const snapshot = reconciliationSnapshots.get(reconciliation);
  if (!snapshot) {
    throw new Error("Managed ignore reconciliation cannot be restored.");
  }
  for (const file of snapshot.files) {
    if (file.content === null) {
      try {
        await unlink(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    } else {
      await assertNotSymlink(file.path);
      await writeFile(file.path, file.content);
    }
  }
  if (snapshot.preference === null) {
    await updateStoredPreference(snapshot.workspaceRoot, "local");
  } else {
    await gitExec(
      ["config", "--local", "arashi.ignoreScope", snapshot.preference],
      snapshot.workspaceRoot,
    );
  }
  reconciliation.changed = false;
  reconciliation.restored = true;
  reconciliation.fileChanges = { local: false, preference: false, tracked: false };
};
