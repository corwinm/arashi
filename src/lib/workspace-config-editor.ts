import {
  normalizeConfig,
  type Config,
  type InlineHookInterpreterMap,
  type InlineHookLifecycle,
} from "./config.ts";
import { resolveConfiguredBaseBranch } from "./base-branch-policy.ts";
import { DEFAULT_LIFECYCLE_HOOK_TIMEOUT, resolveLifecycleHookFilePath } from "./hooks.ts";
import {
  REPOSITORY_CONFIGURE_DESCRIPTORS,
  type RepositoryScriptPlan,
} from "./repository-config-editor.ts";
import { DEFAULT_WORKTREES_DIR } from "./worktree-location.ts";

export type ConfigureScope =
  | "workspace-settings"
  | "workspace-hooks"
  | "command-defaults"
  | "editor-defaults"
  | "meta-policy"
  | "repository";
export type ConfigureFieldId =
  | "reposDir"
  | "worktreesDir"
  | "baseBranch"
  | "sync.timeoutSeconds"
  | "hooks.timeout"
  | `hooks.scripts.${InlineHookLifecycle}`
  | "defaults.create.switch"
  | "defaults.create.launch"
  | "defaults.switch.mode"
  | `defaults.editors.${"vscode" | "cursor" | "kiro"}.create.${"switch" | "launch"}`
  | "meta.baseBranch";

export interface ConfigurationDescriptor {
  id: ConfigureFieldId;
  canonicalPath: ConfigureFieldId;
  scope: Exclude<ConfigureScope, "repository">;
  ownership: "workspace" | "workspace-hooks" | "command" | "editor" | "meta";
  acceptedShape: string;
  safeDisplay: "value" | "source-presence";
  clearable: boolean;
  purpose: string;
  validationAdapter: "canonical-config" | "canonical-config-and-active-path";
  effectiveResolver: "none" | "built-in" | "workspace-inheritance";
}

const descriptor = (
  id: ConfigureFieldId,
  scope: ConfigurationDescriptor["scope"],
  ownership: ConfigurationDescriptor["ownership"],
  acceptedShape: string,
  safeDisplay: ConfigurationDescriptor["safeDisplay"] = "value",
): ConfigurationDescriptor => ({
  acceptedShape,
  canonicalPath: id,
  clearable: id !== "reposDir",
  id,
  ownership,
  purpose: `Configure ${id}`,
  safeDisplay,
  scope,
  validationAdapter: acceptedShape.includes("native-file")
    ? "canonical-config-and-active-path"
    : "canonical-config",
  effectiveResolver:
    id === "meta.baseBranch"
      ? "workspace-inheritance"
      : id === "worktreesDir" ||
          id === "sync.timeoutSeconds" ||
          id === "hooks.timeout" ||
          id.endsWith(".create.switch") ||
          id.endsWith(".create.launch") ||
          id === "defaults.switch.mode"
        ? "built-in"
        : "none",
});
const lifecycles = ["pre-create", "post-create", "pre-remove", "post-remove"] as const;
const editors = ["vscode", "cursor", "kiro"] as const;

export const CONFIGURE_SCOPE_DESCRIPTORS: readonly ConfigurationDescriptor[] = Object.freeze([
  descriptor("reposDir", "workspace-settings", "workspace", "workspace-relative-path"),
  descriptor("worktreesDir", "workspace-settings", "workspace", "workspace-relative-path"),
  descriptor("baseBranch", "workspace-settings", "workspace", "git-branch"),
  descriptor(
    "sync.timeoutSeconds",
    "workspace-settings",
    "workspace",
    "non-negative-number-seconds",
  ),
  descriptor(
    "hooks.timeout",
    "workspace-hooks",
    "workspace-hooks",
    "positive-integer-milliseconds",
  ),
  ...lifecycles.map((lifecycle) =>
    descriptor(
      `hooks.scripts.${lifecycle}`,
      "workspace-hooks",
      "workspace-hooks",
      "inline-bash-or-interpreter-map-or-native-file",
      "source-presence",
    ),
  ),
  descriptor("defaults.create.switch", "command-defaults", "command", "boolean"),
  descriptor("defaults.create.launch", "command-defaults", "command", "create-launch-mode"),
  descriptor("defaults.switch.mode", "command-defaults", "command", "switch-mode"),
  ...editors.flatMap((editor) =>
    (["switch", "launch"] as const).map((field) =>
      descriptor(
        `defaults.editors.${editor}.create.${field}`,
        "editor-defaults",
        "editor",
        field === "switch" ? "boolean" : "create-launch-mode",
      ),
    ),
  ),
  descriptor("meta.baseBranch", "meta-policy", "meta", "git-branch"),
]);

