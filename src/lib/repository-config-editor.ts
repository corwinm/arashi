import {
  normalizeConfig,
  type Config,
  type InlineHookInterpreterMap,
  type InlineHookLifecycle,
  type RepoConfig,
} from "./config.ts";
import { resolveLifecycleHookFilePath } from "./hooks.ts";

const isSafeRepositoryHookNameSegment = (
  repositoryName: string,
  platform: NodeJS.Platform,
): boolean => {
  if (repositoryName === "." || repositoryName === ".." || repositoryName.length === 0) {
    return false;
  }
  if (platform === "win32") {
    const windowsForbidden = '<>:"/\\|?*';
    return ![...repositoryName].some(
      (character) => windowsForbidden.includes(character) || character.charCodeAt(0) <= 0x1f,
    );
  }
  return !repositoryName.includes("/") && !repositoryName.includes("\0");
};

export type RepositoryEditorFieldId = "copy" | "symlink" | InlineHookLifecycle;
export interface RepositoryFieldDescriptor {
  id: RepositoryEditorFieldId;
  scope: "repository";
  action: "config" | "inline-or-file";
  canonicalPath: string;
  label: string;
  sensitive: boolean;
  acceptedShape:
    | "repository-relative-string-array"
    | "inline-bash-or-interpreter-map-or-native-file";
  ownership: "repository";
  precedence: "explicit-editor";
  projection: "paths" | "source-presence";
  validation: "canonical-config" | "canonical-config-and-active-path";
}

export const REPOSITORY_ONBOARDING_DESCRIPTORS: readonly RepositoryFieldDescriptor[] =
  Object.freeze([
    {
      action: "config",
      canonicalPath: "repos.<name>.copy",
      id: "copy",
      label: "Copy paths",
      scope: "repository",
      sensitive: false,
      acceptedShape: "repository-relative-string-array",
      ownership: "repository",
      precedence: "explicit-editor",
      projection: "paths",
      validation: "canonical-config",
    },
    {
      action: "config",
      canonicalPath: "repos.<name>.symlink",
      id: "symlink",
      label: "Symlink paths",
      scope: "repository",
      sensitive: false,
      acceptedShape: "repository-relative-string-array",
      ownership: "repository",
      precedence: "explicit-editor",
      projection: "paths",
      validation: "canonical-config",
    },
    ...(["pre-create", "post-create", "pre-remove", "post-remove"] as const).map((id) => ({
      action: "inline-or-file" as const,
      canonicalPath: `repos.<name>.hooks.${id}`,
      id,
      label: id,
      scope: "repository" as const,
      sensitive: true,
      acceptedShape: "inline-bash-or-interpreter-map-or-native-file" as const,
      ownership: "repository" as const,
      precedence: "explicit-editor" as const,
      projection: "source-presence" as const,
      validation: "canonical-config-and-active-path" as const,
    })),
  ]);

export interface RepositoryScriptPlan {
  readonly lifecycle: InlineHookLifecycle;
  readonly ownerRoot: string;
  readonly path: string;
  readonly extension: ".sh" | ".ps1";
  readonly mode: number | null;
  readonly state: "safe-no-op";
}
export interface RepositoryEditorState {
  readonly candidate: Config;
  readonly repositoryName: string;
  readonly fields: readonly (RepositoryFieldDescriptor & { state: "configured" | "unset" })[];
  readonly scripts: readonly RepositoryScriptPlan[];
  readonly warnings: readonly string[];
}
export interface EditorDiagnostic {
  field: RepositoryEditorFieldId;
  message: string;
  retryable: true;
}
export interface RepositoryActivePathObservation {
  lifecycle: InlineHookLifecycle;
  destinationExists?: boolean;
  symlinkParent?: boolean;
  unsafeDestination?: boolean;
  nativeCandidateCount?: number;
}
export interface RepositoryActivePathValidationRequest {
  readonly repositoryName: string;
  readonly lifecycles: readonly {
    readonly lifecycle: InlineHookLifecycle;
    readonly inlineConfigured: boolean;
    readonly plannedPath: string | null;
  }[];
}
export type RepositoryActivePathObserver = (
  request: RepositoryActivePathValidationRequest,
) => Promise<readonly RepositoryActivePathObservation[]>;

