import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  open,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { exec } from "./git.ts";
import { runtime } from "./runtime.ts";

export const T3_PERMISSION_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const;
export type T3PermissionMode = (typeof T3_PERMISSION_MODES)[number];
export type T3HandoffStatus = "planned" | "dispatching" | "succeeded" | "failed" | "indeterminate";

export interface T3HandoffRequest {
  permission: T3PermissionMode;
  prompt: string;
  promptDigest: string;
  source: "inline" | "file";
}

export interface T3ProcessResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface T3HandoffResult {
  status: T3HandoffStatus;
  bridgeVersion: string;
  workspacePath: string;
  permission: T3PermissionMode;
  promptDigest: string;
  environment: { id: string | null; serverVersion: string | null };
  project: { id: string | null; title: string | null; created: boolean | null };
  thread: { id: string | null; title: string | null };
  dispatch: { status: "planned" | "dispatching" | "succeeded" | "failed" | "indeterminate" };
  ui: {
    mode: "none";
    kind: string | null;
    exactThread: boolean | null;
    status: "skipped" | "succeeded";
  };
  receiptPath: string | null;
  retry: { safe: boolean; guidance: string };
  error?: { code: string; message: string };
}

interface T3HandoffReceipt extends T3HandoffResult {
  version: 1;
  branch: string;
  createdAt: string;
  updatedAt: string;
}

export interface T3HandoffDependencies {
  now?: () => Date;
  platform?: NodeJS.Platform;
  runProcess?: (
    command: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<T3ProcessResult>;
  resolveGitCommonDirectory?: (workspacePath: string) => Promise<string>;
  setWindowsOwnerOnly?: (path: string) => Promise<void>;
  removePromptDirectory?: (path: string) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
}

export class T3HandoffError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly result?: T3HandoffResult;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    result?: T3HandoffResult,
  ) {
    super(message);
    this.name = "T3HandoffError";
    this.code = code;
    this.details = details;
    this.result = result;
  }
}

