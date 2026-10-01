import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exec } from "./git.ts";
import { T3HandoffError } from "./t3-error.ts";
import {
  acquireReceiptLock,
  persistReceipt,
  projectUsesWorkspace,
  readReceipt,
  secureReceiptDirectory,
  t3ReceiptPath,
} from "./t3-handoff.ts";
import type {
  T3HandoffDependencies,
  T3HandoffReceipt,
  T3HandoffRequest,
  T3HandoffResult,
} from "./t3-handoff.ts";
import {
  identifier,
  readT3CliVersion,
  readT3Config,
  record,
  records,
  resolveT3Selection,
  t3Http,
  verifyT3Protocol,
  verifyT3Version,
  withT3Session,
} from "./t3-native.ts";
import type { T3NativeEnvironment } from "./t3-native.ts";
import { randomUUID } from "node:crypto";
import { validateT3Settings, type T3Settings } from "./t3-settings.ts";

export interface SwitchGitIdentity {
  commonDirectory: string;
  gitDirectory: string;
  device: string;
  inode: string;
}
export interface SwitchT3Descriptor {
  command: "switch";
  intentId: string;
  explicitSettings: Record<string, string>;
  provenance: Record<string, string>;
  selectedGitIdentity: SwitchGitIdentity;
  repository: string;
}
interface SwitchReceipt extends T3HandoffReceipt {
  version: 3;
  command: "switch";
  intentId: string;
  selectedGitIdentity: SwitchGitIdentity;
  repository: string;
  preparation: {
    project: "not-attempted" | "requesting" | "confirmed";
    thread: "not-attempted" | "requesting" | "confirmed";
  };
  pinnedSettings: T3Settings;
  requestedSettings: Record<string, string>;
  provenance: Record<string, string>;
}
interface Input {
  branch: string;
  environment: T3NativeEnvironment;
  dryRun: boolean;
  request: T3HandoffRequest;
  workspacePath: string;
  dependencies?: T3HandoffDependencies;
  switch: SwitchT3Descriptor;
}
const failure = (code: string, message: string, result?: T3HandoffResult): never => {
  throw new T3HandoffError(code, message, {}, result);
};
export function validateSwitchT3Intent(intent: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(intent)) {
    failure(
      "T3_INTENT_INVALID",
      "T3 intent must be 1–64 ASCII letters, numbers, dots, underscores or hyphens, starting with a letter or number.",
    );
  }
}
const key = (intent: string) => "i-" + Buffer.from(intent, "utf8").toString("hex");
export async function switchGitIdentity(path: string): Promise<SwitchGitIdentity> {
  const physical = await realpath(path);
  const metadata = await stat(physical, { bigint: true });
  const common = (await exec(["rev-parse", "--git-common-dir"], physical)).stdout.trim();
  const git = (await exec(["rev-parse", "--absolute-git-dir"], physical)).stdout.trim();
  const top = (await exec(["rev-parse", "--show-toplevel"], physical)).stdout.trim();
  if ((await realpath(top)) !== physical) {
    failure("T3_WORKSPACE_UNVERIFIED", "Select the registered checkout root with --path.");
  }
  return {
    commonDirectory: await realpath(resolve(physical, common)),
    device: String(metadata.dev),
    gitDirectory: await realpath(git),
    inode: String(metadata.ino),
  };
}
const sameIdentity = (left: SwitchGitIdentity, right: SwitchGitIdentity) =>
  ["commonDirectory", "gitDirectory", "device", "inode"].every(
    (field) => left[field as keyof SwitchGitIdentity] === right[field as keyof SwitchGitIdentity],
  );