const clone = <T>(value: T): T => structuredClone(value);
const fieldConfigured = (repo: RepoConfig, id: RepositoryEditorFieldId): boolean =>
  id === "copy" || id === "symlink" ? repo[id] !== undefined : repo.hooks?.[id] !== undefined;
const rebuildFields = (state: Omit<RepositoryEditorState, "fields">): RepositoryEditorState => ({
  ...state,
  fields: REPOSITORY_ONBOARDING_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    state:
      fieldConfigured(state.candidate.repos[state.repositoryName], descriptor.id) ||
      state.scripts.some(({ lifecycle }) => lifecycle === descriptor.id)
        ? "configured"
        : "unset",
  })),
});

export const createRepositoryEditorState = (
  candidate: Config,
  repositoryName: string,
): RepositoryEditorState => {
  if (!candidate.repos[repositoryName]) {
    throw new Error(`Unknown repository '${repositoryName}'.`);
  }
  return rebuildFields({
    candidate: clone(candidate),
    repositoryName,
    scripts: Object.freeze([]),
    warnings: Object.freeze([]),
  });
};

export const setRepositoryPaths = (
  state: RepositoryEditorState,
  field: "copy" | "symlink",
  paths: readonly string[],
): RepositoryEditorState => {
  const candidate = clone(state.candidate);
  candidate.repos[state.repositoryName][field] = [...paths];
  const warnings = paths.some((path) => /(^|[/\\])node_modules([/\\]|$)/i.test(path))
    ? [
        ...state.warnings,
        "Dependency directories such as node_modules may not be portable or safe to share.",
      ]
    : [...state.warnings];
  return rebuildFields({ ...state, candidate, scripts: state.scripts, warnings });
};

export const setRepositoryInlineHook = (
  state: RepositoryEditorState,
  lifecycle: InlineHookLifecycle,
  value: string | InlineHookInterpreterMap,
): RepositoryEditorState => {
  const candidate = clone(state.candidate);
  const repo = candidate.repos[state.repositoryName];
  repo.hooks = { ...repo.hooks, [lifecycle]: value };
  const scripts = state.scripts.filter((script) => script.lifecycle !== lifecycle);
  return rebuildFields({ ...state, candidate, scripts });
};

export interface RepositoryScriptContext {
  activeConfigRoot: string;
  activeRepositoryPath: string;
  platform?: NodeJS.Platform;
}
export const planRepositoryHookFile = (
  state: RepositoryEditorState,
  lifecycle: InlineHookLifecycle,
  context: RepositoryScriptContext,
): RepositoryEditorState => {
  const platform = context.platform ?? process.platform;
  const extension: ".ps1" | ".sh" = platform === "win32" ? ".ps1" : ".sh";
  const create = lifecycle === "pre-create" || lifecycle === "post-create";
  if (create && !isSafeRepositoryHookNameSegment(state.repositoryName, platform)) {
    throw new Error("Repository name cannot be used in an active hook filename.");
  }
  const root = create ? context.activeConfigRoot : context.activeRepositoryPath;
  const path = resolveLifecycleHookFilePath({
    hookName: create ? `${lifecycle}.${state.repositoryName}` : lifecycle,
    ownerRoot: root,
    platform,
  });
  const candidate = clone(state.candidate);
  const hooks = { ...candidate.repos[state.repositoryName].hooks };
  delete hooks[lifecycle];
  candidate.repos[state.repositoryName].hooks = Object.keys(hooks).length > 0 ? hooks : undefined;
  const scripts = [
    ...state.scripts.filter((script) => script.lifecycle !== lifecycle),
    {
      extension,
      lifecycle,
      mode: platform === "win32" ? null : 0o755,
      ownerRoot: root,
      path,
      state: "safe-no-op" as const,
    },
  ];
  return rebuildFields({ ...state, candidate, scripts: Object.freeze(scripts) });
};

