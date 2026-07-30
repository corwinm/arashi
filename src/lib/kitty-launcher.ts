import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, sep } from "node:path";
import type { SwitchCandidate } from "../core/switch.ts";
import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import type {
  LaunchSwitchResult,
  SwitchProcessRunner,
  SwitchProcessRunOptions,
} from "./switch-launcher.ts";

const KITTY_MINIMUM_VERSION = "0.43.0";
const KITTY_BUNDLE_KITTEN = "/Applications/kitty.app/Contents/MacOS/kitten";
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 50;
const MALFORMED_LOCK_STALE_MS = 30_000;
const OWNER_FILE = "owner.json";

export interface KittyWorktreeMetadata {
  canonicalPath: string;
  identity: string;
  sessionName: string;
  title: string;
}

export interface KittyWindowState {
  cwd: string;
  id: number;
  isFocused: boolean;
  lastFocusedAt: number;
  osWindowId: number;
  sessionName: string;
  tabId: number;
  title: string;
  userVars: Record<string, string>;
}

interface ProcessDependencies {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  runProcess: SwitchProcessRunner;
  pathExists?: (path: string) => Promise<boolean>;
}

export interface LaunchManagedKittyDependencies {
  env?: Record<string, string | undefined>;
  lockOptions?: Omit<KittyIdentityLockOptions, "lockRoot">;
  lockRoot?: string;
  pathExists?: (path: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  runProcess: SwitchProcessRunner;
}

export interface KittyIdentityLockOptions {
  beforeLockOwnerWrite?: () => Promise<void>;
  beforeMissingLockRecoveryCheck?: () => Promise<void>;
  beforeRecoveryGuardOwnerWrite?: () => Promise<void>;
  beforeStaleLockRename?: () => Promise<void>;
  lockRoot?: string;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  pollIntervalMs?: number;
  readReleasedLockOwner?: (path: string) => Promise<string>;
  removeReleasedLock?: (path: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export interface KittyIdentityLock {
  path: string;
  release: () => Promise<void>;
}

interface LockOwner {
  createdAt: number;
  identity: string;
  owner: string;
  pid: number;
}

export function parseKittyVersion(output: string): string | null {
  const match = output.match(/\b(?:kitty|kitten)\s+(\d+\.\d+\.\d+)\b/i);
  return match?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function resolveKittenExecutable(deps: ProcessDependencies): Promise<string> {
  const lookup = deps.platform === "win32" ? ["where", "kitten"] : ["which", "kitten"];
  const result = await deps.runProcess(lookup, { cwd: process.cwd(), env: deps.env });
  if (result.exitCode === 0) {
    const resolved = result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    if (resolved) return resolved;
  }

  const pathExists = deps.pathExists ?? defaultPathExists;
  if (deps.platform === "darwin" && (await pathExists(KITTY_BUNDLE_KITTEN))) {
    return KITTY_BUNDLE_KITTEN;
  }

  throwKittyFailure(
    "version-preflight",
    "Managed Kitty was detected, but the `kitten` executable was not found on inherited PATH or in the standard macOS Kitty app bundle.",
  );
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function deriveKittyWorktreeMetadata(
  candidate: SwitchCandidate,
): Promise<KittyWorktreeMetadata> {
  let resolved: string;
  try {
    resolved = await realpath(candidate.worktreePath);
  } catch {
    throwKittyFailure(
      "identity",
      "Managed Kitty could not resolve the selected worktree to a canonical real path.",
      { path: candidate.worktreePath },
    );
  }
  let canonicalPath = normalize(resolved);
  const root = parse(canonicalPath).root;
  while (canonicalPath.length > root.length && canonicalPath.endsWith(sep)) {
    canonicalPath = canonicalPath.slice(0, -sep.length);
  }
  if (!isAbsolute(canonicalPath)) {
    throwKittyFailure(
      "identity",
      "The selected Kitty worktree path did not resolve to an absolute path.",
    );
  }

  const digest = createHash("sha256").update(canonicalPath, "utf8").digest("hex");
  const label = `${candidate.repoName}: ${candidate.branchName}`;
  return {
    canonicalPath,
    identity: `arashi-v1-${digest}`,
    sessionName: label,
    title: label,
  };
}

export function parseKittyState(stdout: string): KittyWindowState[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throwKittyFailure("inspection-validation", "Kitty returned malformed structured state JSON.");
  }
  if (!Array.isArray(payload)) {
    throwKittyFailure("inspection-validation", "Kitty returned invalid structured state.");
  }

  const projected: KittyWindowState[] = [];
  try {
    for (const osWindowValue of payload) {
      const osWindow = requireRecord(osWindowValue);
      const osWindowId = requirePositiveInteger(osWindow.id);
      const tabs = requireArray(osWindow.tabs);
      for (const tabValue of tabs) {
        const tab = requireRecord(tabValue);
        const tabId = requirePositiveInteger(tab.id);
        const windows = requireArray(tab.windows);
        for (const windowValue of windows) {
          const window = requireRecord(windowValue);
          const rawUserVars = requireRecord(window.user_vars);
          const userVars: Record<string, string> = {};
          const marker = rawUserVars.arashi_worktree_id;
          if (typeof marker === "string") userVars.arashi_worktree_id = marker;
          projected.push({
            cwd: projectWindowCwd(window),
            id: requirePositiveInteger(window.id),
            isFocused: requireBoolean(window.is_focused),
            lastFocusedAt: requireNonNegativeNumber(window.last_focused_at),
            osWindowId,
            sessionName: requireString(window.session_name),
            tabId,
            title: requireString(window.title),
            userVars,
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof SwitchCommandError) throw error;
    throwKittyFailure(
      "inspection-validation",
      "Kitty returned structured state with missing or wrong-typed required fields.",
    );
  }
  return projected;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("record");
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("array");
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("string");
  return value;
}

function projectWindowCwd(window: Record<string, unknown>): string {
  if (window.foreground_processes !== undefined) {
    const foregroundProcesses = requireArray(window.foreground_processes);
    for (const processValue of foregroundProcesses) {
      const foregroundProcess = requireRecord(processValue);
      if (foregroundProcess.cwd === undefined) continue;
      const cwd = requireString(foregroundProcess.cwd);
      if (cwd.trim().length > 0) return cwd;
    }
  }
  return requireString(window.cwd);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("boolean");
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("id");
  return value;
}

function requireNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("number");
  return value;
}

export async function launchManagedKitty(
  candidate: SwitchCandidate,
  deps: LaunchManagedKittyDependencies,
): Promise<LaunchSwitchResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const metadata = await deriveKittyWorktreeMetadata(candidate);
  const kitten = await resolveKittenExecutable({
    env,
    pathExists: deps.pathExists,
    platform,
    runProcess: deps.runProcess,
  });
  await preflightVersion(kitten, metadata.canonicalPath, env, deps.runProcess);

  const lock = await acquireKittyIdentityLock(metadata.identity, {
    ...deps.lockOptions,
    lockRoot: deps.lockRoot,
  });
  let result: LaunchSwitchResult;
  try {
    result = await inspectFocusOrLaunch(kitten, metadata, env, deps.runProcess);
  } catch (error) {
    try {
      await lock.release();
    } catch {
      // Preserve the managed launcher failure that triggered cleanup.
    }
    throw error;
  }
  await lock.release();
  return result;
}

async function preflightVersion(
  kitten: string,
  cwd: string,
  env: Record<string, string | undefined>,
  runProcess: SwitchProcessRunner,
): Promise<void> {
  const command = [kitten, "--version"];
  const result = await runProcess(command, { cwd, env });
  if (result.exitCode !== 0) {
    throwProcessFailure("version-preflight", cwd, command, result);
  }
  const version = parseKittyVersion(result.stdout);
  if (!version) {
    throwKittyFailure("version-preflight", "Kitty version output could not be validated.", {
      command,
      path: cwd,
    });
  }
  if (compareVersions(version, KITTY_MINIMUM_VERSION) < 0) {
    throwKittyFailure(
      "version-preflight",
      `Managed Kitty sessions require Kitty ${KITTY_MINIMUM_VERSION} or newer; detected ${version}.`,
      { command, detectedVersion: version, minimumVersion: KITTY_MINIMUM_VERSION, path: cwd },
    );
  }
}

async function inspectFocusOrLaunch(
  kitten: string,
  metadata: KittyWorktreeMetadata,
  env: Record<string, string | undefined>,
  runProcess: SwitchProcessRunner,
): Promise<LaunchSwitchResult> {
  const initial = await inspectKitty(kitten, metadata.canonicalPath, env, runProcess);
  const match = selectIdentityMatch(initial, metadata);
  if (!match) return launchAndValidate(kitten, metadata, env, runProcess);

  const focusCommand = buildFocusCommand(kitten, match.id);
  const focusResult = await runProcess(focusCommand, processOptions(metadata.canonicalPath, env));
  if (focusResult.exitCode === 0) {
    const afterFocus = await inspectKitty(kitten, metadata.canonicalPath, env, runProcess);
    const validated = selectIdentityMatch(afterFocus, metadata);
    if (validated?.id === match.id && validated.isFocused) {
      return { command: focusCommand, mode: "kitty" };
    }
    if (validated === null) {
      return launchAndValidate(kitten, metadata, env, runProcess);
    }
    if (validated.id !== match.id) {
      return focusReplacementOnce(kitten, metadata, env, runProcess, afterFocus);
    }
    throwKittyFailure(
      "focus-validation",
      "Kitty reported a successful focus command but the same managed window remained unfocused.",
      { command: focusCommand, path: metadata.canonicalPath },
    );
  }

  const afterFailure = await inspectKitty(kitten, metadata.canonicalPath, env, runProcess);
  const afterFailureMatch = selectIdentityMatch(afterFailure, metadata);
  if (afterFailureMatch === null) {
    return launchAndValidate(kitten, metadata, env, runProcess);
  }
  if (afterFailureMatch.id === match.id) {
    throwProcessFailure("focus", metadata.canonicalPath, focusCommand, focusResult);
  }
  return focusReplacementOnce(kitten, metadata, env, runProcess, afterFailure);
}

async function focusReplacementOnce(
  kitten: string,
  metadata: KittyWorktreeMetadata,
  env: Record<string, string | undefined>,
  runProcess: SwitchProcessRunner,
  state: KittyWindowState[],
): Promise<LaunchSwitchResult> {
  const replacement = selectIdentityMatch(state, metadata);
  if (!replacement) return launchAndValidate(kitten, metadata, env, runProcess);
  const command = buildFocusCommand(kitten, replacement.id);
  const result = await runProcess(command, processOptions(metadata.canonicalPath, env));
  if (result.exitCode !== 0)
    throwProcessFailure("focus-reconciliation", metadata.canonicalPath, command, result);
  const finalState = await inspectKitty(kitten, metadata.canonicalPath, env, runProcess);
  const finalMatch = selectIdentityMatch(finalState, metadata);
  if (finalMatch?.id !== replacement.id || !finalMatch.isFocused) {
    throwKittyFailure(
      "focus-validation",
      "Kitty focus state continued changing after one reconciliation attempt.",
      {
        command,
        path: metadata.canonicalPath,
      },
    );
  }
  return { command, mode: "kitty" };
}

async function launchAndValidate(
  kitten: string,
  metadata: KittyWorktreeMetadata,
  env: Record<string, string | undefined>,
  runProcess: SwitchProcessRunner,
): Promise<LaunchSwitchResult> {
  const command = [
    kitten,
    "@",
    "launch",
    "--type=tab",
    "--cwd",
    metadata.canonicalPath,
    "--add-to-session",
    metadata.sessionName,
    "--var",
    `arashi_worktree_id=${metadata.identity}`,
    "--title",
    metadata.title,
  ];
  const result = await runProcess(command, processOptions(metadata.canonicalPath, env));
  if (result.exitCode !== 0) throwProcessFailure("launch", metadata.canonicalPath, command, result);
  const launchedId = parseLaunchId(result.stdout);
  if (launchedId === null) {
    throwKittyFailure(
      "launch-response-validation",
      "Kitty launch did not return exactly one numeric window ID.",
      {
        command,
        path: metadata.canonicalPath,
      },
    );
  }

  const focusCommand = buildFocusCommand(kitten, launchedId);
  const focusResult = await runProcess(focusCommand, processOptions(metadata.canonicalPath, env));
  if (focusResult.exitCode !== 0)
    throwProcessFailure("launch-focus", metadata.canonicalPath, focusCommand, focusResult);

  const finalState = await inspectKitty(kitten, metadata.canonicalPath, env, runProcess);
  const identityMatches = getIdentityMatches(finalState, metadata.identity);
  if (identityMatches.length > 1)
    throwDuplicateState(metadata.canonicalPath, identityMatches.length);
  const launched = identityMatches[0];
  if (
    !launched ||
    launched.id !== launchedId ||
    launched.sessionName !== metadata.sessionName ||
    !launched.isFocused
  ) {
    throwKittyFailure(
      "launch-state-validation",
      "Kitty returned window state inconsistent with the requested identity, session, or focus.",
      { command, path: metadata.canonicalPath, windowId: launchedId },
    );
  }
  return { command, mode: "kitty" };
}

function parseLaunchId(stdout: string): number | null {
  const value = stdout.trim();
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function inspectKitty(
  kitten: string,
  cwd: string,
  env: Record<string, string | undefined>,
  runProcess: SwitchProcessRunner,
): Promise<KittyWindowState[]> {
  const command = [kitten, "@", "ls"];
  const result = await runProcess(command, processOptions(cwd, env));
  if (result.exitCode !== 0) {
    throwProcessFailure(
      "remote-control-inspection",
      cwd,
      command,
      result,
      "Ensure Kitty remote control is enabled and permitted for this terminal.",
    );
  }
  return parseKittyState(result.stdout);
}

function selectIdentityMatch(
  state: KittyWindowState[],
  metadata: KittyWorktreeMetadata,
): KittyWindowState | null {
  const matches = getIdentityMatches(state, metadata.identity);
  if (matches.length > 1) throwDuplicateState(metadata.canonicalPath, matches.length);
  const match = matches[0];
  if (!match) return null;
  return match;
}

function getIdentityMatches(state: KittyWindowState[], identity: string): KittyWindowState[] {
  return state.filter((window) => window.userVars.arashi_worktree_id === identity);
}

function throwDuplicateState(path: string, matchCount: number): never {
  throwKittyFailure(
    "duplicate-state",
    `Kitty contains multiple (${matchCount}) windows with the exact Arashi worktree identity; close duplicates manually and retry.`,
    { matchCount, path },
  );
}

function buildFocusCommand(kitten: string, windowId: number): string[] {
  return [kitten, "@", "focus-window", "--match", `id:${windowId}`];
}

function processOptions(
  cwd: string,
  env: Record<string, string | undefined>,
): SwitchProcessRunOptions {
  return { cwd, env };
}

function throwProcessFailure(
  phase: string,
  path: string,
  command: string[],
  result: { exitCode: number; stderr: string },
  guidance?: string,
): never {
  const detail = result.stderr.trim() || "no stderr detail";
  throwKittyFailure(
    phase,
    `Managed Kitty ${phase} failed (exit ${result.exitCode}): ${detail}${guidance ? ` ${guidance}` : ""}`,
    { command, exitCode: result.exitCode, path, phase },
  );
}

function throwKittyFailure(
  phase: string,
  detail: string,
  context: Record<string, unknown> = {},
): never {
  throw new SwitchCommandError(detail, SwitchCommandErrorCode.LAUNCH_FAILED, { ...context, phase });
}

export async function acquireKittyIdentityLock(
  identity: string,
  options: KittyIdentityLockOptions = {},
): Promise<KittyIdentityLock> {
  const lockRoot =
    options.lockRoot ??
    join(tmpdir(), `arashi-kitty-locks-${process.getuid?.().toString() ?? "user"}`);
  const lockPath = join(lockRoot, `${identity}.lock`);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pidAlive = options.pidAlive ?? isPidAlive;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_POLL_MS;
  const readReleasedLockOwner =
    options.readReleasedLockOwner ?? (async (path) => await readFile(path, "utf8"));
  const removeReleasedLock =
    options.removeReleasedLock ??
    (async (path: string) => await rm(path, { force: true, recursive: true }));
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const startedAt = now();
  const owner: LockOwner = {
    createdAt: now(),
    identity,
    owner: randomUUID(),
    pid: process.pid,
  };
  try {
    await prepareLockRoot(lockRoot);
  } catch (error) {
    if (error instanceof SwitchCommandError) throw error;
    throwIdentityLockFilesystemFailure("create the lock root", lockRoot, error);
  }

  while (true) {
    if (!(await hasRecoveryMarker(lockPath))) {
      try {
        await mkdir(lockPath);
        await options.beforeLockOwnerWrite?.();
        await writeFile(join(lockPath, OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
        if (!(await hasRecoveryMarker(lockPath))) {
          return {
            path: lockPath,
            release: async () =>
              await releaseOwnedLock(
                lockPath,
                owner,
                readReleasedLockOwner,
                removeReleasedLock,
                options.beforeMissingLockRecoveryCheck,
              ),
          };
        }
        await releaseOwnedLock(
          lockPath,
          owner,
          readReleasedLockOwner,
          removeReleasedLock,
          options.beforeMissingLockRecoveryCheck,
        );
      } catch (error) {
        if (error instanceof SwitchCommandError) throw error;
        if (!isAlreadyExists(error) && !isMissing(error))
          throwIdentityLockFilesystemFailure("acquire the identity lock", lockPath, error);
      }
    }

    try {
      const recoveryMarkerPresent = await hasRecoveryMarker(lockPath);
      let guard: KittyIdentityLock | null = null;
      if (recoveryMarkerPresent) {
        guard = await acquireStaleRecoveryGuard(
          lockPath,
          identity,
          now(),
          pidAlive,
          options.beforeRecoveryGuardOwnerWrite,
        );
      } else {
        let lockExists = true;
        try {
          await stat(lockPath);
        } catch (error) {
          if (isMissing(error)) lockExists = false;
          else throw error;
        }
        if (lockExists) {
          const observedOwner = await readLockOwner(lockPath);
          const liveOwner = observedOwner?.identity === identity && pidAlive(observedOwner.pid);
          if (!liveOwner) {
            guard = await acquireStaleRecoveryGuard(
              lockPath,
              identity,
              now(),
              pidAlive,
              options.beforeRecoveryGuardOwnerWrite,
            );
          }
        }
      }
      if (guard) {
        try {
          await recoverStaleLockIfSafe(
            lockPath,
            identity,
            now(),
            pidAlive,
            options.beforeStaleLockRename,
          );
        } finally {
          await guard.release();
        }
      }
    } catch (error) {
      if (error instanceof SwitchCommandError) throw error;
      throwIdentityLockFilesystemFailure("recover the stale identity lock", lockPath, error);
    }
    if (now() - startedAt >= timeoutMs) {
      throwKittyFailure(
        "identity-lock",
        `Timed out after ${timeoutMs}ms waiting for the managed Kitty worktree identity lock.`,
        { path: lockPath, timeoutMs },
      );
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (now() - startedAt))));
  }
}

async function prepareLockRoot(lockRoot: string): Promise<void> {
  await mkdir(lockRoot, { mode: 0o700, recursive: true });
  const rootStat = await lstat(lockRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throwKittyFailure("identity-lock", "Managed Kitty lock root must be a real directory.", {
      path: lockRoot,
    });
  }

  const uid = process.getuid?.();
  if (uid === undefined) return;
  if (rootStat.uid !== uid) {
    throwKittyFailure(
      "identity-lock",
      "Managed Kitty lock root is not owned by the current user.",
      { path: lockRoot },
    );
  }
  await chmod(lockRoot, 0o700);
  const secured = await lstat(lockRoot);
  if (secured.uid !== uid || (secured.mode & 0o777) !== 0o700) {
    throwKittyFailure(
      "identity-lock",
      "Managed Kitty lock root could not be secured for the current user.",
      { path: lockRoot },
    );
  }
}

function throwIdentityLockFilesystemFailure(
  operation: string,
  path: string,
  error: unknown,
): never {
  const code = (error as NodeJS.ErrnoException).code;
  throwKittyFailure(
    "identity-lock",
    `Managed Kitty could not ${operation}${code ? ` (${code})` : ""}.`,
    { path },
  );
}

function recoveryMarkerPrefix(lockPath: string): string {
  return `${basename(lockPath)}.recovery`;
}

async function listRecoveryMarkers(lockPath: string): Promise<string[]> {
  try {
    const parent = dirname(lockPath);
    const prefix = recoveryMarkerPrefix(lockPath);
    return (await readdir(parent))
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => join(parent, entry));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function hasRecoveryMarker(lockPath: string): Promise<boolean> {
  return (await listRecoveryMarkers(lockPath)).length > 0;
}

async function acquireStaleRecoveryGuard(
  lockPath: string,
  identity: string,
  now: number,
  pidAlive: (pid: number) => boolean,
  beforeOwnerWrite?: () => Promise<void>,
): Promise<KittyIdentityLock | null> {
  const guardPath = `${lockPath}.recovery`;
  const guardIdentity = `${identity}:recovery`;
  const owner: LockOwner = {
    createdAt: now,
    identity: guardIdentity,
    owner: randomUUID(),
    pid: process.pid,
  };
  const markers = await listRecoveryMarkers(lockPath);
  if (markers.length === 0) {
    try {
      await mkdir(guardPath);
      await beforeOwnerWrite?.();
      await writeFile(join(guardPath, OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
      const claimedMarkers = await listRecoveryMarkers(lockPath);
      if (claimedMarkers.length !== 1 || claimedMarkers[0] !== guardPath) {
        await releaseOwnedLock(guardPath, owner);
        return null;
      }
      return { path: guardPath, release: async () => await releaseOwnedLock(guardPath, owner) };
    } catch (error) {
      if (isAlreadyExists(error) || isMissing(error)) return null;
      throw error;
    }
  }
  if (markers.length !== 1) return null;

  const markerPath = markers[0];
  const takeoverPid = recoveryTakeoverPid(markerPath, guardPath);
  if (takeoverPid !== null && pidAlive(takeoverPid)) return null;
  const inspectedOwner = await readLockOwner(markerPath);
  const recover =
    inspectedOwner?.identity === guardIdentity
      ? !pidAlive(inspectedOwner.pid)
      : await malformedLockIsStale(markerPath, now);
  if (!recover) return null;

  const takeoverPath = `${guardPath}.takeover-${process.pid}-${randomUUID()}`;
  try {
    await rename(markerPath, takeoverPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const movedOwner = await readLockOwner(takeoverPath);
  if (!sameLockOwner(inspectedOwner, movedOwner)) {
    await rename(takeoverPath, markerPath);
    return null;
  }
  await writeFile(join(takeoverPath, OWNER_FILE), JSON.stringify(owner));
  await rename(takeoverPath, guardPath);
  return { path: guardPath, release: async () => await releaseOwnedLock(guardPath, owner) };
}

function recoveryTakeoverPid(markerPath: string, guardPath: string): number | null {
  const prefix = `${guardPath}.takeover-`;
  if (!markerPath.startsWith(prefix)) return null;
  const match = markerPath.slice(prefix.length).match(/^(\d+)-/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function recoverStaleLockIfSafe(
  lockPath: string,
  identity: string,
  now: number,
  pidAlive: (pid: number) => boolean,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  let recover = false;
  let inspectedOwner: LockOwner | null = null;
  try {
    const raw = await readFile(join(lockPath, OWNER_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      parsed.identity === identity &&
      typeof parsed.owner === "string" &&
      parsed.owner.length > 0 &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "number"
    ) {
      inspectedOwner = parsed as LockOwner;
      recover = !pidAlive(parsed.pid);
    } else {
      recover = await malformedLockIsStale(lockPath, now);
    }
  } catch {
    recover = await malformedLockIsStale(lockPath, now);
  }
  if (!recover) return;

  const currentOwner = await readLockOwner(lockPath);
  if (!sameLockOwner(inspectedOwner, currentOwner)) return;
  await beforeRename?.();

  const recoveryPath = `${lockPath}.recover-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, recoveryPath);
    const movedOwner = await readLockOwner(recoveryPath);
    if (!sameLockOwner(inspectedOwner, movedOwner)) {
      try {
        await rename(recoveryPath, lockPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        throwKittyFailure(
          "identity-lock",
          "Managed Kitty lock ownership changed during stale recovery; no unverified lock was removed.",
          { path: lockPath, recoveryPath },
        );
      }
      return;
    }
    await rm(recoveryPath, { force: true, recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(lockPath, OWNER_FILE), "utf8"),
    ) as Partial<LockOwner>;
    if (
      typeof parsed.createdAt !== "number" ||
      typeof parsed.identity !== "string" ||
      typeof parsed.owner !== "string" ||
      parsed.owner.length === 0 ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0
    )
      return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

function sameLockOwner(left: LockOwner | null, right: LockOwner | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.createdAt === right.createdAt &&
    left.identity === right.identity &&
    left.owner === right.owner &&
    left.pid === right.pid
  );
}

async function malformedLockIsStale(lockPath: string, now: number): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return now - lockStat.mtimeMs >= MALFORMED_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function readReleasedOwnerForRelease(
  releasePath: string,
  lockPath: string,
  deadline: number,
  readReleasedLockOwner: (path: string) => Promise<string>,
): Promise<LockOwner | null> {
  while (true) {
    let raw: string;
    try {
      raw = await readReleasedLockOwner(join(releasePath, OWNER_FILE));
    } catch (error) {
      if (isMissing(error)) return null;
      if (isTransientWindowsFilesystemContention(error) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      throwIdentityLockFilesystemFailure(
        "read the moved identity lock during release",
        lockPath,
        error,
      );
    }
    try {
      return JSON.parse(raw) as LockOwner;
    } catch {
      return null;
    }
  }
}

async function releaseOwnedLock(
  lockPath: string,
  owner: LockOwner,
  readReleasedLockOwner: (path: string) => Promise<string> = async (path) =>
    await readFile(path, "utf8"),
  removeReleasedLock: (path: string) => Promise<void> = async (path) =>
    await rm(path, { force: true, recursive: true }),
  beforeMissingLockRecoveryCheck?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    let current: LockOwner | null;
    try {
      current = JSON.parse(await readFile(join(lockPath, OWNER_FILE), "utf8")) as LockOwner;
    } catch (error) {
      if (isMissing(error)) {
        if (await shouldRetryMissingOwnedLock(lockPath, deadline, beforeMissingLockRecoveryCheck)) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        return;
      }
      if (isTransientWindowsFilesystemContention(error) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      throwIdentityLockFilesystemFailure("read the identity lock during release", lockPath, error);
    }
    if (!sameLockOwner(current, owner)) return;

    const releasePath = `${lockPath}.release-${owner.owner}`;
    try {
      await rename(lockPath, releasePath);
    } catch (error) {
      if (isMissing(error)) {
        if (await shouldRetryMissingOwnedLock(lockPath, deadline, beforeMissingLockRecoveryCheck)) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        return;
      }
      if (isTransientWindowsFilesystemContention(error) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      throwIdentityLockFilesystemFailure(
        "rename the identity lock during release",
        lockPath,
        error,
      );
    }

    const movedOwner = await readReleasedOwnerForRelease(
      releasePath,
      lockPath,
      deadline,
      readReleasedLockOwner,
    );
    if (!sameLockOwner(movedOwner, owner)) {
      try {
        await rename(releasePath, lockPath);
      } catch (error) {
        if (!isAlreadyExists(error))
          throwIdentityLockFilesystemFailure(
            "restore a changed identity lock during release",
            lockPath,
            error,
          );
      }
      return;
    }
    while (true) {
      try {
        await removeReleasedLock(releasePath);
        break;
      } catch (error) {
        if (isTransientWindowsFilesystemContention(error) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        throwIdentityLockFilesystemFailure(
          "remove the identity lock during release",
          lockPath,
          error,
        );
      }
    }
    return;
  }
}

async function shouldRetryMissingOwnedLock(
  lockPath: string,
  deadline: number,
  beforeCheck?: () => Promise<void>,
): Promise<boolean> {
  await beforeCheck?.();
  if (await hasRecoveryMarker(lockPath)) {
    if (Date.now() >= deadline) {
      throwKittyFailure(
        "identity-lock",
        "Timed out waiting for managed Kitty stale recovery to finish during lock release.",
        { path: lockPath },
      );
    }
    return true;
  }
  try {
    await stat(lockPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isTransientWindowsFilesystemContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