export interface ConfigurationSession {
  readonly candidate: Config;
  readonly persisted: unknown;
  readonly scripts: readonly RepositoryScriptPlan[];
}
export const createConfigurationSession = (
  candidate: Config,
  persisted: unknown = candidate,
): ConfigurationSession => ({
  candidate: structuredClone(candidate),
  persisted: structuredClone(persisted),
  scripts: Object.freeze([]),
});

const getPath = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        typeof current === "object" && current !== null
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
const setPath = (config: Config, path: string, value: unknown): void => {
  const segments = path.split(".");
  let current = config as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
};
const persistedAliases = (path: ConfigureFieldId): readonly string[] => {
  if (path === "reposDir") return ["reposDir", "repos_dir"];
  if (path === "worktreesDir") return ["worktreesDir", "worktrees_dir"];
  if (path === "sync.timeoutSeconds") return ["sync.timeoutSeconds", "sync.timeout_seconds"];
  if (path === "defaults.create.launch")
    return ["defaults.create.launch", "defaults.create.launchMode", "defaults.create.launch_mode"];
  if (path === "defaults.switch.mode")
    return ["defaults.switch.mode", "defaults.switch.launchMode", "defaults.switch.launch_mode"];
  if (path.includes(".create.launch"))
    return [path, path.replace(".launch", ".launchMode"), path.replace(".launch", ".launch_mode")];
  return [path];
};
const clonePersistedRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : {};
const updatePersistedProjection = (
  persisted: unknown,
  id: ConfigureFieldId,
  action: ConfigurationAction,
): unknown => {
  if (action.action === "keep") return structuredClone(persisted);
  const projection = clonePersistedRecord(persisted);
  for (const path of persistedAliases(id)) clearPath(projection as unknown as Config, path);
  if (action.action === "edit") setPath(projection as unknown as Config, id, action.value);
  return projection;
};
const clearPath = (config: Config, path: string): void => {
  const segments = path.split(".");
  const parents: Record<string, unknown>[] = [];
  let current = config as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) return;
    parents.push(current);
    current = child as Record<string, unknown>;
  }
  delete current[segments.at(-1)!];
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (Object.keys(current).length > 0) break;
    const parent = parents[index]!;
    delete parent[segments[index]!];
    current = parent;
  }
};

export type ConfigurationAction =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "edit"; value: unknown };
export const applyConfigurationAction = (
  session: ConfigurationSession,
  id: ConfigureFieldId,
  action: ConfigurationAction,
): ConfigurationSession => {
  const descriptor = CONFIGURE_SCOPE_DESCRIPTORS.find((entry) => entry.id === id);
  if (!descriptor) throw new Error(`Unsupported configuration field: ${id}`);
  const candidate = structuredClone(session.candidate);
  if (action.action === "clear") {
    if (!descriptor.clearable) throw new Error(`Required setting ${id} cannot be cleared.`);
    clearPath(candidate, id);
  } else if (action.action === "edit") setPath(candidate, id, action.value);
  const clearedLifecycle =
    action.action === "clear" && id.startsWith("hooks.scripts.")
      ? (id.slice("hooks.scripts.".length) as InlineHookLifecycle)
      : undefined;
  const normalizedCandidate = normalizeConfig(candidate);
  if (id !== "worktreesDir" && session.candidate.worktreesDir === undefined)
    delete normalizedCandidate.worktreesDir;
  if (id === "worktreesDir" && action.action === "clear") delete normalizedCandidate.worktreesDir;
  return {
    candidate: normalizedCandidate,
    persisted: updatePersistedProjection(session.persisted, id, action),
    scripts: Object.freeze(
      clearedLifecycle
        ? session.scripts.filter(
            ({ lifecycle, repositoryName }) =>
              repositoryName !== undefined || lifecycle !== clearedLifecycle,
          )
        : [...session.scripts],
    ),
  };
};

