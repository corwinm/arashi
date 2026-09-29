import { T3HandoffError } from "./t3-error.ts";
export { T3HandoffError } from "./t3-error.ts";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, open, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { exec } from "./git.ts";
import {
  identifier,
  record,
  records,
  resolveT3Selection,
  readT3Config,
  t3Http,
  verifyT3Protocol,
  verifyT3Version,
  withT3Session,
  type T3NativeDependencies,
  type T3NativeEnvironment,
  type T3Selection,
} from "./t3-native.ts";
export { preflightT3Native } from "./t3-native.ts";

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
  bridgeVersion?: string; // Present only in bridge-era receipts.
  adapterVersion?: "1";
  adapter?: "native";
  selection?: T3Selection;
  native?: {
    environmentId: string;
    projectId: string;
    threadId: string;
    messageId: string;
    phase: "preparing" | "submitting" | "accepted";
  };
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
  version: 1 | 2;
  branch: string;
  createdAt: string;
  updatedAt: string;
}

export interface T3HandoffDependencies extends T3NativeDependencies {
  now?: () => Date;
  platform?: NodeJS.Platform;
  runProcess?: (
    command: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<T3ProcessResult>;
  resolveGitCommonDirectory?: (workspacePath: string) => Promise<string>;
  setWindowsOwnerOnly?: (path: string) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
  removeReceiptLock?: (path: string) => Promise<void>;
}

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

const objectValue = record;
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";

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
    await (dependencies.removeReceiptLock ?? ((path: string) => rm(path, { force: true })))(
      lockPath,
    );
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
    (receipt.version === 1 || receipt.version === 2) &&
    (receipt.version !== 2 ||
      (receipt.adapter === "native" &&
        identifier(objectValue(receipt.native).environmentId) !== null &&
        identifier(objectValue(receipt.native).projectId) !== null &&
        identifier(objectValue(receipt.native).threadId) !== null &&
        identifier(objectValue(receipt.native).messageId) !== null &&
        ["preparing", "submitting", "accepted"].includes(
          objectValue(receipt.native).phase as string,
        ))) &&
    (receipt.selection === undefined ||
      (identifier(objectValue(receipt.selection).instanceId) !== null &&
        typeof objectValue(receipt.selection).model === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.:/+-]{0,199}$/u.test(
          objectValue(receipt.selection).model as string,
        ) &&
        Array.isArray(objectValue(receipt.selection).options) &&
        records(objectValue(receipt.selection).options).every(
          (option) =>
            identifier(option.id) !== null &&
            (typeof option.value === "boolean" || identifier(option.value) !== null),
        ))) &&
    typeof receipt.branch === "string" &&
    (receipt.version === 1
      ? typeof receipt.bridgeVersion === "string"
      : receipt.adapterVersion === "1") &&
    typeof receipt.createdAt === "string" &&
    typeof receipt.updatedAt === "string" &&
    typeof receipt.workspacePath === "string" &&
    typeof receipt.receiptPath === "string" &&
    typeof receipt.promptDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.promptDigest) &&
    T3_PERMISSION_MODES.includes(receipt.permission as T3PermissionMode) &&
    ["dispatching", "succeeded", "failed", "indeterminate"].includes(receipt.status as string) &&
    (environment.id === null || identifier(environment.id) !== null) &&
    nullableString(environment.serverVersion) &&
    (project.id === null || identifier(project.id) !== null) &&
    project.title === null &&
    (project.created === null || typeof project.created === "boolean") &&
    (thread.id === null || identifier(thread.id) !== null) &&
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
    // Legacy bridge errors/guidance and unknown extension fields may contain raw output.
    // Keep duplicate protection, but return only the known credential-free receipt surface.
    return {
      version: receipt.version,
      branch: receipt.branch,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
      status: receipt.status,
      workspacePath: receipt.workspacePath,
      permission: receipt.permission,
      promptDigest: receipt.promptDigest,
      receiptPath: receipt.receiptPath,
      ...(receipt.version === 1
        ? { bridgeVersion: receipt.bridgeVersion }
        : {
            adapter: "native" as const,
            adapterVersion: "1" as const,
            native: {
              environmentId: receipt.native!.environmentId,
              projectId: receipt.native!.projectId,
              threadId: receipt.native!.threadId,
              messageId: receipt.native!.messageId,
              phase: receipt.native!.phase,
            },
            ...(receipt.selection
              ? {
                  selection: {
                    instanceId: receipt.selection.instanceId,
                    model: receipt.selection.model,
                    options: receipt.selection.options.map((option) => ({
                      id: option.id,
                      value: option.value,
                    })),
                  },
                }
              : {}),
          }),
      environment: { id: receipt.environment.id, serverVersion: receipt.environment.serverVersion },
      project: { id: receipt.project.id, title: null, created: receipt.project.created },
      thread: { id: receipt.thread.id, title: null },
      dispatch: { status: receipt.dispatch.status },
      ui: { mode: "none", kind: "none", exactThread: false, status: "skipped" },
      retry: {
        safe: receipt.version === 2 && receipt.retry.safe,
        guidance:
          "Reconcile the saved identifiers and submission phase before retrying. Legacy receipts require manual reconciliation.",
      },
      ...(receipt.error
        ? {
            error: {
              code: "T3_PREVIOUS_HANDOFF_FAILED",
              message: "A previous handoff failed; reconcile its saved identifiers.",
            },
          }
        : {}),
    };
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
  adapterVersion: "1";
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
  ui: { exactThread: false, kind: "none", mode: "none", status: "skipped" },
  retry: { safe: input.status === "failed", guidance: "" },
});