export async function revalidateSwitchGitIdentity(
  path: string,
  expected: SwitchGitIdentity,
): Promise<void> {
  try {
    if (!sameIdentity(await switchGitIdentity(path), expected)) {
      failure(
        "T3_WORKSPACE_CHANGED",
        "The selected checkout was replaced or changed. Select it again before handoff.",
      );
    }
  } catch (error) {
    if (error instanceof T3HandoffError) {
      throw error;
    }
    failure(
      "T3_WORKSPACE_CHANGED",
      "The selected checkout is unavailable or no longer has its selected Git identity.",
    );
  }
}
async function metadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function plain(path: string, directory: boolean, ownerOnly = false) {
  const info = await metadata(path);
  if (!info) {
    return false;
  }
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (ownerOnly && process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    failure(
      "T3_RECEIPT_UNSAFE",
      "Receipt storage has unsafe protection or entries. Back up and reconcile this exact checkout before retrying.",
    );
  }
  return true;
}
async function validateRoot(createPath: string) {
  const root = dirname(createPath);
  if (!(await plain(root, true))) {
    return;
  }
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if (/^[a-f0-9]{64}\.switch$/u.test(name)) {
      await plain(path, true);
      continue;
    }
    if (/^[a-f0-9]{64}\.json(?:\.lock)?$/u.test(name)) {
      await plain(path, false);
      continue;
    }
    failure(
      "T3_RECEIPT_UNSAFE",
      "Unknown receipt-root entry or unassignable temporary file. Back up and reconcile storage before retrying; no temporary file was promoted or deleted.",
    );
  }
}
const nativeFields = (value: unknown) => {
  const v = record(value);
  return (
    ["environmentId", "projectId", "threadId", "messageId"].every((field) =>
      Boolean(identifier(v[field])),
    ) &&
    typeof v.phase === "string" &&
    ["preparing", "submitting", "accepted"].includes(v.phase)
  );
};
function projectReceipt(receipt: SwitchReceipt): SwitchReceipt {
  // Explicit projection: unknown receipt extensions never reach output or a subsequent save.
  const selection = receipt.selection
    ? {
        instanceId: receipt.selection.instanceId,
        model: receipt.selection.model,
        options: receipt.selection.options.map((option) => ({
          id: option.id,
          value: option.value,
        })),
      }
    : undefined;
  return {
    version: 3,
    command: "switch",
    intentId: receipt.intentId,
    selectedGitIdentity: {
      commonDirectory: receipt.selectedGitIdentity.commonDirectory,
      gitDirectory: receipt.selectedGitIdentity.gitDirectory,
      device: receipt.selectedGitIdentity.device,
      inode: receipt.selectedGitIdentity.inode,
    },
    repository: receipt.repository,
    branch: receipt.branch,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    status: receipt.status,
    adapter: "native",
    adapterVersion: "1",
    workspacePath: receipt.workspacePath,
    permission: receipt.permission,
    promptDigest: receipt.promptDigest,
    environment: { id: receipt.environment.id, serverVersion: receipt.environment.serverVersion },
    project: { created: receipt.project.created, id: receipt.project.id, title: null },
    thread: { id: receipt.thread.id, title: null },
    native: {
      environmentId: receipt.native!.environmentId,
      projectId: receipt.native!.projectId,
      threadId: receipt.native!.threadId,
      messageId: receipt.native!.messageId,
      phase: receipt.native!.phase,
    },
    ...(selection ? { selection } : {}),
    dispatch: { status: receipt.dispatch.status },
    ui: { exactThread: false, kind: "none", mode: "none", status: "skipped" },
    receiptPath: receipt.receiptPath,
    retry: {
      guidance:
        receipt.status === "succeeded"
          ? "Task accepted. Manually select the reported project/thread in the connected T3 client; no host UI opened."
          : "Reconcile saved project/thread/message IDs in the original environment. Retry this exact path and intent with the same prompt; never choose a new intent to bypass uncertainty.",
      safe: false,
    },
    preparation: { project: receipt.preparation.project, thread: receipt.preparation.thread },
    pinnedSettings: { ...receipt.pinnedSettings },
    requestedSettings: { ...receipt.requestedSettings },
    provenance: { ...receipt.provenance },
    ...(receipt.error
      ? {
          error: {
            code: "T3_PREVIOUS_HANDOFF_FAILED",
            message: "Reconcile the previous handoff using its saved identifiers.",
          },
        }
      : {}),
  };
}
const strings = (entries: unknown, keys: string[], allowed?: string[]) => {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
  return Object.entries(entries).every(
    ([name, content]) =>
      keys.includes(name) &&
      typeof content === "string" &&
      Boolean(content.trim()) &&
      (!allowed || allowed.includes(content)) &&
      !/\p{Cc}/u.test(content),
  );
};

