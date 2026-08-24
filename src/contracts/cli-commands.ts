import type { Command, Option } from "commander";
import { discoverCommandPaths } from "../cli-program.ts";
import type { CompletionCandidateKind } from "../completion/types.ts";

export type JsonPolicy =
  | { support: "full" }
  | { support: "conditional" | "unsupported"; reason: string };
export type SurfacePolicy =
  | { expectation: "required" }
  | { expectation: "represented" | "excluded"; reason: string };
export type StandalonePolicy =
  | { support: "full" }
  | { support: "conditional" | "configured-only" | "not-applicable"; reason: string };
export interface ZeroConfigCommandPolicy {
  compatibleOptions: string[];
  dryRun: { finalState: "unchanged"; supported: true };
  incompatibleOptions: string[];
  json: { singleEnvelope: true; supported: true; suppressesHumanStdout: true };
  option: "--zero-config";
}
export interface ExplicitOptionPolicy {
  compatibleOptions: string[];
  conflicts: string[];
  dryRun?: { runtimeTargetEvidenceRequired: boolean; supported: true };
  environment?: { name: string; nonEmptyAfterTrim: boolean };
  implies: string[];
  json: {
    guardPrecedence: "before-option-validation";
    mode: string;
    unsupported: true;
  };
  launcherSupport?: {
    noFallback: true;
    supported: string[];
    unsupported: string[];
  };
  overrides?: string[];
  persisted: false;
}
export interface CommandSemanticMetadata {
  json: JsonPolicy;
  docs: SurfacePolicy;
  skills: SurfacePolicy;
  standalone: StandalonePolicy;
  vscode: SurfacePolicy;
  optionPolicies?: Record<string, ExplicitOptionPolicy>;
  zeroConfig?: ZeroConfigCommandPolicy;
  addMaterialization?: AddMaterializationPolicy;
  addOnboarding?: AddOnboardingPolicy;
  uninstall?: UninstallPolicy;
  configure?: ConfigurePolicy;
}
export interface UninstallPolicy {
  channelPolicy: "direct-manifest-only" | "exact-managed-shell-block" | "exactly-one-proven-owner";
  consent: { interactiveDefault: false; nonInteractiveRequiresYes: true };
  force: false;
  json: false;
  options: ["--dry-run", "--yes"];
  workspaceIndependent: true;
}

const uninstallPolicy = (channelPolicy: UninstallPolicy["channelPolicy"]): UninstallPolicy => ({
  channelPolicy,
  consent: { interactiveDefault: false, nonInteractiveRequiresYes: true },
  force: false,
  json: false,
  options: ["--dry-run", "--yes"],
  workspaceIndependent: true,
});
export interface ConfigurePolicy {
  descriptors: {
    workspace: string[];
    workspaceHooks: string[];
    commandDefaults: string[];
    editorDefaults: string[];
    meta: string[];
    repository: string[];
  };
  scopes: [
    "workspace-settings",
    "workspace-hooks",
    "command-defaults",
    "editor-defaults",
    "meta-policy",
    "repository",
  ];
  state: { persisted: ["configured", "not-configured"]; effective: ["inherited", "built-in"] };
  actions: ["keep", "edit", "clear"];
  invocation: { editing: "tty-stdin-and-stdout"; json: "sanitized-inspection-only" };
  loading: "exact-bytes-strict-no-migration-or-repair";
  noOp: "preserve-original-bytes-before-confirmation";
  preview: {
    config: "exact-serialized-json-including-inline-bodies";
    activeFiles: "separate-body-free-list";
  };
  transaction: {
    expectedBytes: true;
    configSavesAtMost: 1;
    activeFiles: "atomic-no-replace-with-owned-rollback";
    lock: "shared-workspace-add-configure-lock";
    nativeFiles: "metadata-only-observe-keep-skip-never-overwrite";
  };
  secrecy: {
    ordinaryAndJson: "lifecycle-and-interpreter-presence-only";
    inlineEntry: "visible-plaintext";
  };
}
export interface AddOnboardingPolicy {
  activeFiles: {
    createOwner: "active-config-root";
    removeOwner: "runtime-resolved-target-repository";
    safeNoOp: true;
    executableReady: true;
    noOverwrite: true;
  };
  cancellation: {
    finalDeclineAndInterrupt: "rollback";
    topLevelDecline: "minimal-success";
  };
  candidate: { isolatedUntilConfirmed: true; oneConfigSave: true };
  eligibility: {
    defaultNo: true;
    requires: ["stdin-tty", "stdout-tty"];
    suppresses: ["--json", "--force"];
  };
  fields: ["copy", "symlink", "pre-create", "post-create", "pre-remove", "post-remove"];
  hookSources: ["inline-bash", "inline-interpreter-map", "active-file"];
  inlineBashPersistence: "string-shorthand";
  output: {
    humanActiveFiles: "lifecycle-path-and-readiness-only";
    jsonActiveFiles: "excluded-because-json-suppresses-onboarding";
  };
  secrecy: {
    confirmationPreview: "resulting-repository-config-json";
    entry: "visible-plaintext";
    postConfirmation: "presence-and-path-state-only";
  };
  suggestions: {
    bounded: true;
    contentFree: true;
    promptRendering: "control-escaped";
    selectedByDefault: false;
    source: "root-metadata-and-ignore-rule-probes";
  };
  safety: {
    implementation: "pure-node-bun-metadata-and-atomic-no-replace";
    residualRace: "hostile-local-ancestor-substitution-between-final-validation-and-publication";
    rollbackResidualRace: "path-replacement-between-final-rollback-identity-check-and-unlink";
  };
  futureScope: "existing-entry-editing-reserved-for-316";
}
export interface AddMaterializationPolicy {
  activeConfigOwnership: true;
  canonicalCloneDefaultBranch: true;
  coordinatedBranch: "active-parent-branch";
  linkedMode: "git-topology";
  resultRoles: Array<
    | "path"
    | "materialization"
    | "canonicalPath"
    | "worktreePath"
    | "defaultBranch"
    | "coordinatedBranch"
    | "setupScript"
    | "setupScriptCreated"
  >;
}
export type CommandSemantics = Record<string, CommandSemanticMetadata>;

export type SwitchConfiguredModeEffect =
  | "automatic-launch"
  | "launch"
  | "preserve-configured-or-contextual-behavior"
  | "preserve-named-launcher";
