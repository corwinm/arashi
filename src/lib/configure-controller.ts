import { realpath } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { serializeConfig, type Config, type InlineHookLifecycle } from "./config.ts";
import { confirm, input, select, type Choice, type PromptOutcome } from "./prompts.ts";
import {
  CONFIGURE_SCOPE_DESCRIPTORS,
  applyConfigurationAction,
  createConfigurationSession,
  inspectConfiguration,
  planWorkspaceHookFile,
  setWorkspaceInlineHook,
  type ConfigurationDescriptor,
  type ConfigurationSession,
  type ConfigureScope,
} from "./workspace-config-editor.ts";
import {
  REPOSITORY_CONFIGURE_DESCRIPTORS,
  clearRepositoryField,
  createExistingRepositoryEditorState,
  normalizeRepositoryEditorState,
  planRepositoryHookFile,
  setRepositoryScalarField,
  validateRepositoryEditorState,
  type RepositoryActivePathObserver,
  type RepositoryEditorFieldId,
} from "./repository-config-editor.ts";
import {
  collectRepositoryInlineHook,
  collectRepositoryPaths,
  escapeRepositoryPathSuggestion,
} from "./repository-onboarding.ts";
import type { RepositoryCandidateDiscovery } from "./repository-candidate-discovery.ts";

export interface ConfigurePrompts {
  confirm(message: string, defaultValue?: boolean): Promise<PromptOutcome<boolean>>;
  input(message: string, defaultValue?: string): Promise<PromptOutcome<string>>;
  select<T>(message: string, choices: Choice<T>[]): Promise<PromptOutcome<T>>;
  showDiagnostic(message: string): void;
}
export const configurePrompts: ConfigurePrompts = {
  confirm,
  input,
  select,
  showDiagnostic: (message) => console.error(message),
};
const cancelled = <T>(outcome: PromptOutcome<T>) => outcome.status === "cancelled";
export const samePathIdentity = (
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  platform === "win32"
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : resolve(left) === resolve(right);
const scopeChoices: Choice<ConfigureScope>[] = [
  { name: "Workspace settings", value: "workspace-settings" },
  { name: "Workspace lifecycle hooks", value: "workspace-hooks" },
  { name: "Command defaults", value: "command-defaults" },
  { name: "Editor-specific defaults", value: "editor-defaults" },
  { name: "Meta-repository policy", value: "meta-policy" },
  { name: "Existing repository", value: "repository" },
];
const actionChoices = (clearable: boolean): Choice<"keep" | "edit" | "clear">[] => [
  { name: "Keep persisted value", value: "keep" },
  { name: "Edit / replace", value: "edit" },
  ...(clearable ? [{ name: "Clear canonical field", value: "clear" as const }] : []),
];
const bounded = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 240);
const safeValue = (value: unknown): string =>
  value === undefined ? "" : `; value ${JSON.stringify(value)}`;
const settingLabel = (setting: ReturnType<typeof inspectConfiguration>["settings"][number]) =>
  `${setting.canonicalPath} — ${setting.configured ? "Configured" : "Not configured"}${safeValue(setting.configuredValue)}${setting.effective ? `; Effective (${setting.effective.source}): ${JSON.stringify(setting.effective.value)}` : ""}`;

const parseValue = (descriptor: ConfigurationDescriptor, raw: string): unknown => {
  if (descriptor.acceptedShape === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error("Enter true or false.");
  }
  if (descriptor.id === "sync.timeoutSeconds") {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error("Enter a non-negative number.");
    return value;
  }
  if (descriptor.acceptedShape.includes("integer")) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Enter a positive integer.");
    return value;
  }
  return raw;
};