async function switchReceipts(
  workspace: string,
  createPath: string,
  identity: SwitchGitIdentity,
): Promise<SwitchReceipt[]> {
  const directory = createPath.slice(0, -5) + ".switch";
  if (!(await plain(directory, true, true))) {
    return [];
  }
  const receipts: SwitchReceipt[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if (!/^i-(?:[a-f0-9]{2})+\.json$/u.test(name) || !(await plain(path, false, true))) {
      failure(
        "T3_RECEIPT_UNSAFE",
        "Unknown or unsafe switch receipt entry. Preserve storage and reconcile before retrying.",
      );
    }
    let value: SwitchReceipt;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      failure(
        "T3_RECEIPT_INVALID",
        "Switch receipt is unreadable or corrupt; preserve and reconcile it.",
      );
    }
    const native = record(value!.native),
      preparation = record(value!.preparation);
    if (
      value!.version !== 3 ||
      value!.command !== "switch" ||
      typeof value!.intentId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value!.intentId) ||
      name !== key(value!.intentId) + ".json" ||
      value!.receiptPath !== path ||
      value!.workspacePath !== workspace ||
      !sameIdentity(record(value!.selectedGitIdentity) as unknown as SwitchGitIdentity, identity) ||
      !nativeFields(native) ||
      typeof preparation.project !== "string" ||
      !["not-attempted", "requesting", "confirmed"].includes(preparation.project) ||
      typeof preparation.thread !== "string" ||
      !["not-attempted", "requesting", "confirmed"].includes(preparation.thread) ||
      !["dispatching", "succeeded", "failed", "indeterminate"].includes(value!.status) ||
      !["approval-required", "auto-accept-edits", "full-access"].includes(value!.permission) ||
      typeof value!.promptDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value!.promptDigest) ||
      !value!.environment ||
      !value!.project ||
      !value!.thread ||
      !value!.dispatch ||
      !["dispatching", "succeeded", "failed", "indeterminate"].includes(value!.dispatch.status) ||
      typeof value!.environment.serverVersion !== "string" ||
      typeof value!.createdAt !== "string" ||
      typeof value!.updatedAt !== "string" ||
      !value!.pinnedSettings ||
      !value!.requestedSettings ||
      !value!.provenance ||
      typeof value!.branch !== "string" ||
      typeof value!.repository !== "string"
    ) {
      failure(
        "T3_RECEIPT_INVALID",
        "Switch receipt literal, key, schema or checkout identity does not match. Preserve and reconcile it before retrying.",
      );
    }
    if (
      value!.selection &&
      (!identifier(value!.selection.instanceId) ||
        !(
          typeof value!.selection.model === "string" &&
          value!.selection.model.trim() &&
          !/\p{Cc}/u.test(value!.selection.model)
        ) ||
        !Array.isArray(value!.selection.options) ||
        !value!.selection.options.every(
          (option) =>
            option &&
            identifier(option.id) &&
            (typeof option.value === "string" ||
              typeof option.value === "boolean" ||
              (typeof option.value === "number" && Number.isFinite(option.value))),
        ))
    ) {
      failure("T3_RECEIPT_INVALID", "Switch receipt selection is invalid.");
    }
    try {
      validateT3Settings(value!.pinnedSettings, "Saved T3 settings");
    } catch {
      failure(
        "T3_RECEIPT_INVALID",
        "Saved T3 settings have an invalid schema. Preserve and reconcile the receipt.",
      );
    }
    if (
      !strings(value!.requestedSettings, [
        "baseDir",
        "cli",
        "provider",
        "model",
        "effort",
        "permission",
      ]) ||
      !strings(
        value!.provenance,
        ["baseDir", "cli", "provider", "model", "effort"],
        ["cli", "workspace", "user", "native"],
      )
    )
      failure(
        "T3_RECEIPT_INVALID",
        "Saved setting provenance has an invalid schema. Preserve and reconcile the receipt.",
      );
    if (
      value!.environment.id !== value!.native!.environmentId ||
      (value!.project.id !== null && value!.project.id !== value!.native!.projectId) ||
      (value!.thread.id !== null && value!.thread.id !== value!.native!.threadId)
    )
      failure(
        "T3_RECEIPT_INVALID",
        "Saved identifiers have conflicting evidence. Preserve and reconcile the receipt.",
      );
    const progressed = native.phase === "submitting" || native.phase === "accepted";
    const success =
      value!.status === "succeeded" ||
      value!.dispatch.status === "succeeded" ||
      native.phase === "accepted";
    if (
      (value!.project.created !== null && typeof value!.project.created !== "boolean") ||
      (preparation.project === "confirmed" && value!.project.id !== native.projectId) ||
      (preparation.project !== "confirmed" && value!.project.id !== null) ||
      (preparation.thread !== "not-attempted" && preparation.project !== "confirmed") ||
      (preparation.thread === "confirmed" && value!.thread.id !== native.threadId) ||
      (preparation.thread !== "confirmed" && value!.thread.id !== null) ||
      (progressed &&
        (preparation.project !== "confirmed" ||
          preparation.thread !== "confirmed" ||
          !value!.selection)) ||
      (success &&
        !(
          value!.status === "succeeded" &&
          value!.dispatch.status === "succeeded" &&
          native.phase === "accepted"
        ))
    ) {
      failure(
        "T3_RECEIPT_INVALID",
        "Saved preparation and dispatch evidence is contradictory. Preserve and reconcile the receipt.",
      );
    }
    receipts.push(projectReceipt(value!));
  }
  return receipts;
}
const accepted = (receipt: SwitchReceipt) =>
  receipt.status === "succeeded" &&
  receipt.native?.phase === "accepted" &&
  receipt.dispatch.status === "succeeded";