export interface SwitchOptionSemanticPolicy {
  configuredModeEffects?: Record<
    "auto" | "cd" | "launch" | "sesh" | "herdr",
    SwitchConfiguredModeEffect
  >;
  explicitLauncher: { authoritative: true; compatible: true; noFallback: "preserved" };
  jsonGuardPrecedence: "before-option-and-conflict-validation";
  tab: { bypassesConfiguredDefaults: true; compatible: true; disposition: "tab" };
}
export interface SelectorOptionSemanticPolicy {
  accepts: ["repeated", "comma-separated", "mixed"];
  blankSegments: "ignored-beside-values";
  combination: {
    empty: "error";
    mode: "intersection";
    with: "--only" | "--group";
  };
  deduplicate: "first-occurrence";
  explicitEmpty: "error";
  flatten: "encounter-order";
  kind: "repository" | "group";
  omitted: "default-selection";
  standalone: "configured-only" | "unsupported";
  supplied: "distinct-from-omitted";
  trim: true;
  unknown: "error";
  validationPrecedence: "before-repository-work";
}
export interface CreateBaseOptionSemanticPolicy {
  environmentVariables: { ARASHI_BASE_BRANCH: "forbidden" };
  mutation: {
    executionStartPoint: "immutable-resolved-oid";
    preflight: "all-before-any";
    reusedTarget: {
      ancestry: "not-asserted-checked-or-derived";
      baseResolution: "required";
      mutation: "none";
    };
  };
  normalization: { originPrefix: "remove-at-most-one" };
  output: {
    humanDryRun: { baseResolution: true };
    json: {
      base: "optional";
      baseFields: ["requestedBranch", "source", "repositories"];
      failure: {
        attemptedRefs: ["refs/heads/<branch>", "refs/remotes/origin/<branch>"];
        code: "CREATE_BASE_RESOLUTION_FAILED";
        fields: ["requestedBranch", "source", "repositories"];
        ordering: "effective-selected-repository-order";
        repositories: "affected-only-selected-set";
        repositoryFields: [
          "repositoryIdentity",
          "repositoryName",
          "repositoryPath",
          "requestedBranch",
          "source",
          "attemptedRefs",
        ];
        repositoryPath: "canonical-absolute";
      };
      requestedBranch: "normalized-logical-branch";
      sources: ["repository-cli", "cli", "repository-config", "workspace-config"];
      success: {
        ordering: "effective-selected-repository-order";
        repositories: "complete-selected-set";
        repositoryFields: [
          "repositoryIdentity",
          "repositoryName",
          "repositoryPath",
          "requestedBranch",
          "source",
          "resolvedRef",
          "resolvedOid",
          "targetAction",
        ];
        repositoryPath: "canonical-absolute";
      };
      targetActions: ["created", "reused"];
    };
  };
  precedence: ["repository-cli", "cli", "repository-config", "workspace-config", "legacy-omitted"];
  resolution: {
    refs: ["refs/heads/<branch>", "refs/remotes/origin/<branch>"];
    repositories: "every-effective-selected-including-reused";
  };
  scope: {
    cli: "invocation-only";
    editorScopedDefault: "rejected";
    workspaceDefault: "baseBranch";
    workspaceDefaultScope: "shared-create-clone";
  };
  standalone: {
    cli: "invocation-only";
    omitted: "legacy-current-head";
    workspaceDefault: "ignored";
  };
}
export interface RepositoryBaseBranchSemanticPolicy {
  configuration: {
    workspace: "baseBranch";
    meta: "meta.baseBranch";
    child: "repos.<name>.baseBranch";
  };
  options: {
    global: "--base <branch>";
    repository: "--repo-base <repository=branch>";
    metaSelector: "@meta";
  };
  output: {
    cloneProperty: "base";
    createProperty: "base";
    fields: ["repositoryIdentity", "repositoryName", "requestedBranch", "source"];
    omitted: "all-legacy-omitted";
  };
  precedence: ["repository-cli", "cli", "repository-config", "workspace-config", "legacy-omitted"];
  sources: ["repository-cli", "cli", "repository-config", "workspace-config", "legacy-omitted"];
  scope: {
    create: "configured-and-standalone-global";
    clone: "configured-only";
    doctor: "configured-only";
    handoff: "configured-only";
    pull: "configured-only-with-upstream-fallback-when-absent";
    pushFallback: "configured-no-upstream-only";
    repositoryOverride: "configured-only";
    status: "configured-only";
  };
  clone: {
    ordinary: "checkout-effective-base";
    coordinated: "checkout-current-target-from-effective-base";
    omitted: "remote-default";
  };
  validation: "selected-set-before-mutation";
  rollback: "invocation-created-destinations-and-target-refs-only";
}
export interface OptionSemanticPolicy {
  ownership: "structural" | "command";
  compatibility?: {
    alternatives: string[];
    canonical: { option: string } | { behavior: string; omittedDefault: true };
    deprecatedAlternatives: true;
    removal: { earliestMajor: number; requiresApprovedBreakingChange: true };
  };
  conflicts?: string[];
  implies?: string[];
  inspection?: { executionPaths: Array<"human" | "json"> };
  hookInput?: {
    disabledMode: "disabled";
    immediateEof: true;
    jsonPrecedence: true;
    modes: ["tty", "disabled", "unavailable"];
    skipsHooks: false;
  };
  jsonExecution?: {
    apply: "unsupported";
    bare: "inspection-only";
    mutation: false;
    prompt: false;
  };
  persisted?: false;
  role?: "redundant-compatibility";
  repositoryBase?: RepositoryBaseBranchSemanticPolicy;
  selector?: SelectorOptionSemanticPolicy;
  switch?: SwitchOptionSemanticPolicy;
}
export type OptionAuditPolicies = Record<string, Record<string, OptionSemanticPolicy>>;

const switchLaunchInteractions: SwitchOptionSemanticPolicy = {
  explicitLauncher: { authoritative: true, compatible: true, noFallback: "preserved" },
  jsonGuardPrecedence: "before-option-and-conflict-validation",
  tab: { bypassesConfiguredDefaults: true, compatible: true, disposition: "tab" },
};
const explicitSwitchLaunchers = [
  "--cursor",
  "--herdr",
  "--kiro",
  "--sesh",
  "--tmux",
  "--vscode",
] as const;
const explicitLauncherConflicts = (option: (typeof explicitSwitchLaunchers)[number]): string[] => [
  "--cd",
  ...explicitSwitchLaunchers.filter((candidate) => candidate !== option),
];
const launchModeEffects: SwitchOptionSemanticPolicy["configuredModeEffects"] = {
  auto: "launch",
  cd: "launch",
  herdr: "preserve-named-launcher",
  launch: "launch",
  sesh: "preserve-named-launcher",
};
const ignoreConfiguredLauncherModeEffects: SwitchOptionSemanticPolicy["configuredModeEffects"] = {
  auto: "preserve-configured-or-contextual-behavior",
  cd: "preserve-configured-or-contextual-behavior",
  herdr: "automatic-launch",
  launch: "preserve-configured-or-contextual-behavior",
  sesh: "automatic-launch",
};
const launchClassPolicy = (
  conflicts: string[],
  configuredModeEffects?: SwitchOptionSemanticPolicy["configuredModeEffects"],
): OptionSemanticPolicy => ({
  conflicts,
  implies: ["launch"],
  ownership: "command",
  persisted: false,
  switch: { ...switchLaunchInteractions, configuredModeEffects },
});

const selectorPolicy = (
  kind: SelectorOptionSemanticPolicy["kind"],
  standalone: SelectorOptionSemanticPolicy["standalone"],
): OptionSemanticPolicy => ({
  ownership: "command",
  persisted: false,
  selector: {
    accepts: ["repeated", "comma-separated", "mixed"],
    blankSegments: "ignored-beside-values",
    combination: {
      empty: "error",
      mode: "intersection",
      with: kind === "repository" ? "--group" : "--only",
    },
    deduplicate: "first-occurrence",
    explicitEmpty: "error",
    flatten: "encounter-order",
    kind,
    omitted: "default-selection",
    standalone,
    supplied: "distinct-from-omitted",
    trim: true,
    unknown: "error",
    validationPrecedence: "before-repository-work",
  },
});
const selectorPolicies = (
  standalone: SelectorOptionSemanticPolicy["standalone"],
): Record<"--group" | "--only", OptionSemanticPolicy> => ({
  "--group": selectorPolicy("group", standalone),
  "--only": selectorPolicy("repository", standalone),
});

const hookInputPolicy: OptionSemanticPolicy = {
  hookInput: {
    disabledMode: "disabled",
    immediateEof: true,
    jsonPrecedence: true,
    modes: ["tty", "disabled", "unavailable"],
    skipsHooks: false,
  },
  ownership: "command",
  persisted: false,
};

export const repositoryBasePolicy: RepositoryBaseBranchSemanticPolicy = {
  configuration: {
    child: "repos.<name>.baseBranch",
    meta: "meta.baseBranch",
    workspace: "baseBranch",
  },
  options: {
    global: "--base <branch>",
    metaSelector: "@meta",
    repository: "--repo-base <repository=branch>",
  },
  output: {
    cloneProperty: "base",
    createProperty: "base",
    fields: ["repositoryIdentity", "repositoryName", "requestedBranch", "source"],
    omitted: "all-legacy-omitted",
  },
  precedence: ["repository-cli", "cli", "repository-config", "workspace-config", "legacy-omitted"],
  sources: ["repository-cli", "cli", "repository-config", "workspace-config", "legacy-omitted"],
  scope: {
    clone: "configured-only",
    create: "configured-and-standalone-global",
    doctor: "configured-only",
    handoff: "configured-only",
    pull: "configured-only-with-upstream-fallback-when-absent",
    pushFallback: "configured-no-upstream-only",
    repositoryOverride: "configured-only",
    status: "configured-only",
  },
  clone: {
    coordinated: "checkout-current-target-from-effective-base",
    omitted: "remote-default",
    ordinary: "checkout-effective-base",
  },
  validation: "selected-set-before-mutation",
  rollback: "invocation-created-destinations-and-target-refs-only",
};