const editWorkspaceHook = async (
  session: ConfigurationSession,
  descriptor: ConfigurationDescriptor,
  activeConfigRoot: string,
  prompts: ConfigurePrompts,
  observeActivePaths?: RepositoryActivePathObserver,
): Promise<ConfigurationSession | { status: "cancelled"; reason: "exit" | "abort" }> => {
  const lifecycle = descriptor.id.slice("hooks.scripts.".length) as InlineHookLifecycle;
  for (;;) {
    const source = await prompts.select(`Choose source for ${lifecycle}:`, [
      { name: "Inline Bash command (visible plaintext)", value: "inline-bash" as const },
      { name: "Inline interpreter map (visible plaintext)", value: "inline-map" as const },
      { name: "Editable active file", value: "file" as const },
    ]);
    if (cancelled(source)) return source;
    if (source.value === "file") {
      let planned: ConfigurationSession;
      try {
        planned = planWorkspaceHookFile(session, lifecycle, { activeConfigRoot });
      } catch (error) {
        prompts.showDiagnostic(`${lifecycle}: ${bounded(error)}`);
        continue;
      }
      if (observeActivePaths) {
        const plan = planned.scripts.find(
          (entry) => entry.lifecycle === lifecycle && entry.repositoryName === undefined,
        )!;
        const observations = await observeActivePaths({
          lifecycles: [{ inlineConfigured: false, lifecycle, plannedPath: plan.path }],
          repositoryName: "@workspace",
        });
        if (
          observations.some(
            ({ destinationExists, nativeCandidateCount, symlinkParent, unsafeDestination }) =>
              destinationExists ||
              (nativeCandidateCount ?? 0) > 0 ||
              symlinkParent ||
              unsafeDestination,
          )
        ) {
          const disposition = await prompts.select(
            "Existing active hook detected; keep existing / skip or retry:",
            [
              { name: "Keep existing file and skip this change", value: "keep-existing" as const },
              { name: "Retry this workspace hook", value: "retry" as const },
            ],
          );
          if (cancelled(disposition)) return disposition;
          if (disposition.value === "keep-existing") return session;
          continue;
        }
      }
      return planned;
    }
    const values: Record<string, string> = {};
    const interpreters =
      source.value === "inline-bash"
        ? (["bash"] as const)
        : (["bash", "powershell", "cmd"] as const);
    for (const interpreter of interpreters) {
      const answer = await prompts.input(
        `Enter ${interpreter} command for ${lifecycle}${source.value === "inline-map" ? " (blank to omit)" : ""}; stored as visible plaintext:`,
      );
      if (cancelled(answer)) return answer;
      if (answer.value.trim()) values[interpreter] = answer.value;
    }
    if (Object.keys(values).length === 0) {
      prompts.showDiagnostic(`${lifecycle}: at least one inline command is required.`);
      continue;
    }
    return setWorkspaceInlineHook(session, lifecycle, values);
  }
};

const hasNativeState = (
  observations: readonly {
    destinationExists?: boolean;
    nativeCandidateCount?: number;
  }[],
): boolean =>
  observations.some(
    ({ destinationExists, nativeCandidateCount }) =>
      destinationExists || (nativeCandidateCount ?? 0) > 0,
  );