const runT3Process = async (
  command: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<T3ProcessResult> => {
  try {
    const proc = runtime.spawn([...command], {
      cwd: options.cwd,
      env: options.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr, stdout };
  } catch (error) {
    return {
      exitCode: -1,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
};

const readUtf8Strict = async (path: string): Promise<string> => {
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new T3HandoffError(
      "T3_PROMPT_INVALID_UTF8",
      `T3 prompt file is not valid UTF-8: ${path}`,
    );
  }
};

export const resolveT3HandoffRequest = async (options: {
  t3?: boolean | string;
  promptFile?: string;
  permission?: T3PermissionMode;
}): Promise<T3HandoffRequest | null> => {
  if (
    options.permission !== undefined &&
    !T3_PERMISSION_MODES.includes(options.permission as T3PermissionMode)
  ) {
    throw new T3HandoffError(
      "T3_PERMISSION_INVALID",
      `Invalid T3 permission mode: ${String(options.permission)}.`,
      { choices: [...T3_PERMISSION_MODES] },
    );
  }
  const enabled = options.t3 !== undefined && options.t3 !== false;
  if (!enabled) {
    if (options.promptFile !== undefined) {
      throw new T3HandoffError(
        "T3_PROMPT_FILE_REQUIRES_T3",
        "--prompt-file requires --t3. Use --t3 --prompt-file <path>.",
      );
    }
    if (options.permission !== undefined) {
      throw new T3HandoffError(
        "T3_PERMISSION_REQUIRES_T3",
        "--permission is available only with --t3.",
      );
    }
    return null;
  }

  const inline = typeof options.t3 === "string" ? options.t3 : undefined;
  if (inline !== undefined && options.promptFile !== undefined) {
    throw new T3HandoffError(
      "T3_PROMPT_SOURCE_CONFLICT",
      "Use exactly one T3 prompt source: an inline --t3 value or --prompt-file.",
    );
  }
  if (inline === undefined && options.promptFile === undefined) {
    throw new T3HandoffError(
      "T3_PROMPT_SOURCE_REQUIRED",
      "--t3 requires a nonempty inline task or --prompt-file <path>.",
    );
  }

  let prompt: string;
  let source: T3HandoffRequest["source"];
  if (inline !== undefined) {
    prompt = inline;
    source = "inline";
  } else {
    const promptPath = resolve(options.promptFile!);
    try {
      prompt = await readUtf8Strict(promptPath);
    } catch (error) {
      if (error instanceof T3HandoffError) throw error;
      throw new T3HandoffError(
        "T3_PROMPT_FILE_UNREADABLE",
        `Unable to read T3 prompt file: ${promptPath}`,
        { path: promptPath },
      );
    }
    source = "file";
  }
  if (prompt.trim().length === 0) {
    throw new T3HandoffError(
      "T3_PROMPT_EMPTY",
      "T3 prompt content must not be empty or whitespace-only.",
    );
  }

  return {
    permission: options.permission ?? "full-access",
    prompt,
    promptDigest: createHash("sha256").update(prompt, "utf8").digest("hex"),
    source,
  };
};

export const preflightT3Bridge = async (
  cwd: string,
  dependencies: T3HandoffDependencies = {},
): Promise<string> => {
  const result = await (dependencies.runProcess ?? runT3Process)(["t3code", "--version"], {
    cwd,
    env: process.env,
  });
  if (result.exitCode === -1) {
    throw new T3HandoffError(
      "T3_BRIDGE_NOT_FOUND",
      "T3 handoff requires an installed compatible bridge. Install the evaluated version with `npm install --global @bvdm/t3code-cli@0.1.2`.",
    );
  }
  if (result.exitCode !== 0) {
    throw new T3HandoffError(
      "T3_BRIDGE_VERSION_FAILED",
      "Unable to determine the installed t3code bridge version.",
    );
  }
  const match = result.stdout.trim().match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) {
    throw new T3HandoffError(
      "T3_BRIDGE_VERSION_INVALID",
      "The installed t3code bridge returned an unrecognized version.",
    );
  }
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (match[1] !== "0" || match[2] !== "1") {
    throw new T3HandoffError(
      "T3_BRIDGE_VERSION_UNSUPPORTED",
      `Unsupported t3code bridge version ${version}; install @bvdm/t3code-cli@0.1.2 (reported 0.1.x contract).`,
      { version },
    );
  }
  return version;
};

const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null);
const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const pathsEqual = (left: string, right: string): boolean => {
  const canonical = (value: string): string => normalize(resolve(value)).replace(/[\\/]+$/u, "");
  const normalizedLeft = canonical(left);
  const normalizedRight = canonical(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const parseBridgeSuccess = (
  stdout: string,
  base: Omit<
    T3HandoffResult,
    "environment" | "project" | "thread" | "dispatch" | "ui" | "retry" | "status"
  >,
): T3HandoffResult => {
  let envelope: Record<string, unknown>;
  try {
    envelope = objectValue(JSON.parse(stdout));
  } catch {
    throw new T3HandoffError(
      "T3_BRIDGE_RESPONSE_INVALID",
      "t3code returned malformed JSON after dispatch.",
    );
  }
  if (envelope.ok !== true) {
    throw new T3HandoffError(
      "T3_BRIDGE_RESPONSE_INVALID",
      "t3code did not return a success envelope after dispatch.",
    );
  }
  const data = objectValue(envelope.data);
  const runtimeData = objectValue(data.runtime);
  const workspaceData = objectValue(data.workspace);
  const projectData = objectValue(data.project);
  const threadData = objectValue(data.thread);
  const openedData = objectValue(data.opened);
  const threadId = stringValue(threadData.id);
  const projectId = stringValue(projectData.id);
  const returnedWorkspace = stringValue(workspaceData.workspaceRoot);
  const projectWorkspace = stringValue(projectData.workspaceRoot);
  if (
    !threadId ||
    !projectId ||
    stringValue(runtimeData.environmentId) === null ||
    returnedWorkspace === null ||
    !pathsEqual(returnedWorkspace, base.workspacePath) ||
    projectWorkspace === null ||
    !pathsEqual(projectWorkspace, base.workspacePath)
  ) {
    throw new T3HandoffError(
      "T3_BRIDGE_RESPONSE_INVALID",
      "t3code success output omitted required identifiers.",
    );
  }
  return {
    ...base,
    status: "succeeded",
    environment: {
      id: stringValue(runtimeData.environmentId),
      serverVersion: stringValue(runtimeData.serverVersion),
    },
    project: {
      created: typeof data.projectCreated === "boolean" ? data.projectCreated : null,
      id: projectId,
      title: null,
    },
    thread: { id: threadId, title: null },
    dispatch: { status: "succeeded" },
    ui: {
      exactThread: typeof openedData.exactThread === "boolean" ? openedData.exactThread : null,
      kind: stringValue(openedData.kind),
      mode: "none",
      status: "skipped",
    },
    retry: {
      safe: false,
      guidance:
        "The task is already running. Select the reported project/thread in a connected T3 client.",
    },
  };
};

const safeFailureCodes = new Set([
  "CONFIG_READ_FAILED",
  "INVALID_CONFIG",
  "INVALID_THREAD_OPTION",
  "PROCESS_START_FAILED",
  "PROJECT_NOT_FOUND",
  "PROMPT_REQUIRED",
  "PROMPT_SOURCE_REQUIRED",
  "T3_AUTH_FAILED",
  "WORKSPACE_NOT_DIRECTORY",
  "WORKSPACE_NOT_FOUND",
]);

const parseBridgeError = (stderr: string): { code: string; message: string; safe: boolean } => {
  try {
    const envelope = objectValue(JSON.parse(stderr));
    const bridgeError = objectValue(envelope.error);
    const code = stringValue(bridgeError.code) ?? "T3_BRIDGE_FAILED";
    return {
      code,
      message: stringValue(bridgeError.message) ?? "t3code handoff failed.",
      safe: safeFailureCodes.has(code),
    };
  } catch {
    return {
      code: "T3_BRIDGE_FAILED",
      message: "t3code handoff failed without a valid error envelope.",
      safe: false,
    };
  }
};

const resolveCommonDirectory = async (workspacePath: string): Promise<string> => {
  const raw = (await exec(["rev-parse", "--git-common-dir"], workspacePath)).stdout.trim();
  const absolute = isAbsolute(raw) ? raw : resolve(workspacePath, raw);
  return realpath(absolute);
};

export const t3ReceiptPath = async (
  workspacePath: string,
  dependencies: T3HandoffDependencies = {},
): Promise<string> => {
  const canonical = await realpath(workspacePath);
  const common = await (dependencies.resolveGitCommonDirectory ?? resolveCommonDirectory)(
    canonical,
  );
  return join(
    common,
    ".arashi-t3-handoffs",
    `${createHash("sha256").update(canonical, "utf8").digest("hex")}.json`,
  );
};

const windowsAclSet = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:ARASHI_T3_RECEIPT_PATH
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$isDirectory = [System.IO.Directory]::Exists($target)
$item = if ($isDirectory) { [System.IO.DirectoryInfo]::new($target) } else { [System.IO.FileInfo]::new($target) }
$acl = $item.GetAccessControl()
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) { $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
`;
const execFileAsync = promisify(execFile);
const setWindowsOwnerOnly = async (path: string): Promise<void> => {
  await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsAclSet, "utf16le").toString("base64"),
    ],
    { env: { ...process.env, ARASHI_T3_RECEIPT_PATH: path } },
  );
};

const secureReceiptDirectory = async (
  directory: string,
  dependencies: T3HandoffDependencies,
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new T3HandoffError(
      "T3_RECEIPT_UNSAFE",
      `T3 receipt directory is not a plain directory: ${directory}`,
    );
  }
  if ((dependencies.platform ?? process.platform) === "win32") {
    await (dependencies.setWindowsOwnerOnly ?? setWindowsOwnerOnly)(directory);
  } else {
    await chmod(directory, 0o700);
    await (dependencies.syncDirectory ?? syncDirectory)(dirname(directory));
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const acquireReceiptLock = async (
  receiptPath: string,
  dependencies: T3HandoffDependencies,
): Promise<() => Promise<void>> => {
  const directory = dirname(receiptPath);
  await secureReceiptDirectory(directory, dependencies);
  const lockPath = `${receiptPath}.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await readReceipt(receiptPath).catch(() => null);
      const lockedResult = existing
        ? {
            ...existing,
            status: "dispatching" as const,
            dispatch: { status: "dispatching" as const },
            retry: {
              safe: false,
              guidance: "Reconcile the exact workspace in T3 before removing a stale lock.",
            },
          }
        : undefined;
      throw new T3HandoffError(
        "T3_HANDOFF_LOCKED",
        "Another T3 handoff owns this exact workspace; reconcile its receipt before retrying.",
        { lockPath, receiptPath },
        lockedResult,
      );
    }
    throw error;
  }
  try {
    if ((dependencies.platform ?? process.platform) === "win32") {
      await handle.close();
      handle = undefined;
      await (dependencies.setWindowsOwnerOnly ?? setWindowsOwnerOnly)(lockPath);
    } else {
      await handle.chmod(0o600);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle?.close();
  return async () => {
    await rm(lockPath, { force: true });
  };
};

const persistReceipt = async (
  path: string,
  receipt: T3HandoffReceipt,
  dependencies: T3HandoffDependencies,
): Promise<void> => {
  const directory = dirname(path);
  await secureReceiptDirectory(directory, dependencies);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if ((dependencies.platform ?? process.platform) !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if ((dependencies.platform ?? process.platform) === "win32") {
      await (dependencies.setWindowsOwnerOnly ?? setWindowsOwnerOnly)(temporary);
    }
    await rename(temporary, path);
    if ((dependencies.platform ?? process.platform) !== "win32") {
      await (dependencies.syncDirectory ?? syncDirectory)(directory);
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const isT3HandoffReceipt = (value: unknown): value is T3HandoffReceipt => {
  const receipt = objectValue(value);
  const environment = objectValue(receipt.environment);
  const project = objectValue(receipt.project);
  const thread = objectValue(receipt.thread);
  const dispatch = objectValue(receipt.dispatch);
  const ui = objectValue(receipt.ui);
  const retry = objectValue(receipt.retry);
  const error = receipt.error === undefined ? null : objectValue(receipt.error);
  return (
    receipt.version === 1 &&
    typeof receipt.branch === "string" &&
    typeof receipt.bridgeVersion === "string" &&
    typeof receipt.createdAt === "string" &&
    typeof receipt.updatedAt === "string" &&
    typeof receipt.workspacePath === "string" &&
    typeof receipt.receiptPath === "string" &&
    typeof receipt.promptDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.promptDigest) &&
    T3_PERMISSION_MODES.includes(receipt.permission as T3PermissionMode) &&
    ["dispatching", "succeeded", "failed", "indeterminate"].includes(receipt.status as string) &&
    nullableString(environment.id) &&
    nullableString(environment.serverVersion) &&
    nullableString(project.id) &&
    project.title === null &&
    (project.created === null || typeof project.created === "boolean") &&
    nullableString(thread.id) &&
    thread.title === null &&
    ["dispatching", "succeeded", "failed", "indeterminate"].includes(dispatch.status as string) &&
    ui.mode === "none" &&
    ["skipped", "succeeded"].includes(ui.status as string) &&
    nullableString(ui.kind) &&
    (ui.exactThread === null || typeof ui.exactThread === "boolean") &&
    typeof retry.safe === "boolean" &&
    typeof retry.guidance === "string" &&
    (error === null || (typeof error.code === "string" && typeof error.message === "string"))
  );
};

const readReceipt = async (path: string): Promise<T3HandoffReceipt | null> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new T3HandoffError(
        "T3_RECEIPT_UNSAFE",
        `T3 handoff receipt is not a plain file: ${path}`,
      );
    }
    const receipt = JSON.parse(await readFile(path, "utf8"));
    if (!isT3HandoffReceipt(receipt) || receipt.receiptPath !== path) {
      throw new T3HandoffError(
        "T3_RECEIPT_INVALID",
        `T3 handoff receipt has an invalid or mismatched schema: ${path}`,
      );
    }
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof T3HandoffError) throw error;
    throw new T3HandoffError(
      "T3_RECEIPT_INVALID",
      `Unable to read the existing T3 handoff receipt: ${path}`,
    );
  }
};