export const optionAuditPolicies: OptionAuditPolicies = {
  create: {
    ...selectorPolicies("unsupported"),
    "--base": { ownership: "command", persisted: false, repositoryBase: repositoryBasePolicy },
    "--repo-base": { ownership: "command", persisted: false, repositoryBase: repositoryBasePolicy },
    "--no-hook-input": hookInputPolicy,
  },
  clone: {
    "--base": { ownership: "command", persisted: false, repositoryBase: repositoryBasePolicy },
    "--repo-base": { ownership: "command", persisted: false, repositoryBase: repositoryBasePolicy },
  },
  exec: selectorPolicies("configured-only"),
  handoff: {
    "--markdown": {
      compatibility: {
        alternatives: ["--markdown"],
        canonical: { behavior: "markdown", omittedDefault: true },
        deprecatedAlternatives: true,
        removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
      },
      ownership: "command",
      persisted: false,
      role: "redundant-compatibility",
    },
  },
  pull: selectorPolicies("configured-only"),
  push: selectorPolicies("configured-only"),
  remove: { "--no-hook-input": hookInputPolicy },
  setup: selectorPolicies("configured-only"),
  status: selectorPolicies("unsupported"),
  sync: selectorPolicies("configured-only"),
  update: {
    "--check": {
      conflicts: ["--dry-run"],
      inspection: { executionPaths: ["human", "json"] },
      ownership: "command",
    },
    "--dry-run": {
      conflicts: ["--check"],
      inspection: { executionPaths: ["human", "json"] },
      ownership: "command",
    },
    "--json": {
      jsonExecution: {
        apply: "unsupported",
        bare: "inspection-only",
        mutation: false,
        prompt: false,
      },
      ownership: "command",
    },
  },
  switch: {
    "--cd": {
      conflicts: [
        "--cursor",
        "--herdr",
        "--kiro",
        "--launch",
        "--no-cd",
        "--sesh",
        "--tab",
        "--tmux",
        "--vscode",
      ],
      implies: ["cd"],
      ownership: "command",
      persisted: false,
    },
    "--cursor": launchClassPolicy(explicitLauncherConflicts("--cursor")),
    "--herdr": launchClassPolicy(explicitLauncherConflicts("--herdr")),
    "--ignore-configured-launcher": {
      compatibility: {
        alternatives: ["--no-default-launch"],
        canonical: { option: "--ignore-configured-launcher" },
        deprecatedAlternatives: true,
        removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
      },
      conflicts: [],
      implies: [],
      ownership: "command",
      persisted: false,
      switch: {
        ...switchLaunchInteractions,
        configuredModeEffects: ignoreConfiguredLauncherModeEffects,
      },
    },
    "--kiro": launchClassPolicy(explicitLauncherConflicts("--kiro")),
    "--launch": {
      ...launchClassPolicy(["--cd"], launchModeEffects),
      compatibility: {
        alternatives: ["--no-cd"],
        canonical: { option: "--launch" },
        deprecatedAlternatives: true,
        removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
      },
    },
    "--no-cd": launchClassPolicy(["--cd"], launchModeEffects),
    "--no-default-launch": {
      conflicts: [],
      implies: [],
      ownership: "command",
      persisted: false,
      switch: {
        ...switchLaunchInteractions,
        configuredModeEffects: ignoreConfiguredLauncherModeEffects,
      },
    },
    "--sesh": launchClassPolicy(explicitLauncherConflicts("--sesh")),
    "--tab": launchClassPolicy(["--cd"]),
    "--tmux": launchClassPolicy(explicitLauncherConflicts("--tmux")),
    "--vscode": launchClassPolicy(explicitLauncherConflicts("--vscode")),
  },
};

const EXPLICIT_POLICY_KEYS = [
  "compatibleOptions",
  "conflicts",
  "dryRun",
  "environment",
  "implies",
  "json",
  "launcherSupport",
  "overrides",
  "persisted",
] as const;
const REQUIRED_EXPLICIT_POLICY_KEYS = [
  "compatibleOptions",
  "conflicts",
  "implies",
  "json",
  "persisted",
] as const;

const unsupported = (reason: string): JsonPolicy => ({ support: "unsupported", reason });
const required = (): SurfacePolicy => ({ expectation: "required" });
const excluded = (reason: string): SurfacePolicy => ({ expectation: "excluded", reason });
const represented = (reason: string): SurfacePolicy => ({ expectation: "represented", reason });
const standalone = (): StandalonePolicy => ({ support: "full" });
const configuredOnly = (reason: string): StandalonePolicy => ({
  support: "configured-only",
  reason,
});
const notApplicable = (reason: string): StandalonePolicy => ({ support: "not-applicable", reason });
const conditionalStandalone = (reason: string): StandalonePolicy => ({
  support: "conditional",
  reason,
});
const standard = (
  json: JsonPolicy = unsupported("This interactive command has no machine-readable output mode."),
  standalonePolicy: StandalonePolicy = notApplicable(
    "This command does not consume Arashi workspace context.",
  ),
): CommandSemanticMetadata => ({
  json,
  docs: required(),
  skills: required(),
  standalone: standalonePolicy,
  vscode: required(),
});