const editRepository = async (
  session: ConfigurationSession,
  repositoryName: string,
  activeConfigRoot: string,
  executionRoot: string,
  prompts: ConfigurePrompts,
  observeActivePaths?: RepositoryActivePathObserver,
  discoverCandidates?: (root: string) => Promise<RepositoryCandidateDiscovery>,
  rootRepository = false,
): Promise<ConfigurationSession | { status: "cancelled"; reason: "exit" | "abort" }> => {
  const inspection = inspectConfiguration(session.candidate, repositoryName, session.persisted)
    .repositories[0]!;
  const setting = await prompts.select(
    `Choose setting in ${inspection.canonicalPath} (path and gitUrl are identity-only):`,
    inspection.settings.map((entry) => ({
      name: `${entry.canonicalPath} — ${entry.configured ? "Configured" : "Not configured"}${safeValue(entry.configuredValue)}${entry.effective ? `; Effective (${entry.effective.source}): ${JSON.stringify(entry.effective.value)}` : ""}`,
      value: entry.id,
    })),
  );
  if (cancelled(setting)) return setting;
  let editor = createExistingRepositoryEditorState(
    session.candidate,
    repositoryName,
    session.scripts.filter((plan) => plan.repositoryName === repositoryName),
  );
  const descriptor = REPOSITORY_CONFIGURE_DESCRIPTORS.find(({ id }) => id === setting.value)!;
  const lifecycleSelected = descriptor.action === "inline-or-file";
  if (lifecycleSelected && observeActivePaths) {
    const lifecycle = setting.value as InlineHookLifecycle;
    const observations = await observeActivePaths({
      lifecycles: [
        {
          inlineConfigured:
            session.candidate.repos[repositoryName].hooks?.[lifecycle] !== undefined,
          lifecycle,
          plannedPath:
            session.scripts.find(
              (plan) => plan.repositoryName === repositoryName && plan.lifecycle === lifecycle,
            )?.path ?? null,
        },
      ],
      repositoryName,
    });
    if (hasNativeState(observations)) {
      const disposition = await prompts.select(
        `Native active hook configured for ${descriptor.canonicalPath.replace("<name>", repositoryName)}; choose keep/skip:`,
        [{ name: "Keep existing active hook / skip", value: "keep-existing" as const }],
      );
      if (cancelled(disposition)) return disposition;
      return session;
    }
  }
  const action = await prompts.select(
    `Choose action for ${descriptor.canonicalPath.replace("<name>", repositoryName)}:`,
    actionChoices(true),
  );
  if (cancelled(action)) return action;
  if (action.value === "clear")
    editor = clearRepositoryField(editor, setting.value as RepositoryEditorFieldId);
  if (action.value === "edit") {
    if (setting.value === "groups" || setting.value === "baseBranch") {
      for (;;) {
        const answer = await prompts.input(
          setting.value === "groups" ? "Enter comma-separated groups:" : "Enter base branch:",
        );
        if (cancelled(answer)) return answer;
        const trial = setRepositoryScalarField(
          editor,
          setting.value,
          setting.value === "groups"
            ? answer.value
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : answer.value,
        );
        const checked = normalizeRepositoryEditorState(trial);
        if (checked.ok) {
          editor = checked.state;
          break;
        }
        prompts.showDiagnostic(
          bounded(checked.diagnostics[0]?.message ?? "Invalid repository configuration."),
        );
      }
    } else if (setting.value === "copy" || setting.value === "symlink") {
      const discovery = discoverCandidates
        ? await discoverCandidates(
            resolve(executionRoot, session.candidate.repos[repositoryName].path),
          )
        : { candidates: [], inspectedEntries: 0 };
      if (discovery.diagnostic) prompts.showDiagnostic(bounded(discovery.diagnostic));
      const suggestions = discovery.candidates
        .map(({ path }) => escapeRepositoryPathSuggestion(path))
        .join(", ");
      const collected = await collectRepositoryPaths(editor, setting.value, suggestions, prompts);
      if ("status" in collected) return collected;
      editor = collected;
    } else {
      const lifecycle = setting.value as InlineHookLifecycle;
      for (;;) {
        const source = await prompts.select(`Choose source for ${lifecycle}:`, [
          { name: "Inline Bash command (visible plaintext)", value: "inline-bash" as const },
          { name: "Inline interpreter map (visible plaintext)", value: "inline-map" as const },
          ...(rootRepository && (lifecycle === "pre-remove" || lifecycle === "post-remove")
            ? []
            : [{ name: "Editable active file", value: "file" as const }]),
        ]);
        if (cancelled(source)) return source;
        let trial;
        if (source.value === "file") {
          try {
            trial = planRepositoryHookFile(editor, lifecycle, {
              activeConfigRoot,
              activeRepositoryPath: resolve(
                executionRoot,
                session.candidate.repos[repositoryName].path,
              ),
            });
          } catch (error) {
            prompts.showDiagnostic(`${lifecycle}: ${bounded(error)}`);
            continue;
          }
        } else {
          const collected = await collectRepositoryInlineHook(
            editor,
            lifecycle,
            source.value,
            prompts,
          );
          if ("status" in collected) return collected;
          trial = collected;
        }
        const normalized = observeActivePaths
          ? await validateRepositoryEditorState(trial, async (request) => {
              const selectedRequest = {
                ...request,
                lifecycles: request.lifecycles.filter((entry) => entry.lifecycle === lifecycle),
              };
              return observeActivePaths(selectedRequest);
            })
          : normalizeRepositoryEditorState(trial);
        if (normalized.ok) {
          editor = normalized.state;
          break;
        }
        for (const diagnostic of normalized.diagnostics
          .filter(({ field }) => field === lifecycle)
          .slice(0, 3))
          prompts.showDiagnostic(`${lifecycle}: ${bounded(diagnostic.message)}`);
        const disposition = await prompts.select(
          `Active hook state changed for ${lifecycle}; keep/skip or retry:`,
          [
            { name: "Keep existing active hook / skip", value: "keep-existing" as const },
            { name: "Retry this repository hook", value: "retry" as const },
          ],
        );
        if (cancelled(disposition)) return disposition;
        if (disposition.value === "keep-existing") return session;
      }
    }
  }
  const normalized = normalizeRepositoryEditorState(editor);
  if (!normalized.ok) {
    for (const diagnostic of normalized.diagnostics.slice(0, 3))
      prompts.showDiagnostic(`${diagnostic.field}: ${bounded(diagnostic.message)}`);
    return editRepository(
      session,
      repositoryName,
      activeConfigRoot,
      executionRoot,
      prompts,
      observeActivePaths,
      discoverCandidates,
      rootRepository,
    );
  }
  const candidate = normalized.state.candidate;
  if (session.candidate.worktreesDir === undefined) delete candidate.worktreesDir;
  return {
    candidate,
    persisted: action.value === "keep" ? session.persisted : structuredClone(candidate),
    scripts: Object.freeze([
      ...session.scripts.filter((plan) => plan.repositoryName !== repositoryName),
      ...normalized.state.scripts,
    ]),
  };
};