const emptyResult = (input: {
  bridgeVersion: string;
  permission: T3PermissionMode;
  promptDigest: string;
  receiptPath: string | null;
  status: T3HandoffStatus;
  workspacePath: string;
}): T3HandoffResult => ({
  ...input,
  environment: { id: null, serverVersion: null },
  project: { created: null, id: null, title: null },
  thread: { id: null, title: null },
  dispatch: {
    status:
      input.status === "planned"
        ? "planned"
        : input.status === "dispatching"
          ? "dispatching"
          : input.status === "failed"
            ? "failed"
            : "indeterminate",
  },
  ui: { exactThread: null, kind: null, mode: "none", status: "skipped" },
  retry: { safe: input.status === "failed", guidance: "" },
});

export const dispatchT3Handoff = async (input: {
  branch: string;
  bridgeVersion: string;
  dryRun: boolean;
  request: T3HandoffRequest;
  workspacePath: string;
  dependencies?: T3HandoffDependencies;
}): Promise<T3HandoffResult> => {
  const dependencies = input.dependencies ?? {};
  const workspacePath = input.dryRun
    ? await realpath(input.workspacePath).catch(() => resolve(input.workspacePath))
    : await realpath(input.workspacePath);
  if (input.dryRun) {
    return {
      ...emptyResult({
        bridgeVersion: input.bridgeVersion,
        permission: input.request.permission,
        promptDigest: input.request.promptDigest,
        receiptPath: null,
        status: "planned",
        workspacePath,
      }),
      dispatch: { status: "planned" },
      retry: { safe: false, guidance: "Dry-run only; no T3 state or receipt was created." },
    };
  }

  const receiptPath = await t3ReceiptPath(workspacePath, dependencies);
  const releaseReceiptLock = await acquireReceiptLock(receiptPath, dependencies);
  try {
    const existing = await readReceipt(receiptPath);
    if (existing) {
      if (existing.workspacePath !== workspacePath) {
        throw new T3HandoffError(
          "T3_RECEIPT_INVALID",
          "The T3 handoff receipt does not match the canonical workspace path.",
          { receiptPath },
        );
      }
      const matchingIntent =
        existing.promptDigest === input.request.promptDigest &&
        existing.permission === input.request.permission;
      if (existing.status !== "failed" || !matchingIntent) {
        const code = matchingIntent ? "T3_DUPLICATE_HANDOFF_BLOCKED" : "T3_HANDOFF_INTENT_CHANGED";
        const blockedResult = matchingIntent
          ? existing
          : {
              ...existing,
              retry: {
                safe: false,
                guidance:
                  "The receipt belongs to a different task or permission. Reconcile T3 and remove only the reported receipt before starting the changed intent.",
              },
            };
        throw new T3HandoffError(
          code,
          matchingIntent
            ? `T3 handoff is ${existing.status}; reconcile the reported project/thread before another dispatch.`
            : "The existing receipt records a different prompt or permission; reconcile it before starting a new handoff.",
          { receiptPath, status: existing.status },
          blockedResult,
        );
      }
    }

    const now = (dependencies.now ?? (() => new Date()))().toISOString();
    const dispatching: T3HandoffReceipt = {
      ...emptyResult({
        bridgeVersion: input.bridgeVersion,
        permission: input.request.permission,
        promptDigest: input.request.promptDigest,
        receiptPath,
        status: "dispatching",
        workspacePath,
      }),
      branch: input.branch,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: 1,
      retry: { safe: false, guidance: "Dispatch is in progress; do not start another thread." },
    };
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "arashi-t3-prompt-"));
    let promptCleanupFailed = false;
    let processResult: T3ProcessResult;
    try {
      const platform = dependencies.platform ?? process.platform;
      if (platform === "win32") {
        await (dependencies.setWindowsOwnerOnly ?? setWindowsOwnerOnly)(temporaryDirectory);
      } else {
        await chmod(temporaryDirectory, 0o700);
      }
      const promptPath = join(temporaryDirectory, "task.md");
      const promptHandle = await open(promptPath, "wx", 0o600);
      try {
        await promptHandle.writeFile(input.request.prompt, "utf8");
        if (platform !== "win32") await promptHandle.chmod(0o600);
      } finally {
        await promptHandle.close();
      }
      if (platform === "win32") {
        await (dependencies.setWindowsOwnerOnly ?? setWindowsOwnerOnly)(promptPath);
      }

      await persistReceipt(receiptPath, dispatching, dependencies);
      processResult = await (dependencies.runProcess ?? runT3Process)(
        [
          "t3code",
          "--json",
          "handover",
          "--cwd",
          workspacePath,
          "--workspace-mode",
          "folder",
          "--project-policy",
          "create",
          "--checkout",
          "current",
          "--open",
          "none",
          "--permission",
          input.request.permission,
          "--prompt-file",
          promptPath,
        ],
        { cwd: workspacePath, env: process.env },
      );
    } finally {
      try {
        await (
          dependencies.removePromptDirectory ??
          ((path: string) => rm(path, { force: true, recursive: true }))
        )(temporaryDirectory);
      } catch {
        promptCleanupFailed = true;
      }
    }

    const base = {
      bridgeVersion: input.bridgeVersion,
      permission: input.request.permission,
      promptDigest: input.request.promptDigest,
      receiptPath,
      workspacePath,
    };
    const cleanupDetails = promptCleanupFailed
      ? { promptCleanupFailed: true, promptDirectory: temporaryDirectory }
      : {};
    const saveOutcome = async (result: T3HandoffResult): Promise<void> => {
      try {
        await persistReceipt(
          receiptPath,
          {
            ...result,
            branch: input.branch,
            createdAt: dispatching.createdAt,
            updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            version: 1,
          },
          dependencies,
        );
      } catch {
        throw new T3HandoffError(
          result.error?.code ?? "T3_RECEIPT_WRITE_FAILED",
          `${result.error?.message ?? "T3 dispatch succeeded."} The receipt could not be updated; reconcile the reported outcome before retrying.`,
          { receiptPath, receiptWriteFailed: true, ...cleanupDetails },
          {
            ...result,
            retry: {
              safe: false,
              guidance:
                "The receipt still records dispatching. Reconcile the reported outcome and repair receipt storage before retrying.",
            },
          },
        );
      }
    };
    if (processResult.exitCode === 0) {
      let success: T3HandoffResult;
      try {
        success = parseBridgeSuccess(processResult.stdout, base);
      } catch {
        const result = {
          ...emptyResult({ ...base, status: "indeterminate" }),
          error: {
            code: "T3_BRIDGE_RESPONSE_INVALID",
            message: "Bridge output could not prove the created thread.",
          },
          retry: {
            safe: false,
            guidance:
              "Inspect T3 for a thread rooted at this workspace. If none exists, remove only the reported receipt (and its .lock peer if present) before retrying.",
          },
        } satisfies T3HandoffResult;
        await saveOutcome(result);
        throw new T3HandoffError(
          result.error.code,
          result.error.message,
          { receiptPath, ...cleanupDetails },
          result,
        );
      }
      await saveOutcome(success);
      if (promptCleanupFailed) {
        throw new T3HandoffError(
          "T3_PROMPT_CLEANUP_FAILED",
          `T3 dispatch succeeded, but the private prompt directory could not be removed: ${temporaryDirectory}`,
          { receiptPath, ...cleanupDetails },
          success,
        );
      }
      return success;
    }

    const bridgeError =
      processResult.exitCode === -1
        ? { code: "T3_BRIDGE_START_FAILED", message: "Unable to start t3code handoff.", safe: true }
        : parseBridgeError(processResult.stderr);
    const status: T3HandoffStatus = bridgeError.safe ? "failed" : "indeterminate";
    const result: T3HandoffResult = {
      ...emptyResult({ ...base, status }),
      error: { code: bridgeError.code, message: bridgeError.message },
      retry: {
        safe: bridgeError.safe,
        guidance: bridgeError.safe
          ? "Fix the reported problem, then rerun create with --conflict REUSE_EXISTING and the same T3 prompt."
          : "Inspect T3 for a thread rooted at this workspace. If none exists, remove only the reported receipt (and its .lock peer if present) before retrying.",
      },
    };
    await saveOutcome(result);
    throw new T3HandoffError(
      bridgeError.code,
      bridgeError.message,
      { receiptPath, status, ...cleanupDetails },
      result,
    );
  } finally {
    await releaseReceiptLock().catch(() => undefined);
  }
};