export const commandSemantics: CommandSemantics = {
  add: {
    ...standard(
      { support: "full" },
      configuredOnly("Adding child repositories requires persisted configuration."),
    ),
    addMaterialization: {
      activeConfigOwnership: true,
      canonicalCloneDefaultBranch: true,
      coordinatedBranch: "active-parent-branch",
      linkedMode: "git-topology",
      resultRoles: [
        "path",
        "materialization",
        "canonicalPath",
        "worktreePath",
        "defaultBranch",
        "coordinatedBranch",
        "setupScript",
        "setupScriptCreated",
      ],
    },
    addOnboarding: {
      activeFiles: {
        createOwner: "active-config-root",
        removeOwner: "runtime-resolved-target-repository",
        safeNoOp: true,
        executableReady: true,
        noOverwrite: true,
      },
      cancellation: {
        finalDeclineAndInterrupt: "rollback",
        topLevelDecline: "minimal-success",
      },
      candidate: { isolatedUntilConfirmed: true, oneConfigSave: true },
      eligibility: {
        defaultNo: true,
        requires: ["stdin-tty", "stdout-tty"],
        suppresses: ["--json", "--force"],
      },
      fields: ["copy", "symlink", "pre-create", "post-create", "pre-remove", "post-remove"],
      hookSources: ["inline-bash", "inline-interpreter-map", "active-file"],
      inlineBashPersistence: "string-shorthand",
      output: {
        humanActiveFiles: "lifecycle-path-and-readiness-only",
        jsonActiveFiles: "excluded-because-json-suppresses-onboarding",
      },
      secrecy: {
        confirmationPreview: "resulting-repository-config-json",
        entry: "visible-plaintext",
        postConfirmation: "presence-and-path-state-only",
      },
      suggestions: {
        bounded: true,
        contentFree: true,
        promptRendering: "control-escaped",
        selectedByDefault: false,
        source: "root-metadata-and-ignore-rule-probes",
      },
      safety: {
        implementation: "pure-node-bun-metadata-and-atomic-no-replace",
        residualRace:
          "hostile-local-ancestor-substitution-between-final-validation-and-publication",
        rollbackResidualRace: "path-replacement-between-final-rollback-identity-check-and-unlink",
      },
      futureScope: "existing-entry-editing-reserved-for-316",
    },
  },
  clone: standard(
    undefined,
    configuredOnly("Cloning configured child repositories requires persisted configuration."),
  ),
  completion: {
    json: unsupported("Completion emits native shell code rather than JSON."),
    docs: required(),
    skills: required(),
    standalone: { support: "full" },
    vscode: excluded("Native shell completion is intentionally outside VS Code extension scope."),
  },
  "completion __query": {
    json: unsupported("The internal completion protocol is not JSON."),
    docs: excluded("The lossless completion query is an internal implementation detail."),
    skills: excluded("The lossless completion query is an internal implementation detail."),
    standalone: notApplicable("The query degrades silently when workspace state is unavailable."),
    vscode: excluded("The internal native-shell protocol is outside VS Code extension scope."),
  },
  configure: {
    ...standard(
      { support: "full" },
      configuredOnly(
        "Configuration editing and inspection require persisted workspace configuration.",
      ),
    ),
    vscode: excluded("Interactive configuration is intentionally a terminal-owned workflow."),
    configure: {
      actions: ["keep", "edit", "clear"],
      descriptors: {
        commandDefaults: [
          "defaults.create.switch",
          "defaults.create.launch",
          "defaults.switch.mode",
        ],
        editorDefaults: [
          "defaults.editors.vscode.create.switch",
          "defaults.editors.vscode.create.launch",
          "defaults.editors.cursor.create.switch",
          "defaults.editors.cursor.create.launch",
          "defaults.editors.kiro.create.switch",
          "defaults.editors.kiro.create.launch",
        ],
        meta: ["meta.baseBranch"],
        repository: [
          "groups",
          "baseBranch",
          "copy",
          "symlink",
          "pre-create",
          "post-create",
          "pre-remove",
          "post-remove",
        ],
        workspace: ["reposDir", "worktreesDir", "baseBranch", "sync.timeoutSeconds"],
        workspaceHooks: [
          "hooks.timeout",
          "hooks.scripts.pre-create",
          "hooks.scripts.post-create",
          "hooks.scripts.pre-remove",
          "hooks.scripts.post-remove",
        ],
      },
      invocation: { editing: "tty-stdin-and-stdout", json: "sanitized-inspection-only" },
      loading: "exact-bytes-strict-no-migration-or-repair",
      noOp: "preserve-original-bytes-before-confirmation",
      preview: {
        activeFiles: "separate-body-free-list",
        config: "exact-serialized-json-including-inline-bodies",
      },
      scopes: [
        "workspace-settings",
        "workspace-hooks",
        "command-defaults",
        "editor-defaults",
        "meta-policy",
        "repository",
      ],
      secrecy: {
        inlineEntry: "visible-plaintext",
        ordinaryAndJson: "lifecycle-and-interpreter-presence-only",
      },
      state: {
        effective: ["inherited", "built-in"],
        persisted: ["configured", "not-configured"],
      },
      transaction: {
        activeFiles: "atomic-no-replace-with-owned-rollback",
        configSavesAtMost: 1,
        expectedBytes: true,
        lock: "shared-workspace-add-configure-lock",
        nativeFiles: "metadata-only-observe-keep-skip-never-overwrite",
      },
    },
  },
  create: {
    ...standard(
      {
        support: "conditional",
        reason: "JSON is available only for non-interactive create operations.",
      },
      standalone(),
    ),
    optionPolicies: {
      "--tab": {
        compatibleOptions: [
          "--herdr",
          "--launch",
          "--no-launch",
          "--no-switch",
          "--sesh",
          "--switch",
          "--tmux",
        ],
        conflicts: [],
        dryRun: { runtimeTargetEvidenceRequired: false, supported: true },
        implies: ["launch", "switch"],
        json: {
          guardPrecedence: "before-option-validation",
          mode: "interactive-or-launch",
          unsupported: true,
        },
        launcherSupport: {
          noFallback: true,
          supported: [
            "cmux",
            "herdr-with-workspace",
            "macos-ghostty-1.3+",
            "macos-iterm2",
            "managed-kitty",
            "sesh",
            "tmux",
            "wezterm-with-pane",
            "windows-terminal-with-session",
          ],
          unsupported: [
            "available-ide",
            "generic",
            "git-bash",
            "linux-ghostty",
            "macos-ghostty-before-1.3",
            "macos-terminal",
            "unmanaged-kitty",
          ],
        },
        overrides: ["--no-launch", "--no-switch", "configured-launcher"],
        persisted: false,
      },
      "--tmux": {
        compatibleOptions: ["--no-launch", "--no-switch"],
        conflicts: ["--herdr", "--sesh"],
        environment: { name: "TMUX", nonEmptyAfterTrim: true },
        implies: ["launch", "switch"],
        json: {
          guardPrecedence: "before-option-validation",
          mode: "interactive-or-launch",
          unsupported: true,
        },
        persisted: false,
      },
    },
  },
  doctor: {
    ...standard({ support: "full" }, standalone()),
    vscode: excluded("Diagnostics remain a terminal-focused maintenance workflow."),
  },
  exec: {
    ...standard(
      { support: "full" },
      configuredOnly("Cross-repository execution requires persisted repository metadata."),
    ),
    vscode: excluded(
      "Arbitrary cross-repository process execution is intentionally terminal-only.",
    ),
  },
  handoff: {
    ...standard({ support: "full" }, standalone()),
    vscode: excluded("Agent handoff generation is intentionally terminal-only."),
  },
  init: {
    ...standard(
      { support: "full" },
      conditionalStandalone(
        "Only init --zero-config prepares standalone mode; ordinary init creates configured mode.",
      ),
    ),
    zeroConfig: {
      compatibleOptions: ["--dry-run", "--json", "--verbose"],
      dryRun: { finalState: "unchanged", supported: true },
      incompatibleOptions: [
        "--force",
        "--ignore-scope",
        "--no-discover",
        "--repos-dir",
        "--worktrees-dir",
      ],
      json: { singleEnvelope: true, supported: true, suppressesHumanStdout: true },
      option: "--zero-config",
    },
  },
  install: {
    json: { support: "full" },
    docs: excluded(
      "The install command is an npm bootstrap implementation detail; user installation guidance lives on the website.",
    ),
    skills: excluded(
      "The skill assumes Arashi is already installed; bootstrap guidance belongs in installation docs.",
    ),
    standalone: notApplicable("Installation does not consume workspace context."),
    vscode: required(),
  },
  list: {
    ...standard({ support: "full" }, standalone()),
    vscode: represented("The worktree panel represents the CLI list workflow."),
  },
  move: standard({ support: "full" }, standalone()),
  prune: standard({ support: "full" }, standalone()),
  pull: standard(
    { support: "full" },
    configuredOnly("Coordinated pull requires persisted repository metadata."),
  ),
  push: {
    ...standard(
      { support: "full" },
      configuredOnly("Coordinated push requires persisted repository metadata."),
    ),
    vscode: excluded("Push remains explicit terminal source-control behavior."),
  },
  remove: standard(
    {
      support: "conditional",
      reason: "JSON mode requires an explicit branch and is non-interactive.",
    },
    standalone(),
  ),
  setup: standard(
    { support: "full" },
    configuredOnly("Repository setup coordination requires persisted repository metadata."),
  ),
  shell: standard(unsupported("Shell integration emits shell code rather than JSON.")),
  "shell init": {
    json: unsupported(
      "Shell initialization emits shell code; --json only returns an unsupported-mode error.",
    ),
    docs: excluded("This subcommand is documented on the parent shell command page."),
    skills: represented("Shell initialization is covered as part of the shell workflow."),
    standalone: notApplicable("Shell initialization does not consume workspace context."),
    vscode: excluded("Shell initialization configures terminals and is not an editor command."),
  },
  "shell install": {
    json: unsupported("Shell installation mutates shell configuration and has no JSON mode."),
    docs: excluded("This subcommand is documented on the parent shell command page."),
    skills: represented("Shell installation is covered as part of the shell workflow."),
    standalone: notApplicable("Shell installation does not consume workspace context."),
    vscode: excluded("Shell configuration installation is outside extension scope."),
  },
  "shell uninstall": {
    json: unsupported("Shell uninstall has no JSON or force mode."),
    docs: excluded("This subcommand is documented on the parent shell command page."),
    skills: represented("Shell removal is covered as part of the shell workflow."),
    standalone: notApplicable("Shell uninstall does not consume workspace context."),
    vscode: excluded("Shell configuration removal is outside extension scope."),
    uninstall: uninstallPolicy("exact-managed-shell-block"),
  },
  status: standard({ support: "full" }, standalone()),
  switch: {
    ...standard(
      unsupported("Switch launches a shell; --json only returns an unsupported-mode error."),
      standalone(),
    ),
    optionPolicies: {
      "--tab": {
        compatibleOptions: [
          "--cursor",
          "--herdr",
          "--ignore-configured-launcher",
          "--kiro",
          "--launch",
          "--no-cd",
          "--no-default-launch",
          "--sesh",
          "--tmux",
          "--vscode",
        ],
        conflicts: ["--cd"],
        implies: ["launch"],
        json: {
          guardPrecedence: "before-option-validation",
          mode: "launch",
          unsupported: true,
        },
        launcherSupport: {
          noFallback: true,
          supported: [
            "cmux",
            "herdr-with-workspace",
            "macos-ghostty-1.3+",
            "macos-iterm2",
            "managed-kitty",
            "sesh",
            "tmux",
            "wezterm-with-pane",
            "windows-terminal-with-session",
          ],
          unsupported: [
            "available-ide",
            "generic",
            "git-bash",
            "linux-ghostty",
            "macos-ghostty-before-1.3",
            "macos-terminal",
            "unmanaged-kitty",
          ],
        },
        overrides: ["configured-cd", "configured-launcher", "contextual-cd"],
        persisted: false,
      },
      "--tmux": {
        compatibleOptions: [
          "--ignore-configured-launcher",
          "--launch",
          "--no-cd",
          "--no-default-launch",
        ],
        conflicts: ["--cd", "--cursor", "--herdr", "--kiro", "--sesh", "--vscode"],
        environment: { name: "TMUX", nonEmptyAfterTrim: true },
        implies: ["launch"],
        json: {
          guardPrecedence: "before-option-validation",
          mode: "launch",
          unsupported: true,
        },
        persisted: false,
      },
    },
  },
  sync: standard(
    { support: "full" },
    configuredOnly("Repository synchronization requires persisted repository metadata."),
  ),
  uninstall: {
    json: unsupported("Product uninstall has no JSON or force mode."),
    docs: required(),
    skills: excluded("Packaged-skill uninstall guidance is outside the conservative MVP."),
    standalone: notApplicable("Product uninstall does not consume workspace context."),
    vscode: excluded("Product removal is an explicit terminal lifecycle operation."),
    uninstall: uninstallPolicy("exactly-one-proven-owner"),
  },
  update: standard({
    support: "conditional",
    reason: "JSON cannot be combined with interactive confirmation options.",
  }),
};