const hookPresence = (value: unknown, lifecycle: InlineHookLifecycle) => ({
  interpreters:
    typeof value === "string"
      ? ["bash"]
      : Object.keys((value ?? {}) as Record<string, unknown>).toSorted(),
  lifecycle,
  sourceKind: "inline-config" as const,
});
export const inspectConfiguration = (
  candidate: Config,
  repositoryName?: string,
  persisted: unknown = candidate,
  nativeSources: readonly {
    lifecycle: InlineHookLifecycle;
    ownerName?: string;
    scope: "workspace" | "repository";
    sourceKind: "file";
  }[] = [],
) => {
  const settings = CONFIGURE_SCOPE_DESCRIPTORS.map((entry) => {
    const persistedPath = persistedAliases(entry.canonicalPath).find(
      (path) => getPath(persisted, path) !== undefined,
    );
    const configuredValue = persistedPath ? getPath(candidate, entry.canonicalPath) : undefined;
    let effective: { source: "built-in" | "inherited"; value: unknown } | undefined;
    if (configuredValue === undefined) {
      if (entry.id === "worktreesDir")
        effective = { source: "built-in", value: DEFAULT_WORKTREES_DIR };
      if (entry.id === "sync.timeoutSeconds") effective = { source: "built-in", value: 300 };
      if (entry.id === "hooks.timeout")
        effective = { source: "built-in", value: DEFAULT_LIFECYCLE_HOOK_TIMEOUT };
      if (entry.id.endsWith(".create.switch")) effective = { source: "built-in", value: false };
      if (entry.id.endsWith(".create.launch")) effective = { source: "built-in", value: "none" };
      if (entry.id === "defaults.switch.mode") effective = { source: "built-in", value: "launch" };
      if (entry.id === "meta.baseBranch" && candidate.baseBranch)
        effective = { source: "inherited", value: candidate.baseBranch };
    }
    return {
      canonicalPath: entry.canonicalPath,
      configured: configuredValue !== undefined,
      ...(configuredValue === undefined
        ? {}
        : {
            configuredValue:
              entry.safeDisplay === "source-presence"
                ? hookPresence(
                    configuredValue,
                    entry.id.slice("hooks.scripts.".length) as InlineHookLifecycle,
                  )
                : configuredValue,
          }),
      descriptor: structuredClone(entry),
      ...(effective ? { effective } : {}),
      id: entry.id,
      ...(persistedPath ? { persistedPath } : {}),
      scope: entry.scope,
      ...(entry.id.startsWith("hooks.scripts.")
        ? {
            nativeSource: nativeSources.find(
              (source) =>
                source.scope === "workspace" &&
                source.lifecycle === entry.id.slice("hooks.scripts.".length),
            ),
          }
        : {}),
    };
  });
  const persistedRepositories =
    getPath(persisted, "repos") ??
    getPath(persisted, "discoveredRepos") ??
    getPath(persisted, "discovered_repos");
  const repositories = Object.entries(candidate.repos).map(([name, repo]) => ({
    canonicalPath: `repos.${name}`,
    name,
    settings: REPOSITORY_CONFIGURE_DESCRIPTORS.map((entry) => {
      const value =
        entry.id === "pre-create" ||
        entry.id === "post-create" ||
        entry.id === "pre-remove" ||
        entry.id === "post-remove"
          ? repo.hooks?.[entry.id]
          : repo[entry.id];
      const persistedRepo =
        typeof persistedRepositories === "object" && persistedRepositories !== null
          ? (persistedRepositories as Record<string, unknown>)[name]
          : undefined;
      const persistedValue =
        entry.id === "pre-create" ||
        entry.id === "post-create" ||
        entry.id === "pre-remove" ||
        entry.id === "post-remove"
          ? getPath(persistedRepo, `hooks.${entry.id}`)
          : getPath(persistedRepo, entry.id);
      const base =
        entry.id === "baseBranch" && value === undefined
          ? resolveConfiguredBaseBranch(candidate, {
              configName: name,
              identity: name,
              kind: "child",
              repositoryName: name,
            })
          : undefined;
      return {
        canonicalPath: entry.canonicalPath.replace("<name>", name),
        configured: persistedValue !== undefined,
        ...(persistedValue === undefined
          ? {}
          : {
              configuredValue: entry.sensitive
                ? hookPresence(value, entry.id as InlineHookLifecycle)
                : structuredClone(value),
            }),
        descriptor: structuredClone(entry),
        ...(base?.source === "workspace-config"
          ? { effective: { source: "inherited" as const, value: base.requestedBranch } }
          : {}),
        id: entry.id,
        ...(entry.action === "inline-or-file"
          ? {
              nativeSource: nativeSources.find(
                (source) =>
                  source.scope === "repository" &&
                  source.ownerName === name &&
                  source.lifecycle === entry.id,
              ),
            }
          : {}),
      };
    }),
  }));
  return {
    repositories: repositoryName
      ? repositories.filter(({ name }) => name === repositoryName)
      : repositories,
    scopes: [
      "workspace-settings",
      "workspace-hooks",
      "command-defaults",
      "editor-defaults",
      "meta-policy",
      "repository",
    ] as const,
    settings,
    nativeSources: structuredClone(nativeSources),
  };
};