export const buildConfigurationPreview = (session: ConfigurationSession) => {
  const serialized = serializeConfig(session.candidate);
  const lines = ["Apply this workspace configuration?", "Exact configuration JSON:", serialized];
  if (session.scripts.length > 0) {
    lines.push(
      "Active files to create:",
      ...session.scripts.map(
        ({ lifecycle, path }) => `  • ${lifecycle}: ${path} (active safe no-op; runtime-ready)`,
      ),
    );
  }
  return { message: lines.join("\n"), serialized };
};

export type ConfigureControllerResult =
  | { status: "confirmed"; session: ConfigurationSession; serialized: string }
  | { status: "declined" }
  | { status: "no-changes" }
  | { status: "cancelled"; reason: "exit" | "abort" };
export const collectConfigurationEdits = async (options: {
  activeConfigRoot: string;
  executionRoot?: string;
  config: Config;
  persisted?: unknown;
  originalSerialized?: string;
  prompts?: ConfigurePrompts;
  observeRepositoryActivePaths?: (context: {
    activeConfigRoot: string;
    activeRepositoryPath: string;
    repositoryName: string;
  }) => RepositoryActivePathObserver;
  observeWorkspaceActivePaths?: RepositoryActivePathObserver;
  discoverRepositoryCandidates?: (root: string) => Promise<RepositoryCandidateDiscovery>;
  resolvePathIdentity?: (path: string) => Promise<string>;
}): Promise<ConfigureControllerResult> => {
  const prompts = options.prompts ?? configurePrompts;
  const executionRoot = options.executionRoot ?? options.activeConfigRoot;
  const resolvePathIdentity =
    options.resolvePathIdentity ?? ((path: string) => realpath(path).catch(() => resolve(path)));
  const configurationRootIdentity = await resolvePathIdentity(options.activeConfigRoot);
  let session = createConfigurationSession(options.config, options.persisted ?? options.config);
  const initialSerialized = serializeConfig(session.candidate);
  for (;;) {
    try {
      const scope = await prompts.select("Choose configuration scope:", scopeChoices);
      if (cancelled(scope)) return scope;
      if (scope.value === "repository") {
        const repository = await prompts.select(
          "Choose configured repository:",
          Object.keys(session.candidate.repos)
            .toSorted()
            .map((name) => ({ name: `${name} — repos.${name}`, value: name })),
        );
        if (cancelled(repository)) return repository;
        const configuredRepositoryPath = resolve(
          options.activeConfigRoot,
          session.candidate.repos[repository.value].path,
        );
        const rootRepository = samePathIdentity(
          await resolvePathIdentity(configuredRepositoryPath),
          configurationRootIdentity,
        );
        const result = await editRepository(
          session,
          repository.value,
          options.activeConfigRoot,
          executionRoot,
          prompts,
          options.observeRepositoryActivePaths?.({
            activeConfigRoot: options.activeConfigRoot,
            activeRepositoryPath: resolve(
              executionRoot,
              session.candidate.repos[repository.value].path,
            ),
            repositoryName: repository.value,
          }),
          options.discoverRepositoryCandidates,
          rootRepository,
        );
        if ("status" in result) return result;
        session = result;
      } else {
        const inspection = inspectConfiguration(session.candidate, undefined, session.persisted);
        const available = inspection.settings.filter((setting) => setting.scope === scope.value);
        const selected = await prompts.select(
          `Choose setting in ${scope.value}:`,
          available.map((setting) => ({ name: settingLabel(setting), value: setting.id })),
        );
        if (cancelled(selected)) return selected;
        const descriptor = CONFIGURE_SCOPE_DESCRIPTORS.find(({ id }) => id === selected.value)!;
        const lifecycle = descriptor.id.startsWith("hooks.scripts.")
          ? (descriptor.id.slice("hooks.scripts.".length) as InlineHookLifecycle)
          : undefined;
        let nativeExists = false;
        if (lifecycle && options.observeWorkspaceActivePaths) {
          const observations = await options.observeWorkspaceActivePaths({
            lifecycles: [
              {
                inlineConfigured: session.candidate.hooks?.scripts?.[lifecycle] !== undefined,
                lifecycle,
                plannedPath:
                  session.scripts.find(
                    (plan) => plan.repositoryName === undefined && plan.lifecycle === lifecycle,
                  )?.path ?? null,
              },
            ],
            repositoryName: "@workspace",
          });
          nativeExists = hasNativeState(observations);
        }
        if (nativeExists) {
          const disposition = await prompts.select(
            `Native active hook configured for ${lifecycle}; choose keep/skip:`,
            [{ name: "Keep existing active hook / skip", value: "keep-existing" as const }],
          );
          if (cancelled(disposition)) return disposition;
        } else {
          const action = await prompts.select(
            `Choose action for ${descriptor.canonicalPath}:`,
            actionChoices(descriptor.clearable),
          );
          if (cancelled(action)) return action;
          if (action.value === "clear" || action.value === "keep")
            session = applyConfigurationAction(session, descriptor.id, { action: action.value });
          else if (lifecycle) {
            const result = await editWorkspaceHook(
              session,
              descriptor,
              options.activeConfigRoot,
              prompts,
              options.observeWorkspaceActivePaths,
            );
            if ("status" in result) return result;
            session = result;
          } else {
            for (;;) {
              const answer = await prompts.input(`Enter value for ${descriptor.canonicalPath}:`);
              if (cancelled(answer)) return answer;
              try {
                session = applyConfigurationAction(session, descriptor.id, {
                  action: "edit",
                  value: parseValue(descriptor, answer.value),
                });
                break;
              } catch (error) {
                prompts.showDiagnostic(bounded(error));
              }
            }
          }
        }
      }
    } catch (error) {
      prompts.showDiagnostic(bounded(error));
      continue;
    }
    const another = await prompts.confirm("Edit another setting?", false);
    if (cancelled(another)) return another;
    if (!another.value) break;
  }
  if (serializeConfig(session.candidate) === initialSerialized && session.scripts.length === 0)
    return { status: "no-changes" };
  const preview = buildConfigurationPreview(session);
  const confirmed = await prompts.confirm(preview.message, false);
  if (cancelled(confirmed)) return confirmed;
  return confirmed.value
    ? { serialized: preview.serialized, session, status: "confirmed" }
    : { status: "declined" };
};