function checkBlockingSwitchIntent(receipts: SwitchReceipt[], requestedIntentId: string): void {
  const blocking = receipts.find(
    (receipt) => receipt.intentId !== requestedIntentId && !accepted(receipt),
  );
  if (blocking) {
    throw new T3HandoffError(
      "T3_UNRESOLVED_HANDOFF",
      "An unresolved sibling intent protects this checkout. Reconcile the saved intent; a fresh intent cannot bypass uncertainty.",
      {
        blockingIntentId: blocking.intentId,
        requestedIntentId,
        receiptPath: blocking.receiptPath,
      },
      publicResult(blocking),
    );
  }
}
export async function checkSwitchT3SiblingsForCreate(
  workspace: string,
  dependencies: T3HandoffDependencies,
): Promise<void> {
  const create = await t3ReceiptPath(workspace, dependencies);
  await validateRoot(create);
  // Existing create fixtures and adapters need no new identity probe when there
  // is no switch namespace. Its receipt path/schema and recovery stay unchanged.
  if (!(await plain(create.slice(0, -5) + ".switch", true, true))) return;
  const receipts = await switchReceipts(workspace, create, await switchGitIdentity(workspace));
  if (receipts.some((receipt) => !accepted(receipt))) {
    failure(
      "T3_UNRESOLVED_HANDOFF",
      "An unresolved switch intent protects this checkout. Reconcile its saved IDs before create can hand off.",
    );
  }
}
/** Read-only admission hint; final admission and identity checks repeat under the dispatch lock. */
export async function switchT3PinnedSettings(
  workspace: string,
  intent: string,
  dependencies: T3HandoffDependencies = {},
  requested?: { promptDigest: string; explicitSettings: Record<string, string> },
): Promise<{ settings: T3Settings; result: T3HandoffResult } | undefined> {
  const create = await t3ReceiptPath(workspace, dependencies);
  if (await metadata(create + ".lock")) {
    throw new T3HandoffError(
      "T3_HANDOFF_LOCKED",
      "Another handoff owns this exact checkout. Reconcile owner termination and saved native evidence before manual lock removal.",
      { lockPath: create + ".lock" },
    );
  }
  await validateRoot(create);
  const receipts = await switchReceipts(
    await realpath(workspace),
    create,
    await switchGitIdentity(workspace),
  );
  checkBlockingSwitchIntent(receipts, intent);
  const saved = receipts.find((receipt) => receipt.intentId === intent);
  if (!saved) {
    return undefined;
  }
  if (requested) {
    if (saved.promptDigest !== requested.promptDigest) {
      failure(
        "T3_HANDOFF_INTENT_CHANGED",
        "Reuse the original prompt for this saved intent.",
        publicResult(saved),
      );
    }
    for (const [leaf, value] of Object.entries(requested.explicitSettings)) {
      const original =
        leaf === "permission"
          ? saved.permission
          : (saved.requestedSettings[leaf] ?? saved.pinnedSettings[leaf as keyof T3Settings]);
      if (value !== original) {
        failure(
          "T3_HANDOFF_INTENT_CHANGED",
          "An explicitly authored setting changed under this saved intent. Reuse the original settings.",
          publicResult(saved),
        );
      }
    }
  }
  return { result: publicResult(saved), settings: saved.pinnedSettings };
}
const publicResult = (receipt: SwitchReceipt): T3HandoffResult => {
  const {
    version: _version,
    command: _command,
    intentId: _intent,
    selectedGitIdentity: _identity,
    repository: _repository,
    branch: _branch,
    createdAt: _created,
    updatedAt: _updated,
    preparation: _preparation,
    pinnedSettings: _pinned,
    requestedSettings: _requested,
    provenance: _provenance,
    ...result
  } = projectReceipt(receipt);
  return result;
};
export async function dispatchSwitchT3Handoff(input: Input): Promise<T3HandoffResult> {
  if (input.dryRun) {
    failure("T3_OPTIONS_INVALID", "Switch handoff has no dry-run action.");
  }
  validateSwitchT3Intent(input.switch.intentId);
  const dependencies = input.dependencies ?? {};
  const workspace = await realpath(input.workspacePath);
  await revalidateSwitchGitIdentity(workspace, input.switch.selectedGitIdentity);
  const createPath = await t3ReceiptPath(workspace, dependencies);
  const release = await acquireReceiptLock(createPath, dependencies);
  let result: T3HandoffResult | undefined;
  let failureOutcome: unknown;
  const run = async () => {
    await validateRoot(createPath);
    await revalidateSwitchGitIdentity(workspace, input.switch.selectedGitIdentity);
    const legacy = await readReceipt(createPath);
    if (
      legacy &&
      (legacy.workspacePath !== workspace ||
        legacy.version !== 2 ||
        legacy.status !== "succeeded" ||
        legacy.native?.phase !== "accepted")
    ) {
      failure(
        "T3_UNRESOLVED_HANDOFF",
        "Existing create receipt requires its original recovery before switch can hand off.",
      );
    }
    const receipts = await switchReceipts(workspace, createPath, input.switch.selectedGitIdentity);
    const existing = receipts.find((receipt) => receipt.intentId === input.switch.intentId);
    checkBlockingSwitchIntent(receipts, input.switch.intentId);
    if (existing) {
      if (existing.promptDigest !== input.request.promptDigest) {
        failure(
          "T3_HANDOFF_INTENT_CHANGED",
          "The prompt changed under this saved intent. Reuse the original prompt or, only after resolution, choose a deliberate followup intent.",
          publicResult(existing),
        );
      }
      for (const [leaf, value] of Object.entries(input.switch.explicitSettings)) {
        const pinned =
          leaf === "permission"
            ? existing.permission
            : (existing.requestedSettings[leaf] ??
              existing.pinnedSettings[leaf as keyof T3Settings]);
        if (value !== pinned) {
          failure(
            "T3_HANDOFF_INTENT_CHANGED",
            "An explicitly authored setting changed under this saved intent. Reuse the original settings.",
            publicResult(existing),
          );
        }
      }
      if (existing.native!.environmentId !== input.environment.environmentId) {
        failure(
          "T3_ENVIRONMENT_CHANGED",
          "Use the original saved T3 environment to reconcile this intent.",
          publicResult(existing),
        );
      }
    }
    const receiptPath = join(
      createPath.slice(0, -5) + ".switch",
      key(input.switch.intentId) + ".json",
    );
    await secureReceiptDirectory(dirname(receiptPath), dependencies);
    const now = (dependencies.now ?? (() => new Date()))().toISOString();
    const receipt: SwitchReceipt = existing ?? {
      version: 3,
      command: "switch",
      intentId: input.switch.intentId,
      selectedGitIdentity: { ...input.switch.selectedGitIdentity },
      repository: input.switch.repository,
      branch: input.branch,
      createdAt: now,
      updatedAt: now,
      status: "dispatching",
      adapter: "native",
      adapterVersion: "1",
      workspacePath: workspace,
      permission: input.request.permission,
      promptDigest: input.request.promptDigest,
      environment: {
        id: input.environment.environmentId,
        serverVersion: input.environment.serverVersion,
      },
      project: { id: null, title: null, created: null },
      thread: { id: null, title: null },
      dispatch: { status: "dispatching" },
      ui: { mode: "none", kind: "none", exactThread: false, status: "skipped" },
      receiptPath,
      retry: { safe: false, guidance: "Reconcile the exact saved IDs before retrying." },
      native: {
        environmentId: input.environment.environmentId,
        projectId: randomUUID(),
        threadId: randomUUID(),
        messageId: randomUUID(),
        phase: "preparing",
      },
      preparation: { project: "not-attempted", thread: "not-attempted" },
      pinnedSettings: {
        baseDir: input.environment.baseDir,
        cli: input.environment.cli,
        ...input.environment.settings,
      },
      requestedSettings: { ...input.environment.settings, ...input.switch.explicitSettings },
      provenance: { ...input.switch.provenance },
    };
    const save = async (stage: string) => {
      receipt.updatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
      try {
        await persistReceipt(receiptPath, receipt, dependencies, stage);
      } catch {
        throw new T3HandoffError(
          "T3_RECEIPT_WRITE_FAILED",
          "Receipt durability failed. Preserve receipt/temporary files and reconcile reported IDs before retrying.",
          { receiptPath, receiptWriteFailed: true },
          publicResult(receipt),
        );
      }
    };
    if (!existing) {
      await save("initial");
    }
    try {
      const descriptor = await t3Http(
        input.environment.origin,
        undefined,
        dependencies,
      )("/.well-known/t3/environment");
      verifyT3Version(descriptor.serverVersion);
      verifyT3Protocol(descriptor);
      if (
        descriptor.environmentId !== receipt.native!.environmentId ||
        descriptor.serverVersion !== input.environment.serverVersion
      ) {
        failure("T3_ENVIRONMENT_CHANGED", "The selected T3 environment changed after preflight.");
      }
      if (
        (await readT3CliVersion(input.environment.cli, workspace, dependencies)) !==
        descriptor.serverVersion
      ) {
        failure(
          "T3_VERSION_MISMATCH",
          "The selected official CLI/server versions changed after preflight.",
        );
      }
      return await withT3Session(
        input.environment,
        workspace,
        dependencies,
        async (request, token) => {
          const config = await (dependencies.getConfig ?? readT3Config)(
            input.environment.origin,
            token,
            request,
          );
          const snapshot = await request("/api/orchestration/snapshot");
          if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.threads)) {
            failure("T3_RESPONSE_INVALID", "Native snapshot is incompatible.");
          }
          const projects = records(snapshot.projects),
            threads = records(snapshot.threads);
          const matches: Record<string, unknown>[] = [];
          for (const candidate of projects) {
            if (
              candidate.deletedAt === null &&
              (await projectUsesWorkspace(candidate.workspaceRoot, workspace))
            )
              matches.push(candidate);
          }
          if (matches.length > 1) {
            failure(
              "T3_PROJECT_AMBIGUOUS",
              "Multiple native projects use this exact checkout. Reconcile them before retrying.",
            );
          }
          const recordedProject = projects.find(
            (candidate) => candidate.id === receipt.native!.projectId,
          );
          if (recordedProject && !matches.includes(recordedProject)) {
            failure(
              "T3_PROJECT_CHANGED",
              "Saved project changed, was deleted or no longer uses this exact checkout.",
            );
          }
          let project = matches[0];
          if (
            receipt.preparation.project !== "not-attempted" &&
            (!project || project.id !== receipt.native!.projectId)
          ) {
            failure(
              "T3_PREPARATION_UNCERTAIN",
              "The attempted saved project has no exact positive acceptance evidence. Do not create a replacement.",
            );
          }
          if (project) {
            const id = identifier(project.id);
            if (!id) {
              failure("T3_RESPONSE_INVALID", "Native project identifier is incompatible.");
            }
            receipt.native!.projectId = id!;
            receipt.project = { created: existing?.project.created ?? false, id: id!, title: null };
            receipt.preparation.project = "confirmed";
          }
          receipt.selection ??= resolveT3Selection(config, input.environment.settings, project);
          const savedEffort = receipt.selection.options.find((option) =>
            ["effort", "reasoningEffort"].includes(option.id),
          )?.value;
          const effort = typeof savedEffort === "string" ? savedEffort : undefined;
          // Validate every pinned native option against today's official catalog;
          // project/server defaults must not change an admitted intent's selection.
          resolveT3Selection(
            config,
            { provider: receipt.selection.instanceId, model: receipt.selection.model },
            { defaultModelSelection: receipt.selection },
          );
          receipt.pinnedSettings = {
            ...receipt.pinnedSettings,
            model: receipt.selection.model,
            provider: receipt.selection.instanceId,
            ...(effort ? { effort } : {}),
          };
          const post = async (command: Record<string, unknown>) => {
            await revalidateSwitchGitIdentity(workspace, input.switch.selectedGitIdentity);
            const acknowledgement = await request("/api/orchestration/dispatch", command);
            if (typeof acknowledgement.sequence !== "number") {
              failure(
                "T3_RESPONSE_INVALID",
                "Native acknowledgement is incompatible; reconcile saved IDs.",
              );
            }
          };
          if (!existing) {
            await save("selection");
          }
          if (!project) {
            receipt.preparation.project = "requesting";
            await save("project-requesting");
            await post({
              commandId: "arashi-project-" + receipt.native!.projectId,
              createdAt: now,
              projectId: receipt.native!.projectId,
              title: input.branch,
              type: "project.create",
              workspaceRoot: workspace,
            });
            receipt.project = { created: true, id: receipt.native!.projectId, title: null };
            receipt.preparation.project = "confirmed";
            await save("project-confirmed");
            project = { deletedAt: null, id: receipt.native!.projectId, workspaceRoot: workspace };
          }
          const thread = threads.find((candidate) => candidate.id === receipt.native!.threadId);
          if (
            thread &&
            (thread.projectId !== receipt.native!.projectId ||
              thread.worktreePath !== null ||
              thread.deletedAt !== null)
          ) {
            failure(
              "T3_THREAD_CHANGED",
              "Saved thread changed or no longer uses the exact project/checkout.",
            );
          }
          if (
            !thread &&
            (receipt.native!.phase !== "preparing" ||
              receipt.preparation.thread !== "not-attempted")
          ) {
            failure(
              receipt.native!.phase === "preparing"
                ? "T3_PREPARATION_UNCERTAIN"
                : "T3_DISPATCH_UNCERTAIN",
              "Saved attempted thread is not positively visible. Do not recreate it.",
            );
          }
          if (!thread) {
            receipt.preparation.thread = "requesting";
            await save("thread-requesting");
            await post({
              branch: input.branch,
              commandId: "arashi-thread-" + receipt.native!.threadId,
              createdAt: now,
              interactionMode: "default",
              modelSelection: receipt.selection,
              projectId: receipt.native!.projectId,
              runtimeMode: receipt.permission,
              threadId: receipt.native!.threadId,
              title: input.branch,
              type: "thread.create",
              worktreePath: null,
            });
            receipt.preparation.thread = "confirmed";
            receipt.thread = { id: receipt.native!.threadId, title: null };
            await save("thread-confirmed");
          } else {
            receipt.preparation.thread = "confirmed";
            receipt.thread = { id: receipt.native!.threadId, title: null };
          }
          if (accepted(receipt)) {
            return publicResult(receipt);
          }
          if (receipt.native!.phase !== "preparing") {
            const detail = await request("/api/orchestration/threads/" + receipt.native!.threadId);
            if (
              !records(record(detail.thread).messages).some(
                (message) => message.id === receipt.native!.messageId && message.role === "user",
              )
            ) {
              failure(
                "T3_DISPATCH_UNCERTAIN",
                "No positive evidence for the saved user message. Retry only for read-only reconciliation; never resubmit or choose a fresh intent.",
              );
            }
          } else {
            receipt.native!.phase = "submitting";
            await save("submitting");
            await post({
              commandId: "arashi-turn-" + receipt.native!.messageId,
              createdAt: now,
              interactionMode: "default",
              message: {
                messageId: receipt.native!.messageId,
                role: "user",
                text: input.request.prompt,
                attachments: [],
              },
              modelSelection: receipt.selection,
              runtimeMode: receipt.permission,
              threadId: receipt.native!.threadId,
              type: "thread.turn.start",
            });
          }
          receipt.native!.phase = "accepted";
          receipt.status = "succeeded";
          receipt.dispatch = { status: "succeeded" };
          delete receipt.error;
          await save("accepted");
          return publicResult(receipt);
        },
      );
    } catch (error) {
      if (error instanceof T3HandoffError && error.details.receiptWriteFailed) throw error;
      const known =
        error instanceof T3HandoffError
          ? error
          : new T3HandoffError(
              "T3_HANDOFF_FAILED",
              "Native handoff failed. Reconcile the saved IDs before retrying.",
            );
      if (!accepted(receipt)) {
        receipt.status = receipt.native!.phase === "preparing" ? "failed" : "indeterminate";
        receipt.dispatch = { status: receipt.status };
        receipt.error = { code: known.code, message: known.message };
        await save("failure");
      }
      throw new T3HandoffError(known.code, known.message, { receiptPath }, publicResult(receipt));
    }
  };
  try {
    result = await run();
  } catch (error) {
    failureOutcome = error;
  }
  try {
    await release();
  } catch {
    const original = failureOutcome instanceof T3HandoffError ? failureOutcome : undefined;
    throw new T3HandoffError(
      original?.code ?? "T3_LOCK_CLEANUP_FAILED",
      "The shared receipt lock could not be released. Preserve the known outcome and reconcile before manual removal.",
      { lockCleanupFailed: true, lockPath: createPath + ".lock" },
      result ?? original?.result,
    );
  }
  if (failureOutcome) {
    throw failureOutcome;
  }
  return result!;
}