export function validateCommandSemantics(
  paths: string[],
  metadata: CommandSemantics,
  registeredOptions?: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const errors: string[] = [];
  const pathSet = new Set(paths);
  for (const path of paths)
    if (!metadata[path]) errors.push(`Missing semantic metadata for command path "${path}"`);
  for (const path of Object.keys(metadata).toSorted()) {
    if (!pathSet.has(path)) {
      errors.push(`Semantic metadata references unregistered command path "${path}"`);
      continue;
    }
    const item = metadata[path];
    if (item.json.support !== "full" && !item.json.reason.trim())
      errors.push(`Command "${path}" ${item.json.support} JSON support requires a reason`);
    if (item.standalone.support !== "full" && !item.standalone.reason.trim())
      errors.push(
        `Command "${path}" ${item.standalone.support} standalone support requires a reason`,
      );
    for (const surface of ["docs", "skills", "vscode"] as const) {
      const policy = item[surface];
      if (policy.expectation !== "required" && !policy.reason.trim())
        errors.push(
          `Command "${path}" ${surface} ${policy.expectation === "excluded" ? "exclusion" : "representation"} requires a reason`,
        );
    }
    for (const [optionName, policy] of Object.entries(item.optionPolicies ?? {})) {
      if (registeredOptions && !registeredOptions.get(path)?.has(optionName)) {
        errors.push(
          `Command "${path}" option policy references unregistered option "${optionName}"`,
        );
      }
      validateExplicitOptionPolicy(path, optionName, policy, errors);
    }
    const tmuxPolicy = item.optionPolicies?.["--tmux"] as unknown;
    if (
      tmuxPolicy &&
      (!isRecord(tmuxPolicy) ||
        !isRecord(tmuxPolicy.environment) ||
        tmuxPolicy.environment.name !== "TMUX" ||
        tmuxPolicy.environment.nonEmptyAfterTrim !== true)
    ) {
      errors.push(`Command "${path}" --tmux policy requires a non-empty TMUX environment`);
    }
  }
  return errors;
}

function validateExplicitOptionPolicy(
  path: string,
  optionName: string,
  value: unknown,
  errors: string[],
): void {
  const label = `Command "${path}" ${optionName} policy`;
  if (
    !validateExactObject(value, EXPLICIT_POLICY_KEYS, REQUIRED_EXPLICIT_POLICY_KEYS, label, errors)
  )
    return;

  for (const key of ["compatibleOptions", "conflicts", "implies"] as const) {
    validateUniqueStringArray(value[key], `${label}.${key}`, errors);
  }
  if (value.overrides !== undefined) {
    validateUniqueStringArray(value.overrides, `${label}.overrides`, errors);
  }
  if (value.persisted !== false) errors.push(`${label}.persisted must be false`);

  if (
    validateExactObject(
      value.json,
      ["guardPrecedence", "mode", "unsupported"],
      ["guardPrecedence", "mode", "unsupported"],
      `${label}.json`,
      errors,
    )
  ) {
    if (value.json.guardPrecedence !== "before-option-validation")
      errors.push(`${label}.json.guardPrecedence must be "before-option-validation"`);
    if (typeof value.json.mode !== "string" || value.json.mode.trim().length === 0)
      errors.push(`${label}.json.mode must be a non-empty string`);
    if (value.json.unsupported !== true) errors.push(`${label}.json.unsupported must be true`);
  }

  if (
    value.dryRun !== undefined &&
    validateExactObject(
      value.dryRun,
      ["runtimeTargetEvidenceRequired", "supported"],
      ["runtimeTargetEvidenceRequired", "supported"],
      `${label}.dryRun`,
      errors,
    )
  ) {
    if (typeof value.dryRun.runtimeTargetEvidenceRequired !== "boolean")
      errors.push(`${label}.dryRun.runtimeTargetEvidenceRequired must be boolean`);
    if (value.dryRun.supported !== true) errors.push(`${label}.dryRun.supported must be true`);
  }

  if (
    value.environment !== undefined &&
    validateExactObject(
      value.environment,
      ["name", "nonEmptyAfterTrim"],
      ["name", "nonEmptyAfterTrim"],
      `${label}.environment`,
      errors,
    )
  ) {
    if (typeof value.environment.name !== "string" || value.environment.name.trim().length === 0)
      errors.push(`${label}.environment.name must be a non-empty string`);
    if (value.environment.nonEmptyAfterTrim !== true)
      errors.push(`${label}.environment.nonEmptyAfterTrim must be true`);
  }

  if (
    value.launcherSupport !== undefined &&
    validateExactObject(
      value.launcherSupport,
      ["noFallback", "supported", "unsupported"],
      ["noFallback", "supported", "unsupported"],
      `${label}.launcherSupport`,
      errors,
    )
  ) {
    if (value.launcherSupport.noFallback !== true)
      errors.push(`${label}.launcherSupport.noFallback must be true`);
    const supported = validateUniqueStringArray(
      value.launcherSupport.supported,
      `${label}.launcherSupport.supported`,
      errors,
    );
    const unsupported = validateUniqueStringArray(
      value.launcherSupport.unsupported,
      `${label}.launcherSupport.unsupported`,
      errors,
    );
    if (supported && unsupported) {
      const overlap = supported.filter((launcher) => unsupported.includes(launcher));
      if (overlap.length > 0)
        errors.push(
          `${label}.launcherSupport supported and unsupported must not overlap: ${overlap.join(", ")}`,
        );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExactObject(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
  errors: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const extras = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (extras.length > 0) errors.push(`${label} has unsupported fields: ${extras.join(", ")}`);
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) errors.push(`${label} is missing required fields: ${missing.join(", ")}`);
  return extras.length === 0 && missing.length === 0;
}

function validateUniqueStringArray(
  value: unknown,
  label: string,
  errors: string[],
): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    errors.push(`${label} must be an array of strings`);
    return null;
  }
  if (new Set(value).size !== value.length) errors.push(`${label} entries must be unique`);
  return value;
}