export const dispatchT3Handoff = async (input: {
  branch: string;
  environment: T3NativeEnvironment;
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
        adapterVersion: "1",
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
  const execute = async (): Promise<T3HandoffResult> => {
    const existing = await readReceipt(receiptPath);
    if (existing && existing.workspacePath !== workspacePath) {
      throw new T3HandoffError(
        "T3_RECEIPT_INVALID",
        "Receipt does not match the canonical workspace.",
        { receiptPath },
      );
    }
    const matchingIntent =
      !existing ||
      (existing.promptDigest === input.request.promptDigest &&
        existing.permission === input.request.permission &&
        (!existing.selection ||
          Object.entries(input.environment.settings).every(([key, value]) =>
            key === "provider"
              ? value === existing.selection!.instanceId ||
                records(input.environment.config.providers).some(
                  (provider) =>
                    provider.instanceId === existing.selection!.instanceId &&
                    provider.driver === value,
                )
              : key === "model"
                ? value === existing.selection!.model ||
                  records(input.environment.config.providers).some(
                    (provider) =>
                      provider.instanceId === existing.selection!.instanceId &&
                      records(provider.models).some(
                        (model) =>
                          model.slug === existing.selection!.model &&
                          Array.isArray(model.aliases) &&
                          model.aliases.includes(value),
                      ),
                  )
                : key === "effort"
                  ? existing.selection!.options.some(
                      (option) =>
                        ["effort", "reasoningEffort"].includes(option.id) && option.value === value,
                    )
                  : true,
          )));
    if (
      !matchingIntent ||
      (existing && (existing.version === 1 || existing.status === "succeeded"))
    ) {
      throw new T3HandoffError(
        matchingIntent ? "T3_DUPLICATE_HANDOFF_BLOCKED" : "T3_HANDOFF_INTENT_CHANGED",
        "Reconcile the existing handoff before starting another task.",
        { receiptPath },
        existing ?? undefined,
      );
    }
    if (existing?.native && existing.native.environmentId !== input.environment.environmentId) {
      throw new T3HandoffError(
        "T3_ENVIRONMENT_CHANGED",
        "The receipt belongs to a different T3 environment. Select that environment and reconcile it.",
        { receiptPath },
        existing,
      );
    }
    const now = (dependencies.now ?? (() => new Date()))().toISOString();
    let receipt: T3HandoffReceipt = {
      ...emptyResult({
        adapterVersion: "1",
        permission: input.request.permission,
        promptDigest: input.request.promptDigest,
        receiptPath,
        status: "dispatching",
        workspacePath,
      }),
      adapter: "native",
      branch: input.branch,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: 2,
      environment: {
        id: input.environment.environmentId,
        serverVersion: input.environment.serverVersion,
      },
      native: existing?.native ?? {
        environmentId: input.environment.environmentId,
        projectId: randomUUID(),
        threadId: randomUUID(),
        messageId: randomUUID(),
        phase: "preparing",
      },
      ...(existing?.selection ? { selection: existing.selection } : {}),
      project: existing?.project ?? { id: null, title: null, created: null },
      thread: existing?.thread ?? { id: null, title: null },
      retry: {
        safe: false,
        guidance: "Reconcile saved identifiers before retrying; no blind resubmission.",
      },
    };
    const save = async (): Promise<void> => {
      receipt.updatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
      try {
        await persistReceipt(receiptPath, receipt, dependencies);
      } catch {
        throw new T3HandoffError(
          "T3_RECEIPT_WRITE_FAILED",
          "The handoff receipt could not be saved. Reconcile the reported identifiers before retrying.",
          { receiptPath, receiptWriteFailed: true },
          {
            ...receipt,
            retry: {
              safe: false,
              guidance: "Repair receipt storage and reconcile T3 before retrying.",
            },
          },
        );
      }
    };
    await save();
    try {
      return await withT3Session(
        input.environment,
        workspacePath,
        dependencies,
        async (request, token) => {
          const descriptor = await t3Http(
            input.environment.origin,
            undefined,
            dependencies,
          )("/.well-known/t3/environment");
          verifyT3Version(descriptor.serverVersion);
          verifyT3Protocol(descriptor);
          if (descriptor.environmentId !== receipt.native!.environmentId)
            throw new T3HandoffError(
              "T3_ENVIRONMENT_CHANGED",
              "The selected T3 environment changed after preflight.",
            );
          const liveConfig = await (dependencies.getConfig ?? readT3Config)(
            input.environment.origin,
            token,
            request,
          );
          const snapshot = await request("/api/orchestration/snapshot");
          if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.threads))
            throw new T3HandoffError("T3_RESPONSE_INVALID", "T3 snapshot is incompatible.");
          const projects = records(snapshot.projects).filter(
            (project) => project.deletedAt === null && project.workspaceRoot === workspacePath,
          );
          if (projects.length > 1)
            throw new T3HandoffError(
              "T3_PROJECT_AMBIGUOUS",
              "Multiple T3 projects use this exact checkout; reconcile them before continuing.",
            );
          const project = projects[0];
          if (existing?.project.id && (!project || project.id !== existing.project.id))
            throw new T3HandoffError(
              "T3_PROJECT_CHANGED",
              "The recorded project is missing or changed; reconcile it before retrying.",
            );
          if (project) {
            const projectId = identifier(project.id);
            if (!projectId)
              throw new T3HandoffError(
                "T3_RESPONSE_INVALID",
                "T3 project identifier is incompatible.",
              );
            receipt.native!.projectId = projectId;
            receipt.project = {
              id: projectId,
              title: null,
              created: existing?.project.created ?? false,
            };
          }
          receipt.selection ??= resolveT3Selection(liveConfig, input.environment.settings, project);
          if (receipt.native!.phase === "preparing") {
            resolveT3Selection(
              liveConfig,
              { provider: receipt.selection.instanceId },
              { defaultModelSelection: receipt.selection },
            );
          }
          await save();
          const post = async (command: Record<string, unknown>): Promise<void> => {
            const response = await request("/api/orchestration/dispatch", command);
            if (typeof response.sequence !== "number")
              throw new T3HandoffError(
                "T3_RESPONSE_INVALID",
                "T3 dispatch acknowledgement is incompatible; reconcile saved identifiers.",
              );
          };
          if (!project) {
            await post({
              type: "project.create",
              commandId: `arashi-project-${receipt.native!.projectId}`,
              projectId: receipt.native!.projectId,
              title: input.branch,
              workspaceRoot: workspacePath,
              createdAt: now,
            });
            receipt.project = { id: receipt.native!.projectId, title: null, created: true };
            await save();
          }
          const thread = records(snapshot.threads).find(
            (value) => value.id === receipt.native!.threadId,
          );
          if (
            thread &&
            (thread.projectId !== receipt.native!.projectId ||
              thread.worktreePath !== null ||
              thread.deletedAt !== null)
          )
            throw new T3HandoffError(
              "T3_THREAD_CHANGED",
              "The recorded T3 thread is missing or no longer uses the exact parent checkout.",
            );
          if (
            !thread &&
            existing?.native?.phase !== undefined &&
            existing.native.phase !== "preparing"
          )
            throw new T3HandoffError(
              "T3_DISPATCH_UNCERTAIN",
              "The submitted thread is not visible; reconcile it before retrying.",
            );
          if (!thread) {
            await post({
              type: "thread.create",
              commandId: `arashi-thread-${receipt.native!.threadId}`,
              threadId: receipt.native!.threadId,
              projectId: receipt.native!.projectId,
              title: input.branch,
              modelSelection: receipt.selection,
              runtimeMode: input.request.permission,
              interactionMode: "default",
              branch: input.branch,
              worktreePath: null,
              createdAt: now,
            });
          }
          receipt.thread = { id: receipt.native!.threadId, title: null };
          await save();
          if (existing?.native?.phase !== undefined && existing.native.phase !== "preparing") {
            const detail = await request(`/api/orchestration/threads/${receipt.native!.threadId}`);
            const messages = records(record(detail.thread).messages);
            if (
              !messages.some(
                (message) => message.id === receipt.native!.messageId && message.role === "user",
              )
            )
              throw new T3HandoffError(
                "T3_DISPATCH_UNCERTAIN",
                "No conclusive acceptance evidence for the saved task. Do not resubmit; reconcile this thread in T3.",
              );
          } else {
            receipt.native!.phase = "submitting";
            await save(); // Durable uncertainty marker precedes the only task submission.
            await post({
              type: "thread.turn.start",
              commandId: `arashi-turn-${receipt.native!.messageId}`,
              threadId: receipt.native!.threadId,
              message: {
                messageId: receipt.native!.messageId,
                role: "user",
                text: input.request.prompt,
                attachments: [],
              },
              modelSelection: receipt.selection,
              runtimeMode: input.request.permission,
              interactionMode: "default",
              createdAt: now,
            });
          }
          receipt.native!.phase = "accepted";
          receipt.status = "succeeded";
          receipt.dispatch = { status: "succeeded" };
          receipt.retry = {
            safe: false,
            guidance:
              "The task was accepted. Manually select the reported project/thread in a connected T3 client; no host UI was opened.",
          };
          delete receipt.error;
          await save();
          return receipt;
        },
      );
    } catch (error) {
      if (error instanceof T3HandoffError && error.details.receiptWriteFailed) throw error;
      const failure =
        error instanceof T3HandoffError
          ? error
          : new T3HandoffError(
              "T3_HANDOFF_FAILED",
              "Native T3 handoff failed. Reconcile saved identifiers before retrying.",
            );
      const safe = receipt.native!.phase === "preparing";
      // A cleanup failure after proven acceptance does not erase success.
      if (receipt.status !== "succeeded") {
        receipt.status = safe ? "failed" : "indeterminate";
        receipt.dispatch = { status: receipt.status };
        receipt.retry = {
          safe,
          guidance: safe
            ? "Fix the problem and reuse this workspace with the same intent; saved project/thread identifiers are reconciled before continuing."
            : "Reconcile the recorded thread and message. A retry can confirm acceptance but will never resubmit an uncertain task.",
        };
        receipt.error = { code: failure.code, message: failure.message };
        await save();
      }
      throw new T3HandoffError(
        failure.code,
        failure.message,
        { ...failure.details, receiptPath },
        receipt,
      );
    }
  };
  let outcome: T3HandoffResult | undefined;
  let failure: unknown;
  try {
    outcome = await execute();
  } catch (error) {
    failure = error;
  }
  try {
    await releaseReceiptLock();
  } catch (error) {
    const original = failure instanceof T3HandoffError ? failure : undefined;
    const knownOutcome = outcome ?? original?.result;
    const lockFailure = new T3HandoffError(
      original?.code ?? "T3_LOCK_CLEANUP_FAILED",
      `${original?.message ?? "T3 handoff completed."} The receipt lock could not be removed; reconcile it before retrying.`,
      {
        ...original?.details,
        receiptPath,
        lockPath: `${receiptPath}.lock`,
        lockCleanupFailed: true,
      },
      knownOutcome
        ? {
            ...knownOutcome,
            retry: {
              safe: false,
              guidance: `Reconcile the reported outcome and remove the retained lock before retrying: ${receiptPath}.lock`,
            },
          }
        : undefined,
    );
    lockFailure.cause = failure ?? error;
    throw lockFailure;
  }
  if (failure) throw failure;
  return outcome!;
};