const diagnosticField = (message: string): RepositoryEditorFieldId => {
  const match = message.match(
    /\.(copy|symlink|pre-create|post-create|pre-remove|post-remove)(?:\[|:|\.)/,
  );
  return (match?.[1] as RepositoryEditorFieldId | undefined) ?? "copy";
};
export const normalizeRepositoryEditorState = (
  state: RepositoryEditorState,
): { ok: true; state: RepositoryEditorState } | { ok: false; diagnostics: EditorDiagnostic[] } => {
  try {
    const candidate = normalizeConfig(state.candidate);
    return {
      ok: true,
      state: rebuildFields({ ...state, candidate, scripts: Object.freeze([...state.scripts]) }),
    };
  } catch (error) {
    const messages = (error as Error).message
      .split("\n")
      .filter((line) => line.includes(`repos.${state.repositoryName}`));
    return {
      diagnostics: (messages.length > 0 ? messages : [(error as Error).message]).map((message) => ({
        field: diagnosticField(message),
        message,
        retryable: true,
      })),
      ok: false,
    };
  }
};

const lifecycleDiagnostic = (field: InlineHookLifecycle, message: string): EditorDiagnostic => ({
  field,
  message,
  retryable: true,
});

/**
 * Validate only canonical state and caller-supplied active-path metadata.
 * This boundary intentionally never opens source files or serializes hook bodies.
 */
export const validateRepositoryEditorState = async (
  state: RepositoryEditorState,
  observeActivePaths: RepositoryActivePathObserver,
): Promise<
  { ok: true; state: RepositoryEditorState } | { ok: false; diagnostics: EditorDiagnostic[] }
> => {
  const normalized = normalizeRepositoryEditorState(state);
  if (!normalized.ok) return normalized;

  const repoHooks = normalized.state.candidate.repos[normalized.state.repositoryName].hooks ?? {};
  const lifecycles = (["pre-create", "post-create", "pre-remove", "post-remove"] as const)
    .map((lifecycle) => ({
      inlineConfigured: repoHooks[lifecycle] !== undefined,
      lifecycle,
      plannedPath:
        normalized.state.scripts.find((script) => script.lifecycle === lifecycle)?.path ?? null,
    }))
    .filter(({ inlineConfigured, plannedPath }) => inlineConfigured || plannedPath !== null);
  const observations = await observeActivePaths({
    lifecycles: Object.freeze(lifecycles),
    repositoryName: normalized.state.repositoryName,
  });
  const diagnostics: EditorDiagnostic[] = [];
  for (const observation of observations) {
    const field = observation.lifecycle;
    const filePlanned = normalized.state.scripts.some(({ lifecycle }) => lifecycle === field);
    if (filePlanned) {
      if (observation.destinationExists) {
        diagnostics.push(lifecycleDiagnostic(field, "Active hook destination already exists."));
      }
      if (observation.symlinkParent) {
        diagnostics.push(lifecycleDiagnostic(field, "Active hook has a symlinked parent."));
      }
      if (observation.unsafeDestination) {
        diagnostics.push(lifecycleDiagnostic(field, "Active hook destination is unsafe."));
      }
    }
    const nativeCandidateCount = observation.nativeCandidateCount ?? 0;
    if (nativeCandidateCount > 1 || (nativeCandidateCount > 0 && filePlanned)) {
      diagnostics.push(lifecycleDiagnostic(field, "Ambiguous native hook candidates exist."));
    } else if (nativeCandidateCount > 0 && repoHooks[field] !== undefined) {
      diagnostics.push(lifecycleDiagnostic(field, "Inline and native hook sources are ambiguous."));
    }
  }
  return diagnostics.length > 0 ? { diagnostics, ok: false } : normalized;
};

export const summarizeRepositoryEditorState = (state: RepositoryEditorState) => {
  const repo = state.candidate.repos[state.repositoryName];
  const inline = Object.entries(repo.hooks ?? {}).map(([lifecycle, value]) => ({
    interpreters: typeof value === "string" ? ["bash"] : Object.keys(value as object),
    lifecycle,
    source: "inline" as const,
  }));
  const scripts = state.scripts.map(({ lifecycle, mode, path }) => ({
    executableReady: mode === null || mode === 0o755,
    lifecycle,
    path,
    safeNoOp: true,
    source: "file" as const,
  }));
  return {
    copy: repo.copy ?? [],
    hooks: [...inline, ...scripts],
    symlink: repo.symlink ?? [],
    warnings: [...state.warnings],
  };
};

export const repositoryNoOpScaffold = (extension: ".sh" | ".ps1"): Uint8Array =>
  new TextEncoder().encode(
    extension === ".ps1"
      ? "# Safe active Arashi lifecycle hook scaffold.\nexit 0\n"
      : "#!/usr/bin/env bash\n# Safe active Arashi lifecycle hook scaffold.\nexit 0\n",
  );