export function validateOptionSemanticPolicy(
  path: string,
  optionName: string,
  value: unknown,
): string[] {
  const errors: string[] = [];
  const label = `Command "${path}" ${optionName} policy`;
  if (
    !validateExactObject(
      value,
      [
        "compatibility",
        "conflicts",
        "hookInput",
        "implies",
        "inspection",
        "jsonExecution",
        "ownership",
        "persisted",
        "repositoryBase",
        "role",
        "selector",
        "switch",
      ],
      ["ownership"],
      label,
      errors,
    )
  )
    return errors;

  if (value.ownership !== "structural" && value.ownership !== "command")
    errors.push(`${label}.ownership must be "structural" or "command"`);
  for (const key of ["conflicts", "implies"] as const) {
    if (value[key] !== undefined) validateUniqueStringArray(value[key], `${label}.${key}`, errors);
  }
  if (value.persisted !== undefined && value.persisted !== false)
    errors.push(`${label}.persisted must be false`);
  if (value.role !== undefined && value.role !== "redundant-compatibility")
    errors.push(`${label}.role must be "redundant-compatibility"`);
  if (value.role === "redundant-compatibility" && value.persisted !== false)
    errors.push(`${label}.persisted must be false for redundant compatibility`);

  const ownsRepositoryBasePolicy =
    (path === "create" || path === "clone") &&
    (optionName === "--base" || optionName === "--repo-base");
  if (ownsRepositoryBasePolicy && value.repositoryBase === undefined)
    errors.push(`${label}.repositoryBase is required for shared base options`);
  if (value.repositoryBase !== undefined) {
    if (!ownsRepositoryBasePolicy)
      errors.push(`${label}.repositoryBase is only supported for create/clone base options`);
    if (JSON.stringify(value.repositoryBase) !== JSON.stringify(repositoryBasePolicy))
      errors.push(`${label}.repositoryBase must equal the canonical shared repository base policy`);
  }

  if (
    value.hookInput !== undefined &&
    validateExactObject(
      value.hookInput,
      ["disabledMode", "immediateEof", "jsonPrecedence", "modes", "skipsHooks"],
      ["disabledMode", "immediateEof", "jsonPrecedence", "modes", "skipsHooks"],
      `${label}.hookInput`,
      errors,
    )
  ) {
    if (value.hookInput.disabledMode !== "disabled")
      errors.push(`${label}.hookInput.disabledMode must be "disabled"`);
    if (value.hookInput.immediateEof !== true)
      errors.push(`${label}.hookInput.immediateEof must be true`);
    if (value.hookInput.jsonPrecedence !== true)
      errors.push(`${label}.hookInput.jsonPrecedence must be true`);
    if (value.hookInput.skipsHooks !== false)
      errors.push(`${label}.hookInput.skipsHooks must be false`);
    if (
      !Array.isArray(value.hookInput.modes) ||
      value.hookInput.modes.join(",") !== "tty,disabled,unavailable"
    )
      errors.push(`${label}.hookInput.modes must be tty, disabled, unavailable`);
  }

  if (
    value.compatibility !== undefined &&
    validateExactObject(
      value.compatibility,
      ["alternatives", "canonical", "deprecatedAlternatives", "removal"],
      ["alternatives", "canonical", "deprecatedAlternatives", "removal"],
      `${label}.compatibility`,
      errors,
    )
  ) {
    const alternatives = validateUniqueStringArray(
      value.compatibility.alternatives,
      `${label}.compatibility.alternatives`,
      errors,
    );
    if (alternatives?.some((alternative) => !alternative.startsWith("--")))
      errors.push(`${label}.compatibility.alternatives entries must be long option names`);
    const canonical = value.compatibility.canonical;
    if (!isRecord(canonical)) {
      errors.push(`${label}.compatibility.canonical must be an object`);
    } else if (Object.hasOwn(canonical, "option")) {
      if (
        !validateExactObject(
          canonical,
          ["option"],
          ["option"],
          `${label}.compatibility.canonical`,
          errors,
        ) ||
        typeof canonical.option !== "string" ||
        !canonical.option.startsWith("--")
      )
        errors.push(`${label}.compatibility.canonical.option must be a long option name`);
    } else {
      if (value.role !== "redundant-compatibility")
        errors.push(`${label}.role must be "redundant-compatibility" for an omitted default`);
      if (
        !validateExactObject(
          canonical,
          ["behavior", "omittedDefault"],
          ["omittedDefault"],
          `${label}.compatibility.canonical`,
          errors,
        ) ||
        canonical.omittedDefault !== true
      ) {
        errors.push(`${label}.compatibility.canonical.omittedDefault must be true`);
      } else if (typeof canonical.behavior !== "string" || canonical.behavior.trim().length === 0) {
        errors.push(`${label}.compatibility.canonical.behavior must be a non-empty string`);
      }
    }
    if (value.compatibility.deprecatedAlternatives !== true)
      errors.push(`${label}.compatibility.deprecatedAlternatives must be true`);
    if (
      validateExactObject(
        value.compatibility.removal,
        ["earliestMajor", "requiresApprovedBreakingChange"],
        ["earliestMajor", "requiresApprovedBreakingChange"],
        `${label}.compatibility.removal`,
        errors,
      )
    ) {
      if (
        typeof value.compatibility.removal.earliestMajor !== "number" ||
        !Number.isInteger(value.compatibility.removal.earliestMajor) ||
        value.compatibility.removal.earliestMajor < 2
      )
        errors.push(
          `${label}.compatibility.removal.earliestMajor must be an integer greater than or equal to 2`,
        );
      if (value.compatibility.removal.requiresApprovedBreakingChange !== true)
        errors.push(`${label}.compatibility.removal.requiresApprovedBreakingChange must be true`);
    }
  }

  if (value.selector !== undefined) {
    if (value.ownership !== "command")
      errors.push(`${label}.ownership must be "command" for selector policy`);
    if (value.persisted !== false)
      errors.push(`${label}.persisted must be false for selector policy`);
    if (
      validateExactObject(
        value.selector,
        [
          "accepts",
          "blankSegments",
          "combination",
          "deduplicate",
          "explicitEmpty",
          "flatten",
          "kind",
          "omitted",
          "standalone",
          "supplied",
          "trim",
          "unknown",
          "validationPrecedence",
        ],
        [
          "accepts",
          "blankSegments",
          "combination",
          "deduplicate",
          "explicitEmpty",
          "flatten",
          "kind",
          "omitted",
          "standalone",
          "supplied",
          "trim",
          "unknown",
          "validationPrecedence",
        ],
        `${label}.selector`,
        errors,
      )
    ) {
      const expectedAccepts = ["repeated", "comma-separated", "mixed"];
      if (
        !Array.isArray(value.selector.accepts) ||
        value.selector.accepts.length !== expectedAccepts.length ||
        value.selector.accepts.some((entry, index) => entry !== expectedAccepts[index])
      )
        errors.push(
          `${label}.selector.accepts must equal ["repeated", "comma-separated", "mixed"]`,
        );
      const literals = [
        ["blankSegments", "ignored-beside-values"],
        ["deduplicate", "first-occurrence"],
        ["explicitEmpty", "error"],
        ["flatten", "encounter-order"],
        ["omitted", "default-selection"],
        ["supplied", "distinct-from-omitted"],
        ["unknown", "error"],
        ["validationPrecedence", "before-repository-work"],
      ] as const;
      for (const [field, expected] of literals) {
        if (value.selector[field] !== expected)
          errors.push(`${label}.selector.${field} must be "${expected}"`);
      }
      if (value.selector.trim !== true) errors.push(`${label}.selector.trim must be true`);
      if (value.selector.kind !== "repository" && value.selector.kind !== "group")
        errors.push(`${label}.selector.kind must be "repository" or "group"`);
      if (!["configured-only", "unsupported"].includes(String(value.selector.standalone)))
        errors.push(`${label}.selector.standalone must be "configured-only" or "unsupported"`);
      if (
        validateExactObject(
          value.selector.combination,
          ["empty", "mode", "with"],
          ["empty", "mode", "with"],
          `${label}.selector.combination`,
          errors,
        )
      ) {
        if (value.selector.combination.empty !== "error")
          errors.push(`${label}.selector.combination.empty must be "error"`);
        if (value.selector.combination.mode !== "intersection")
          errors.push(`${label}.selector.combination.mode must be "intersection"`);
        if (
          value.selector.combination.with !== "--only" &&
          value.selector.combination.with !== "--group"
        )
          errors.push(`${label}.selector.combination.with must be "--only" or "--group"`);
      }
    }
  }

  if (
    value.inspection !== undefined &&
    validateExactObject(
      value.inspection,
      ["executionPaths"],
      ["executionPaths"],
      `${label}.inspection`,
      errors,
    )
  ) {
    const paths = validateUniqueStringArray(
      value.inspection.executionPaths,
      `${label}.inspection.executionPaths`,
      errors,
    );
    if (paths && (paths.length !== 2 || !paths.includes("human") || !paths.includes("json")))
      errors.push(`${label}.inspection.executionPaths must contain human and json`);
  }

  if (value.jsonExecution !== undefined) {
    if (value.ownership !== "command")
      errors.push(`${label}.ownership must be "command" for JSON execution policy`);
    if (
      validateExactObject(
        value.jsonExecution,
        ["apply", "bare", "mutation", "prompt"],
        ["apply", "bare", "mutation", "prompt"],
        `${label}.jsonExecution`,
        errors,
      )
    ) {
      if (value.jsonExecution.apply !== "unsupported")
        errors.push(`${label}.jsonExecution.apply must be "unsupported"`);
      if (value.jsonExecution.bare !== "inspection-only")
        errors.push(`${label}.jsonExecution.bare must be "inspection-only"`);
      if (value.jsonExecution.mutation !== false)
        errors.push(`${label}.jsonExecution.mutation must be false`);
      if (value.jsonExecution.prompt !== false)
        errors.push(`${label}.jsonExecution.prompt must be false`);
    }
  }

  if (
    value.switch !== undefined &&
    validateExactObject(
      value.switch,
      ["configuredModeEffects", "explicitLauncher", "jsonGuardPrecedence", "tab"],
      ["explicitLauncher", "jsonGuardPrecedence", "tab"],
      `${label}.switch`,
      errors,
    )
  ) {
    if (
      value.switch.configuredModeEffects !== undefined &&
      validateExactObject(
        value.switch.configuredModeEffects,
        ["auto", "cd", "herdr", "launch", "sesh"],
        ["auto", "cd", "herdr", "launch", "sesh"],
        `${label}.switch.configuredModeEffects`,
        errors,
      )
    ) {
      const effects = new Set<SwitchConfiguredModeEffect>([
        "automatic-launch",
        "launch",
        "preserve-configured-or-contextual-behavior",
        "preserve-named-launcher",
      ]);
      for (const mode of ["auto", "cd", "herdr", "launch", "sesh"] as const) {
        if (!effects.has(value.switch.configuredModeEffects[mode] as SwitchConfiguredModeEffect))
          errors.push(`${label}.switch.configuredModeEffects.${mode} has an unsupported effect`);
      }
    }
    if (
      validateExactObject(
        value.switch.explicitLauncher,
        ["authoritative", "compatible", "noFallback"],
        ["authoritative", "compatible", "noFallback"],
        `${label}.switch.explicitLauncher`,
        errors,
      ) &&
      (value.switch.explicitLauncher.authoritative !== true ||
        value.switch.explicitLauncher.compatible !== true ||
        value.switch.explicitLauncher.noFallback !== "preserved")
    )
      errors.push(
        `${label}.switch.explicitLauncher must be compatible, authoritative, and preserve no-fallback behavior`,
      );
    if (value.switch.jsonGuardPrecedence !== "before-option-and-conflict-validation")
      errors.push(
        `${label}.switch.jsonGuardPrecedence must be "before-option-and-conflict-validation"`,
      );
    if (
      validateExactObject(
        value.switch.tab,
        ["bypassesConfiguredDefaults", "compatible", "disposition"],
        ["bypassesConfiguredDefaults", "compatible", "disposition"],
        `${label}.switch.tab`,
        errors,
      ) &&
      (value.switch.tab.bypassesConfiguredDefaults !== true ||
        value.switch.tab.compatible !== true ||
        value.switch.tab.disposition !== "tab")
    )
      errors.push(
        `${label}.switch.tab must be compatible and bypass configured defaults with tab disposition`,
      );
  }
  return errors;
}