export const setWorkspaceInlineHook = (
  session: ConfigurationSession,
  lifecycle: InlineHookLifecycle,
  value: string | InlineHookInterpreterMap,
): ConfigurationSession => {
  const candidate = structuredClone(session.candidate);
  candidate.hooks ??= {};
  const normalizedValue =
    typeof value !== "string" && Object.keys(value).length === 1 && value.bash !== undefined
      ? value.bash
      : value;
  candidate.hooks.scripts = { ...candidate.hooks.scripts, [lifecycle]: normalizedValue };
  const normalizedCandidate = normalizeConfig(candidate);
  if (session.candidate.worktreesDir === undefined) delete normalizedCandidate.worktreesDir;
  return {
    candidate: normalizedCandidate,
    persisted: updatePersistedProjection(session.persisted, `hooks.scripts.${lifecycle}`, {
      action: "edit",
      value: normalizedValue,
    }),
    scripts: Object.freeze(
      session.scripts.filter(
        (plan) => plan.repositoryName !== undefined || plan.lifecycle !== lifecycle,
      ),
    ),
  };
};

export const planWorkspaceHookFile = (
  session: ConfigurationSession,
  lifecycle: InlineHookLifecycle,
  context: { activeConfigRoot: string; platform?: NodeJS.Platform },
): ConfigurationSession => {
  const platform = context.platform ?? process.platform;
  const candidate = structuredClone(session.candidate);
  if (candidate.hooks?.scripts) {
    delete candidate.hooks.scripts[lifecycle];
    if (Object.keys(candidate.hooks.scripts).length === 0) delete candidate.hooks.scripts;
    if (Object.keys(candidate.hooks).length === 0) delete candidate.hooks;
  }
  const normalizedCandidate = normalizeConfig(candidate);
  if (session.candidate.worktreesDir === undefined) delete normalizedCandidate.worktreesDir;
  return {
    candidate: normalizedCandidate,
    persisted: updatePersistedProjection(session.persisted, `hooks.scripts.${lifecycle}`, {
      action: "clear",
    }),
    scripts: Object.freeze([
      ...session.scripts.filter(
        (plan) => plan.repositoryName !== undefined || plan.lifecycle !== lifecycle,
      ),
      {
        extension: platform === "win32" ? ".ps1" : ".sh",
        lifecycle,
        mode: platform === "win32" ? null : 0o755,
        ownerRoot: context.activeConfigRoot,
        path: resolveLifecycleHookFilePath({
          hookName: lifecycle,
          ownerRoot: context.activeConfigRoot,
          platform,
        }),
        state: "safe-no-op",
      },
    ]),
  };
};