const COMMON_OPTION_ALIASES = {
  "--dry-run": "-n",
  "--force": "-f",
  "--group": "-g",
  "--json": "-j",
  "--only": "-o",
  "--verbose": "-v",
} as const;
const RESERVED_COMMON_ALIAS_EXCEPTIONS = new Set(["add\u0000--name\u0000-n"]);

export function validateOptionAudit(program: Command, policies: OptionAuditPolicies): string[] {
  const errors: string[] = [];
  const visit = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      const optionsByLong = new Map(
        command.options.flatMap((option) => (option.long ? [[option.long, option] as const] : [])),
      );
      const longs = new Set(optionsByLong.keys());
      const aliases = new Map<string, string>();
      const commonLongByAlias = new Map<string, string>(
        Object.entries(COMMON_OPTION_ALIASES).map(([long, short]) => [short, long]),
      );
      for (const option of command.options) {
        if (!option.long)
          errors.push(`Command "${path}" option "${option.flags}" requires a long name`);
        if (option.long && option.long in COMMON_OPTION_ALIASES) {
          const expectedAlias =
            COMMON_OPTION_ALIASES[option.long as keyof typeof COMMON_OPTION_ALIASES];
          if (option.short !== expectedAlias)
            errors.push(
              `Command "${path}" common option "${option.long}" requires short alias "${expectedAlias}"`,
            );
        }
        if (option.short && option.long) {
          const expectedLong = commonLongByAlias.get(option.short);
          const isReserved = RESERVED_COMMON_ALIAS_EXCEPTIONS.has(
            `${path}\u0000${option.long}\u0000${option.short}`,
          );
          if (expectedLong && option.long !== expectedLong && !isReserved)
            errors.push(
              `Command "${path}" short alias "${option.short}" is reserved for common option "${expectedLong}", not "${option.long}"`,
            );
          const previous = aliases.get(option.short);
          if (previous) {
            const options = [previous, option.long].toSorted();
            errors.push(
              `Command "${path}" short alias "${option.short}" collides between "${options[0]}" and "${options[1]}"`,
            );
          } else aliases.set(option.short, option.long);
        }
      }
      for (const [optionName, policy] of Object.entries(policies[path] ?? {})) {
        if (!longs.has(optionName))
          errors.push(
            `Command "${path}" option policy references unregistered option "${optionName}"`,
          );
        errors.push(...validateOptionSemanticPolicy(path, optionName, policy));
        const compatibility = policy.compatibility;
        if (compatibility) {
          if ("option" in compatibility.canonical) {
            const canonical = optionsByLong.get(compatibility.canonical.option);
            if (!canonical)
              errors.push(
                `Command "${path}" ${optionName} compatibility canonical option "${compatibility.canonical.option}" is not registered`,
              );
            else if (canonical.hidden)
              errors.push(
                `Command "${path}" ${optionName} compatibility canonical option "${compatibility.canonical.option}" must be visible`,
              );
          }
          for (const alternativeName of compatibility.alternatives) {
            const alternative = optionsByLong.get(alternativeName);
            if (!alternative)
              errors.push(
                `Command "${path}" ${optionName} compatibility alternative "${alternativeName}" is not registered`,
              );
            else if (
              !alternative.hidden ||
              !(alternative as typeof alternative & { deprecated?: boolean }).deprecated
            )
              errors.push(
                `Command "${path}" ${optionName} compatibility alternative "${alternativeName}" must be hidden and deprecated`,
              );
          }
        }
        for (const conflict of Array.isArray(policy.conflicts) ? policy.conflicts : []) {
          if (typeof conflict === "string" && !longs.has(conflict))
            errors.push(`Command "${path}" ${optionName} conflict "${conflict}" is not registered`);
        }
        for (const implication of Array.isArray(policy.implies) ? policy.implies : []) {
          if (
            typeof implication === "string" &&
            implication.startsWith("--") &&
            !longs.has(implication)
          )
            errors.push(
              `Command "${path}" ${optionName} implication "${implication}" is not registered`,
            );
        }
      }
      const commandPolicies = policies[path] ?? {};
      for (const selectorName of ["--only", "--group"] as const) {
        if (longs.has(selectorName) && commandPolicies[selectorName]?.selector === undefined)
          errors.push(
            `Command "${path}" registered selector "${selectorName}" requires a complete selector policy`,
          );
      }
      for (const [optionName, policy] of Object.entries(commandPolicies)) {
        if (policy.selector !== undefined) {
          if (optionName !== "--only" && optionName !== "--group") {
            errors.push(
              `Command "${path}" non-selector option "${optionName}" must not declare selector policy`,
            );
          } else if (isRecord(policy.selector)) {
            const expectedKind = optionName === "--only" ? "repository" : "group";
            const expectedCounterpart = optionName === "--only" ? "--group" : "--only";
            if (policy.selector.kind !== expectedKind)
              errors.push(
                `Command "${path}" ${optionName} selector kind must be "${expectedKind}"`,
              );
            if (
              isRecord(policy.selector.combination) &&
              policy.selector.combination.with !== expectedCounterpart
            )
              errors.push(
                `Command "${path}" ${optionName} selector combination must reference "${expectedCounterpart}"`,
              );
          }
        }
        for (const conflict of Array.isArray(policy.conflicts) ? policy.conflicts : []) {
          if (
            typeof conflict === "string" &&
            longs.has(conflict) &&
            commandPolicies[conflict] !== undefined &&
            !commandPolicies[conflict].conflicts?.includes(optionName)
          )
            errors.push(
              `Command "${path}" conflict "${optionName}" -> "${conflict}" must be reciprocal`,
            );
        }
      }
      visit(command, path);
    }
  };
  visit(program, "");
  for (const path of Object.keys(policies).toSorted()) {
    if (!discoverCommandPaths(program).includes(path))
      errors.push(`Option policy references unregistered command path "${path}"`);
  }
  return errors;
}

export interface CliCommandContract {
  schemaVersion: 8;
  root: ContractRoot;
  commands: ContractCommand[];
}
export interface ContractArgument {
  candidateKind?: CompletionCandidateKind;
  choices?: string[];
  description: string;
  hidden: boolean;
  name: string;
  required: boolean;
  variadic: boolean;
}
export interface ContractOption {
  candidateKind?: CompletionCandidateKind;
  choices?: string[];
  conflicts: string[];
  deprecated: boolean;
  description: string;
  flags: string;
  hidden: boolean;
  long: string;
  required: boolean;
  optional: boolean;
  repeatable: boolean;
  semanticPolicy?: OptionSemanticPolicy;
  semanticPolicyOwner: "structural" | "command";
  short: string | null;
  valueShape: "boolean" | "optional" | "required";
  variadic: boolean;
}
export interface ContractRoot {
  aliases: string[];
  description: string;
  name: string;
  options: ContractOption[];
}
export interface ContractCommand {
  path: string;
  aliasPaths: string[];
  description: string;
  aliases: string[];
  hidden: boolean;
  arguments: ContractArgument[];
  options: ContractOption[];
  semantics: CommandSemanticMetadata;
}

const completionArgumentKinds: Record<string, CompletionCandidateKind> = {
  "completion:shell": "shell",
  "remove:target": "worktree",
  "shell init:shell": "shell",
  "switch:filter": "worktree",
};

const completionOptionKinds: Record<string, CompletionCandidateKind> = {
  "create:--conflict": "choice",
  "move:--from": "workspace",
  "move:--to": "workspace",
};

function candidateKindForOption(
  path: string,
  long: string,
  policy: OptionSemanticPolicy | undefined,
): CompletionCandidateKind | undefined {
  if (policy?.selector?.kind) return policy.selector.kind;
  return completionOptionKinds[`${path}:${long}`];
}

function contractOption(
  option: Option,
  path: string,
  metadata: CommandSemantics,
  optionPolicies: OptionAuditPolicies,
): ContractOption {
  const semanticPolicy = optionPolicies[path]?.[option.long ?? ""];
  const commandPolicy = metadata[path]?.optionPolicies?.[option.long ?? ""];
  const conflicts = [
    ...(option as Option & { conflictsWith: string[] }).conflictsWith,
    ...(semanticPolicy?.conflicts ?? []),
    ...(commandPolicy?.conflicts ?? []),
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .toSorted();
  return {
    candidateKind: candidateKindForOption(path, option.long ?? "", semanticPolicy),
    choices: option.argChoices ? [...option.argChoices].toSorted() : undefined,
    conflicts,
    deprecated: Boolean((option as typeof option & { deprecated?: boolean }).deprecated),
    flags: option.flags,
    description: option.description,
    hidden: option.hidden,
    long: option.long ?? "",
    required: option.required,
    optional: option.optional,
    repeatable:
      option.variadic || Boolean((option as Option & { repeatable?: boolean }).repeatable),
    semanticPolicy,
    semanticPolicyOwner: semanticPolicy
      ? semanticPolicy.ownership
      : commandPolicy
        ? "command"
        : "structural",
    short: option.short ?? null,
    valueShape: option.required ? "required" : option.optional ? "optional" : "boolean",
    variadic: option.variadic,
  };
}

function optionsWithBuiltInHelp(command: Command): Option[] {
  const helpOption = (command as Command & { _getHelpOption(): Option | null })._getHelpOption();
  return helpOption ? [...command.options, helpOption] : [...command.options];
}

export function generateCommandContract(
  program: Command,
  metadata: CommandSemantics,
  optionPolicies: OptionAuditPolicies = optionAuditPolicies,
): CliCommandContract {
  const paths = discoverCommandPaths(program);
  const registeredOptions = new Map<string, ReadonlySet<string>>();
  const collectOptions = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      registeredOptions.set(
        path,
        new Set(command.options.flatMap((option) => (option.long ? [option.long] : []))),
      );
      collectOptions(command, path);
    }
  };
  collectOptions(program, "");
  const errors = [
    ...validateCommandSemantics(paths, metadata, registeredOptions),
    ...validateOptionAudit(program, optionPolicies),
  ];
  if (errors.length) throw new Error(`Invalid CLI command semantics:\n${errors.join("\n")}`);
  const commands: ContractCommand[] = [];
  const visit = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      commands.push({
        path,
        aliasPaths: command
          .aliases()
          .map((alias) => (prefix ? `${prefix} ${alias}` : alias))
          .toSorted(),
        description: command.description(),
        aliases: command.aliases().toSorted(),
        hidden: Boolean((command as Command & { _hidden?: boolean })._hidden),
        arguments: command.registeredArguments.map((argument) => ({
          candidateKind: completionArgumentKinds[`${path}:${argument.name()}`],
          choices: argument.argChoices ? [...argument.argChoices].toSorted() : undefined,
          hidden: false,
          name: argument.name(),
          required: argument.required,
          variadic: argument.variadic,
          description: argument.description,
        })),
        options: optionsWithBuiltInHelp(command)
          .map((option) => contractOption(option, path, metadata, optionPolicies))
          .toSorted((a, b) => a.flags.localeCompare(b.flags)),
        semantics: metadata[path]!,
      });
      visit(command, path);
    }
  };
  visit(program, "");
  return {
    schemaVersion: 8,
    root: {
      aliases: program.aliases().toSorted(),
      description: program.description(),
      name: program.name(),
      options: optionsWithBuiltInHelp(program)
        .map((option) => contractOption(option, "", metadata, optionPolicies))
        .toSorted((left, right) => left.flags.localeCompare(right.flags)),
    },
    commands: commands.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

export function serializeCommandContract(contract: CliCommandContract): string {
  const formatted = JSON.stringify(contract, null, 2).replace(
    /^(\s*"[^"]+": )\[\n((?:\s+"(?:[^"\\]|\\.)*",?\n)+)\s*\]/gm,
    (block, prefix: string, entries: string) => {
      const inline = `${prefix}[${entries
        .trim()
        .split("\n")
        .map((entry) => entry.trim().replace(/,$/, ""))
        .join(", ")}]`;
      return inline.length <= 100 ? inline : block;
    },
  );
  return `${formatted}\n`;
}
