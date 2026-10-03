import { realpath } from "node:fs/promises";
import { mergeT3Settings } from "../lib/t3-settings.ts";
import type { T3Settings } from "../lib/t3-settings.ts";
import { dispatchT3Handoff, resolveT3HandoffRequest, T3HandoffError } from "../lib/t3-handoff.ts";
import type {
  T3HandoffDependencies,
  T3HandoffResult,
  T3PermissionMode,
} from "../lib/t3-handoff.ts";
import { preflightT3Native } from "../lib/t3-native.ts";
import {
  revalidateSwitchGitIdentity,
  switchGitIdentity,
  switchT3PinnedSettings,
  validateSwitchT3Intent,
} from "../lib/switch-t3-handoff.ts";
import { runtime } from "../lib/runtime.ts";
import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { basename, isAbsolute, relative, resolve, sep } from "path";
import {
  discoverSwitchCandidates,
  filterSwitchCandidates,
  selectSwitchCandidate,
} from "../core/switch.ts";
import type { SelectSwitchCandidateOptions } from "../core/switch.ts";
import { ConfigError, findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import type { SwitchMode } from "../lib/config.ts";
import { getDirectiveContext, writeCdDirective } from "../lib/shell-directives.ts";
import { info, error as logError, success, warn } from "../lib/logger.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unsupportedJsonModeError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { Command, Option } from "commander";
import { exec } from "../lib/git.ts";
import { detectManagedSwitchContext, launchSwitchTarget } from "../lib/switch-launcher.ts";
import type { LaunchDisposition, LaunchSwitchOptions } from "../lib/switch-launcher.ts";
import { resolveDefaultWithPrecedence } from "../lib/default-resolution.ts";
import { findConfiguredWorkspaceRoots, resolveWorkspaceContext } from "../lib/workspace-context.ts";

type LoadWorkspaceRepositoriesResult = Awaited<ReturnType<typeof loadWorkspaceRepositories>>;
type Config = NonNullable<LoadWorkspaceRepositoriesResult["config"]>;
type LaunchMode = "auto" | "sesh" | "herdr";
type SwitchBehaviorMode = "launch" | "cd" | "auto";
type LaunchSwitchResult = Awaited<ReturnType<typeof launchSwitchTarget>>;
type SwitchCandidateDiscoveryResult = Awaited<ReturnType<typeof discoverSwitchCandidates>>;
type SwitchCandidate = SwitchCandidateDiscoveryResult["candidates"][number];
type SwitchLaunchMode = "cd" | LaunchSwitchResult["mode"];
type SupportedIde = "vscode" | "cursor" | "kiro";
type SwitchProcessRunner = NonNullable<
  NonNullable<Parameters<typeof launchSwitchTarget>[2]>["runProcess"]
>;
type WorkspaceRepository = LoadWorkspaceRepositoriesResult["repositories"][number];

const ZERO = 0;
const ONE = 1;
const SUCCESS_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const AUTO_LAUNCH_MODE: LaunchMode = "auto";
const AUTO_SWITCH_MODE: SwitchBehaviorMode = "auto";
const CD_SWITCH_MODE: SwitchBehaviorMode = "cd";
const LAUNCH_SWITCH_MODE: SwitchBehaviorMode = "launch";
const SESH_LAUNCH_MODE = "sesh" as const;
const HERDR_LAUNCH_MODE = "herdr" as const;
const DETACHED_HEAD = "HEAD";
const KEY_SEPARATOR = "\u0000";

export interface SwitchCommandOptions {
  t3?: boolean | string;
  promptFile?: string;
  permission?: string;
  t3BaseDir?: string;
  t3Cli?: string;
  t3Provider?: string;
  t3Model?: string;
  t3Effort?: string;
  t3Intent?: string;
  tab?: boolean;
  herdr?: boolean;
  sesh?: boolean;
  tmux?: boolean;
  cd?: boolean;
  vscode?: boolean;
  cursor?: boolean;
  kiro?: boolean;
  path?: boolean;
  repos?: boolean;
  all?: boolean;
  defaultLaunch?: boolean;
  ignoreConfiguredLauncher?: boolean;
  json?: boolean;
  legacyNoCd?: boolean;
  legacyNoDefaultLaunch?: boolean;
  launch?: boolean;
}

class LegacyCompatibilityOption extends Option {
  readonly #attributeName: string;

  constructor(flags: string, description: string, attributeName: string) {
    super(flags, description);
    this.#attributeName = attributeName;
    this.negate = false;
  }

  override attributeName(): string {
    return this.#attributeName;
  }
}

interface LaunchResolution {
  disposition: LaunchDisposition;
  herdr?: boolean;
  preferredIde?: SupportedIde;
  requirePreferredIde?: boolean;
  sesh?: boolean;
  tmux?: boolean;
}

interface SwitchBehaviorResolution {
  mode: SwitchBehaviorMode;
  skipLaunchWhenUnavailable: boolean;
  warnOnMissingIntegration: boolean;
}

interface SwitchResolution {
  behavior: SwitchBehaviorResolution;
  launch: LaunchResolution;
}

interface SwitchResolutionInput {
  configMode?: SwitchMode;
  managedContextActive: boolean;
  options: SwitchCommandOptions;
  shellIntegrationActive: boolean;
}

interface SwitchBehaviorInput {
  configMode?: SwitchBehaviorMode;
  hasExplicitLaunchOverride: boolean;
  managedContextActive: boolean;
  options: SwitchCommandOptions;
  shellIntegrationActive: boolean;
}

type SwitchRepositoryScope = "parent" | "repos" | "all";

export interface SwitchCommandDependencies {
  t3?: T3HandoffDependencies;
  dispatchT3Handoff?: typeof dispatchT3Handoff;
  findWorkspaceRoot?: () => Promise<string>;
  loadWorkspaceRepositories?: (
    workspaceRoot: string,
  ) => Promise<{ repositories: WorkspaceRepository[]; config?: Config }>;
  discoverSwitchCandidates?: (
    repositories: WorkspaceRepository[],
  ) => Promise<SwitchCandidateDiscoveryResult>;
  selectSwitchCandidate?: (
    candidates: SwitchCandidate[],
    options: SelectSwitchCandidateOptions,
  ) => Promise<SwitchCandidate>;
  augmentAllScopeCandidates?: (
    candidates: SwitchCandidate[],
    options: {
      workspaceRoot: string;
      reposDir: string;
      repositories: WorkspaceRepository[];
    },
  ) => Promise<SwitchCandidate[]>;
  launchSwitchTarget?: (
    candidate: SwitchCandidate,
    options: LaunchSwitchOptions,
    deps: {
      env: Record<string, string | undefined>;
      homeDirectory?: () => string | undefined;
      pathExists?: (path: string) => Promise<boolean>;
      platform: NodeJS.Platform;
      runProcess?: SwitchProcessRunner;
    },
  ) => Promise<LaunchSwitchResult>;
  env?: Record<string, string | undefined>;
  homeDirectory?: () => string | undefined;
  pathExists?: (path: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  runProcess?: SwitchProcessRunner;
}

export interface SwitchExecutionResult {
  selected: SwitchCandidate;
  launchMode: SwitchLaunchMode;
  totalCandidates: number;
  matchedCandidates: number;
  skippedCandidates: number;
}

const formatSwitchTarget = (candidate: SwitchCandidate): string =>
  `${candidate.branchName} in repository ${candidate.repoName} at ${candidate.worktreePath}`;

export function createCommand(): Command {
  const permissionOption = new Option(
    "--permission <mode>",
    "T3 permission: approval-required, auto-accept-edits, full-access (initial default)",
  );
  // Publish completion choices while retaining executor validation for JSON error envelopes.
  permissionOption.argChoices = ["approval-required", "auto-accept-edits", "full-access"];
  const deprecatedNoCd = new LegacyCompatibilityOption(
    "--no-cd",
    "Deprecated compatibility spelling for --launch",
    "legacyNoCd",
  ).hideHelp();
  const deprecatedNoDefaultLaunch = new LegacyCompatibilityOption(
    "--no-default-launch",
    "Deprecated compatibility spelling for --ignore-configured-launcher",
    "legacyNoDefaultLaunch",
  ).hideHelp();
  (deprecatedNoCd as Option & { deprecated?: boolean }).deprecated = true;
  (deprecatedNoDefaultLaunch as Option & { deprecated?: boolean }).deprecated = true;

  return new Command("switch")
    .description("Switch to an existing worktree using explicit, configured, or contextual modes")
    .argument("[filter]", "Filter targets by branch name or worktree path")
    .option(
      "--t3 [task]",
      "Send one task to native T3 in the selected existing checkout; no UI opens",
    )
    .option(
      "--prompt-file <path>",
      "Read the exact UTF-8 task once from invocation CWD; requires --t3",
    )
    .addOption(permissionOption)
    .option("--t3-base-dir <path>", "Official local T3 data directory; requires --t3")
    .option("--t3-cli <path>", "Official T3 command name or absolute executable; requires --t3")
    .option(
      "--t3-provider <id>",
      "Supported native provider instance or unambiguous driver; requires --t3",
    )
    .option("--t3-model <model>", "Supported native model slug or alias; requires --t3")
    .option("--t3-effort <effort>", "Supported native reasoning effort; requires --t3")
    .option(
      "--t3-intent <id>",
      "Exact local intent (default); resolved followups use deliberate distinct IDs; requires --t3",
    )
    .option("--path", "Treat argument as exact worktree path")
    .option("--sesh", "Use sesh in tmux mode")
    .option("--tmux", "Force launch in a new plain tmux window")
    .option("--herdr", "Open or focus the selected worktree in Herdr")
    .option("--tab", "Opens the selected worktree in a tab and bypasses configured launch defaults")
    .option("--cd", "Change the current shell directory when shell integration is active")
    .option("--launch", "Launch the selected worktree while preserving a configured launcher")
    .addOption(deprecatedNoCd)
    .option("--vscode", "Open the selected worktree in VS Code")
    .option("--cursor", "Open the selected worktree in Cursor")
    .option("--kiro", "Open the selected worktree in Kiro")
    .option(
      "--ignore-configured-launcher",
      "Bypass a configured sesh or Herdr launcher for this invocation",
    )
    .addOption(deprecatedNoDefaultLaunch)
    .option("--repos", "Use child repositories only")
    .option("--all", "Use both parent and child repositories")
    .option(
      "-j, --json",
      "Return one structured T3 outcome; ordinary launch/CD modes remain unsupported",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ aw switch
  $ aw switch --repos
  $ aw switch --ignore-configured-launcher
  $ aw switch --all feature-auth
  $ aw switch --cursor feature-auth
  $ aw switch --path /path/to/worktree
  $ aw switch feature-auth
  $ aw switch repo-a --sesh
  $ aw switch --path /path/to/checkout --t3 "Continue this task"
  $ aw switch --repos repo-a --t3 --prompt-file ./task.txt --permission approval-required
  $ aw switch --path /path/to/checkout --t3 "Next task" --t3-intent followup-1

T3 uses the existing selected checkout and opens no host UI. Manually select the reported native
project/thread in your connected client. Conversation state is not transferred. Reusing an intent
reconciles its saved IDs; unresolved attempts cannot be bypassed with a fresh intent. Preserve
receipts and stale locks until owner termination and exact native evidence justify manual recovery.

Configured modes: auto | cd | launch | sesh | herdr
Precedence: explicit launcher flags, --cd/--launch, configured mode, then automatic context detection.
By default, launch opens a new OS window or managed independent-session equivalent.
--tab requests a true tab or equivalent; unsupported mappings fail without opening a window.
`,
    )
    .action(async (filter: string | undefined, options: SwitchCommandOptions) => {
      try {
        const result = await executeSwitch(filter, options);
        process.exit(typeof result === "number" ? result : SUCCESS_EXIT_CODE);
      } catch (error) {
        handleSwitchError(error);
      }
    });
}

export function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions & { t3: true | string },
  deps?: SwitchCommandDependencies,
): Promise<number>;
export function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions & { json: true },
  deps?: SwitchCommandDependencies,
): Promise<number>;
export function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions & { t3?: false; json?: false },
  deps?: SwitchCommandDependencies,
): Promise<SwitchExecutionResult>;
export function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions,
  deps?: SwitchCommandDependencies,
): Promise<SwitchExecutionResult | number>;
export async function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions,
  deps: SwitchCommandDependencies = {},
): Promise<SwitchExecutionResult | number> {
  if (options.json && !t3Enabled(options)) {
    writeJsonEnvelope(unsupportedJsonModeError("switch", "launch"));
    return USAGE_EXIT_CODE;
  }
  try {
    return await executeSwitchSelected(filter, options, deps);
  } catch (error) {
    if (
      error instanceof SwitchCommandError &&
      error.code === SwitchCommandErrorCode.USER_CANCELLED &&
      t3Enabled(options)
    ) {
      if (options.json) writeJsonEnvelope(createJsonSuccessEnvelope("switch", { cancelled: true }));
      return SUCCESS_EXIT_CODE;
    }
    const normalizedError = t3Enabled(options) ? safeSwitchT3Error(error) : error;
    if (options.json) {
      const known = normalizedError as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      writeJsonEnvelope(
        createJsonErrorEnvelope("switch", {
          code: known.code ?? "T3_HANDOFF_FAILED",
          details:
            normalizedError instanceof SwitchCommandError
              ? (normalizedError.context ?? {})
              : (known.details ?? {}),
          message: cleanDisplay(known.message ?? "Switch handoff failed."),
        }),
      );
      return switchT3ExitCode(normalizedError);
    }
    throw normalizedError;
  }
}

async function executeSwitchSelected(
  filter: string | undefined,
  options: SwitchCommandOptions,
  deps: SwitchCommandDependencies = {},
): Promise<SwitchExecutionResult | number> {
  validateSwitchOptions(options);
  const t3Request = await resolveT3HandoffRequest({
    ...options,
    permission: options.permission as T3PermissionMode | undefined,
  });
  if (!t3Request) {
    emitSwitchDeprecationWarnings(options);
  }
  const resolveWorkspaceRoot = deps.findWorkspaceRoot ?? findWorkspaceRoot;
  const resolveWorkspaceRepositories = deps.loadWorkspaceRepositories ?? loadWorkspaceRepositories;
  const discoverCandidates = deps.discoverSwitchCandidates ?? discoverSwitchCandidates;
  const chooseCandidate = deps.selectSwitchCandidate ?? selectSwitchCandidate;
  const augmentAllCandidates = deps.augmentAllScopeCandidates ?? augmentAllScopeCandidates;
  const launchCandidate = deps.launchSwitchTarget ?? launchSwitchTarget;

  const context = await resolveWorkspaceContext();
  if (context.mode === "standalone" && (options.repos || options.all)) {
    throw new SwitchCommandError(
      "--repos and --all are not meaningful in standalone mode; switch already uses this repository's worktrees.",
      SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS,
      { mode: "standalone" },
    );
  }
  if (context.mode === "standalone" && !t3Request) {
    info(`Workspace mode: standalone`);
    info(`Main repository: ${context.mainRoot}`);
  }
  let configurationRoot: string;
  let workspaceRoot: string;
  if (context.mode === "standalone") {
    configurationRoot = context.mainRoot;
    workspaceRoot = context.mainRoot;
  } else if (deps.findWorkspaceRoot) {
    configurationRoot = await resolveWorkspaceRoot();
    workspaceRoot = configurationRoot;
  } else {
    const roots = await findConfiguredWorkspaceRoots("switch", process.cwd());
    ({ configurationRoot } = roots);
    workspaceRoot = roots.executionRoot;
  }
  const workspace =
    context.mode === "standalone"
      ? { config: context.config, repositories: [context.repository] }
      : deps.loadWorkspaceRepositories
        ? await resolveWorkspaceRepositories(configurationRoot)
        : await loadWorkspaceRepositories({ configurationRoot, executionRoot: workspaceRoot });
  const scope = resolveSwitchScope(options);
  const targetRepositories = filterRepositoriesByScope(
    scope,
    workspaceRoot,
    workspace.repositories,
  );
  const discovery = await discoverCandidates(targetRepositories);
  let scopedCandidates = filterCandidatesByScope(scope, workspaceRoot, discovery.candidates);

  if (scope === "all") {
    scopedCandidates = await augmentAllCandidates(scopedCandidates, {
      reposDir: workspace.config?.reposDir ?? "./repos",
      repositories: workspace.repositories,
      workspaceRoot,
    });
  }

  if (scopedCandidates.length === 0) {
    throw new SwitchCommandError(getNoTargetsMessage(scope), SwitchCommandErrorCode.NO_TARGETS, {
      scope,
      workspaceRoot,
    });
  }

  let matchedCandidates = filterSwitchCandidates(scopedCandidates, filter);
  if (options.path) {
    matchedCandidates = filterSwitchCandidatesByExactPath(scopedCandidates, filter);
  } else if (scope === "repos") {
    matchedCandidates = filterRepoScopedCandidates(scopedCandidates, filter);
  }

  if (matchedCandidates.length === ZERO) {
    if (options.path) {
      throw new SwitchCommandError(
        buildPathNoMatchMessage(filter),
        SwitchCommandErrorCode.NO_MATCHES,
        {
          filter,
          pathMode: true,
          scope,
        },
      );
    }

    if (scope === "repos") {
      throw new SwitchCommandError(
        buildRepoNoMatchMessage(scopedCandidates, filter),
        SwitchCommandErrorCode.NO_MATCHES,
        {
          filter,
          scope,
        },
      );
    }

    throw new SwitchCommandError(
      `No worktrees matched filter \`${filter}\`. Run \`aw switch\` to choose interactively or provide a broader filter.`,
      SwitchCommandErrorCode.NO_MATCHES,
      {
        filter,
        scope,
      },
    );
  }

  const interactive = Boolean(
    !options.json &&
    (deps.stdinIsTTY ?? process.stdin.isTTY) &&
    (deps.stdoutIsTTY ?? process.stdout.isTTY),
  );
  const displayRoot =
    (context.mode === "unavailable" ? undefined : context.effective?.mainRoot) ?? configurationRoot;
  const selected = await chooseCandidate(matchedCandidates, {
    interactive,
    displayRoot,
    worktreesBase: resolve(
      displayRoot,
      (context.mode === "unavailable" ? undefined : context.config.worktreesDir) ??
        workspace.config?.worktreesDir ??
        ".arashi/worktrees",
    ),
    repositories: workspace.repositories.map((repo) => {
      const localPath = relative(workspaceRoot, repo.path);
      const external =
        isAbsolute(localPath) || localPath === ".." || localPath.startsWith(`..${sep}`);
      return { ...repo, path: external ? repo.path : resolve(displayRoot, localPath) };
    }),
    workspaceRepoName:
      scope === "all"
        ? (workspace.repositories.find((repo) => resolve(repo.path) === resolve(workspaceRoot))
            ?.name ?? basename(resolve(configurationRoot)))
        : undefined,
  });

  if (t3Request) {
    const workspacePath = await realpath(selected.worktreePath);
    const identity = await switchGitIdentity(workspacePath);
    const explicit: T3Settings = {};
    const explicitSettings: Record<string, string> = {};
    const provenance: Record<string, string> = {};
    for (const leaf of ["baseDir", "cli", "provider", "model", "effort"] as const) {
      const value =
        options[("t3" + leaf[0]!.toUpperCase() + leaf.slice(1)) as keyof SwitchCommandOptions];
      if (typeof value === "string") {
        explicit[leaf] = value;
        explicitSettings[leaf] = value;
      }
      provenance[leaf] =
        value !== undefined
          ? "cli"
          : context.mode !== "unavailable"
            ? (context.effective?.sources[`defaults.t3.${leaf}`] ??
              (workspace.config?.defaults?.t3?.[leaf] ? "workspace" : "native"))
            : "native";
      if (provenance[leaf] === "built-in") {
        provenance[leaf] = "native";
      }
    }
    if (options.permission !== undefined) {
      explicitSettings.permission = options.permission;
    }
    const defaults =
      context.mode !== "unavailable" ? context.config.defaults?.t3 : workspace.config?.defaults?.t3;
    let settings: T3Settings;
    try {
      settings = mergeT3Settings(explicit, defaults);
    } catch {
      throw new T3HandoffError(
        "T3_OPTIONS_INVALID",
        "T3 settings must use valid nonempty values, an absolute data directory, and a command name or absolute CLI path.",
      );
    }
    const intentId = options.t3Intent ?? "default";
    const details: Record<string, unknown> = {
      matchedCandidates: matchedCandidates.length,
      selected: {
        branchName: cleanDisplay(selected.branchName),
        repoName: cleanDisplay(selected.repoName),
        worktreePath: cleanDisplay(workspacePath),
      },
      skippedCandidates: discovery.skippedCount,
      totalCandidates: scopedCandidates.length,
      workspace: { mode: context.mode },
    };
    const renderHandoff = (
      result: T3HandoffResult | undefined,
      recovery: Record<string, unknown> = {},
      code?: string,
    ) => {
      const savedIntent =
        typeof recovery.blockingIntentId === "string" ? recovery.blockingIntentId : intentId;
      const output = switchT3Output(result, savedIntent, t3Request.permission);
      const unknownBlockingIntent =
        !result &&
        Boolean(code && /^T3_(?:HANDOFF_LOCKED|UNRESOLVED_HANDOFF|RECEIPT_|LOCK_)/u.test(code));
      if (!result && code === "T3_HANDOFF_LOCKED") {
        output.retry.guidance =
          "Preserve the shared lock. Confirm its owner has stopped and reconcile saved native evidence before manual lock removal; do not bypass it with another intent.";
      } else if (!result && code && /^T3_(?:UNRESOLVED_HANDOFF|RECEIPT_|LOCK_)/u.test(code)) {
        output.retry.guidance =
          "Preserve the blocking receipt/lock and reconcile its original recovery state before another handoff. Do not bypass it with a fresh intent.";
      }
      const child = workspace.repositories.some(
        (repository) =>
          repository.name === selected.repoName &&
          resolve(repository.path) !== resolve(workspaceRoot),
      );
      const scopeHint =
        context.mode === "standalone"
          ? ""
          : child
            ? " Keep --repos or --all for this child target."
            : "";
      const intentHint = unknownBlockingIntent
        ? "Recover the original saved handoff using its original command and intent before retrying the requested handoff."
        : `Keep --t3-intent ${savedIntent}.`;
      output.retry.guidance += ` Exact checkout: ${cleanDisplay(workspacePath)}; select it with --path.${scopeHint} ${intentHint} Reuse the original inline --t3 task or UTF-8 --prompt-file bytes in environment ${output.environment.id ?? "not yet verified"}. Retries reconcile saved evidence; an uncertain submission is never resent.`;
      if (!output.receiptPath && typeof recovery.receiptPath === "string") {
        output.receiptPath = recovery.receiptPath;
      }
      if (output.receiptPath) output.retry.guidance += ` Receipt: ${output.receiptPath}.`;
      if (typeof recovery.lockPath === "string") {
        output.retry.guidance += ` Lock: ${recovery.lockPath}.`;
      }
      return output;
    };
    let handoff: T3HandoffResult | undefined;
    let savedResult: T3HandoffResult | undefined;
    try {
      await revalidateSwitchGitIdentity(workspacePath, identity, selected.branchName);
      const admission = await switchT3PinnedSettings(workspacePath, intentId, deps.t3, {
        branch: selected.branchName,
        explicitSettings,
        promptDigest: t3Request.promptDigest,
        repository: selected.repoName,
      });
      savedResult = admission?.result;
      const environment = await preflightT3Native(
        workspacePath,
        deps.t3,
        admission?.settings ?? settings,
      );
      await revalidateSwitchGitIdentity(workspacePath, identity, selected.branchName);
      handoff = await (deps.dispatchT3Handoff ?? dispatchT3Handoff)({
        branch: selected.branchName,
        dependencies: deps.t3,
        dryRun: false,
        environment,
        request: t3Request,
        switch: {
          command: "switch",
          intentId,
          explicitSettings,
          provenance,
          selectedGitIdentity: identity,
          repository: selected.repoName,
        },
        workspacePath,
      });
    } catch (error) {
      const normalizedError = safeSwitchT3Error(error);
      handoff =
        (normalizedError instanceof T3HandoffError ? normalizedError.result : undefined) ??
        savedResult;
      if (normalizedError instanceof T3HandoffError) {
        const recovery = switchT3RecoveryDetails(normalizedError.details);
        Object.assign(details, recovery);
        details.t3Handoff = renderHandoff(handoff, recovery, normalizedError.code);
        throw new T3HandoffError(normalizedError.code, normalizedError.message, details, handoff);
      }
      throw normalizedError;
    }
    details.t3Handoff = renderHandoff(handoff);
    if (options.json) {
      writeJsonEnvelope(createJsonSuccessEnvelope("switch", details));
      return SUCCESS_EXIT_CODE;
    }
    const output = details.t3Handoff as ReturnType<typeof switchT3Output>;
    success(
      `T3 task accepted for ${cleanDisplay(selected.branchName)} in repository ${cleanDisplay(selected.repoName)} at ${cleanDisplay(workspacePath)}`,
    );
    info(
      `Permission: ${output.permission}; intent: ${intentId}; environment: ${output.environment.id ?? "unknown"}; project: ${output.project.id ?? "unknown"}; thread: ${output.thread.id ?? "unknown"}; message: ${output.native?.messageId ?? "unknown"}`,
    );
    info(output.retry.guidance);
    return SUCCESS_EXIT_CODE;
  }

  const commandEnv = deps.env ?? process.env;
  const directiveContext = getDirectiveContext(commandEnv);
  const resolution = resolveSwitchResolution({
    configMode:
      (deps.loadWorkspaceRepositories === undefined &&
      deps.findWorkspaceRoot === undefined &&
      context.mode !== "unavailable" &&
      context.effective?.sources["defaults.switch.mode"] !== "built-in"
        ? context.config.defaults?.switch?.mode
        : undefined) ?? workspace.config?.defaults?.switch?.mode,
    managedContextActive: detectManagedSwitchContext(commandEnv) !== null,
    options,
    shellIntegrationActive: directiveContext !== null,
  });
  const { behavior: resolvedBehavior, launch: resolvedLaunch } = resolution;

  if (resolvedBehavior.mode === CD_SWITCH_MODE && directiveContext) {
    await writeCdDirective(directiveContext, selected.worktreePath);
    success(`Prepared shell directory switch to ${formatSwitchTarget(selected)}`);

    return {
      launchMode: "cd",
      matchedCandidates: matchedCandidates.length,
      selected,
      skippedCandidates: discovery.skippedCount,
      totalCandidates: scopedCandidates.length,
    };
  }

  if (resolvedBehavior.warnOnMissingIntegration && !directiveContext) {
    warn(
      "Shell integration is not active, so `aw switch` cannot change the current shell directory for this invocation.",
    );
    info(
      "Hint: run `aw shell install`, restart your shell, and invoke `aw` through the installed wrapper.",
    );

    if (resolvedBehavior.skipLaunchWhenUnavailable) {
      return {
        launchMode: "cd",
        matchedCandidates: matchedCandidates.length,
        selected,
        skippedCandidates: discovery.skippedCount,
        totalCandidates: scopedCandidates.length,
      };
    }
  }

  const launchResult = await launchCandidate(selected, resolvedLaunch, {
    env: commandEnv,
    homeDirectory: deps.homeDirectory,
    pathExists: deps.pathExists,
    platform: deps.platform ?? process.platform,
    runProcess: deps.runProcess,
  });

  success(`Opened ${launchResult.mode} context for ${formatSwitchTarget(selected)}`);

  return {
    launchMode: launchResult.mode,
    matchedCandidates: matchedCandidates.length,
    selected,
    skippedCandidates: discovery.skippedCount,
    totalCandidates: scopedCandidates.length,
  };
}

const handleSwitchError = (error: unknown): never => {
  if (error instanceof SwitchCommandError) {
    if (error.code === SwitchCommandErrorCode.USER_CANCELLED) {
      info("Switch cancelled.");
      process.exit(SUCCESS_EXIT_CODE);
    }

    logError(error.message);

    if (error.code === SwitchCommandErrorCode.AMBIGUOUS_NON_INTERACTIVE) {
      info("Hint: provide a more specific filter, e.g. `aw switch feature-auth`.");
      process.exit(USAGE_EXIT_CODE);
    }

    if (error.code === SwitchCommandErrorCode.NO_TARGETS) {
      info("Hint: create a worktree first with `aw create <branch>`.");
      process.exit(USAGE_EXIT_CODE);
    }

    if (error.code === SwitchCommandErrorCode.NO_MATCHES) {
      info("Hint: run `aw list` to see available worktree paths and branches.");
      process.exit(USAGE_EXIT_CODE);
    }

    if (
      error.code === SwitchCommandErrorCode.CONFLICTING_LAUNCH_OPTIONS ||
      error.code === SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS ||
      error.code === SwitchCommandErrorCode.TMUX_CONTEXT_REQUIRED ||
      error.code === SwitchCommandErrorCode.SESH_REQUIRES_TMUX ||
      error.code === SwitchCommandErrorCode.SESH_NOT_FOUND ||
      error.code === SwitchCommandErrorCode.IDE_NOT_FOUND
    ) {
      process.exit(USAGE_EXIT_CODE);
    }

    process.exit(ERROR_EXIT_CODE);
  }

  logError(error instanceof Error ? error.message : String(error));
  if (error instanceof T3HandoffError) {
    if (
      typeof error.details.requestedIntentId === "string" &&
      typeof error.details.blockingIntentId === "string"
    ) {
      info(
        `Requested intent: ${cleanDisplay(error.details.requestedIntentId)}; blocking intent: ${cleanDisplay(error.details.blockingIntentId)}. Recover the blocking intent first.`,
      );
    }
    const selected = error.details.selected as
      | { branchName?: string; repoName?: string; worktreePath?: string }
      | undefined;
    if (selected) {
      info(
        `Selected ${cleanDisplay(selected.branchName ?? "unknown")} in repository ${cleanDisplay(selected.repoName ?? "unknown")} at ${cleanDisplay(selected.worktreePath ?? "unknown")}`,
      );
    }
    const handoff = error.details.t3Handoff as ReturnType<typeof switchT3Output> | undefined;
    if (handoff) {
      info(
        `Permission: ${handoff.permission}; intent: ${handoff.intentId}; environment: ${handoff.environment.id ?? handoff.native?.environmentId ?? "unknown"}; project: ${handoff.project.id ?? handoff.native?.projectId ?? "unknown"}; thread: ${handoff.thread.id ?? handoff.native?.threadId ?? "unknown"}; message: ${handoff.native?.messageId ?? "unknown"}`,
      );
      info(handoff.retry.guidance);
    }
  }
  process.exit(error instanceof T3HandoffError ? switchT3ExitCode(error) : ERROR_EXIT_CODE);
};

const resolveSwitchScope = (options: SwitchCommandOptions): SwitchRepositoryScope => {
  if (options.all) {
    return "all";
  }

  if (options.repos) {
    return "repos";
  }

  return "parent";
};

const filterRepositoriesByScope = (
  scope: SwitchRepositoryScope,
  workspaceRoot: string,
  repositories: WorkspaceRepository[],
): WorkspaceRepository[] => {
  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  const parentRepositories = repositories.filter(
    (repo) => resolve(repo.path) === normalizedWorkspaceRoot,
  );
  const childRepositories = repositories.filter(
    (repo) => resolve(repo.path) !== normalizedWorkspaceRoot,
  );

  if (scope === "all") {
    return [...repositories];
  }

  if (scope === "repos") {
    return childRepositories;
  }

  if (parentRepositories.length > ZERO) {
    return parentRepositories;
  }

  if (repositories.length > ZERO) {
    return [repositories[ZERO]];
  }

  return [];
};

const getNoTargetsMessage = (scope: SwitchRepositoryScope): string => {
  if (scope === "repos") {
    return "No switch targets were found for child repositories in the current workspace. Try `aw switch --all` to include all worktrees.";
  }

  if (scope === "parent") {
    return "No switch targets were found in the parent repository. Use `aw switch --repos` or `aw switch --all` to broaden the search.";
  }

  return "No switch targets were found in this workspace.";
};

const filterCandidatesByScope = (
  scope: SwitchRepositoryScope,
  workspaceRoot: string,
  candidates: SwitchCandidate[],
): SwitchCandidate[] => {
  if (scope !== "repos") {
    return candidates;
  }

  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  const workspacePrefix = `${normalizedWorkspaceRoot}${sep}`;

  return candidates.filter((candidate) => {
    const candidatePath = resolve(candidate.worktreePath);
    return candidatePath === normalizedWorkspaceRoot || candidatePath.startsWith(workspacePrefix);
  });
};

const augmentAllScopeCandidates = async (
  candidates: SwitchCandidate[],
  options: {
    workspaceRoot: string;
    reposDir: string;
    repositories: WorkspaceRepository[];
  },
): Promise<SwitchCandidate[]> => {
  const normalizedWorkspaceRoot = resolve(options.workspaceRoot);
  const parentRepoName = basename(normalizedWorkspaceRoot);
  const parentCandidates = candidates.filter((candidate) => candidate.repoName === parentRepoName);
  const childRepositories = options.repositories.filter(
    (repo) => resolve(repo.path) !== normalizedWorkspaceRoot,
  );

  if (parentCandidates.length === ZERO || childRepositories.length === ZERO) {
    return candidates;
  }

  const merged = [...candidates];
  const seen = new Set<string>(
    candidates.map((candidate) => `${candidate.repoName}${KEY_SEPARATOR}${candidate.worktreePath}`),
  );

  for (const parentCandidate of parentCandidates) {
    for (const childRepository of childRepositories) {
      const childWorktreePath = resolve(
        parentCandidate.worktreePath,
        options.reposDir,
        childRepository.name,
      );

      if (!(await runtime.file(resolve(childWorktreePath, ".git")).exists())) {
        continue;
      }

      const branchName = await getBranchName(childWorktreePath);
      if (!branchName) {
        continue;
      }

      const candidate: SwitchCandidate = {
        branchName,
        repoName: childRepository.name,
        worktreePath: childWorktreePath,
      };
      const key = `${candidate.repoName}${KEY_SEPARATOR}${candidate.worktreePath}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(candidate);
    }
  }

  return merged;
};

const getBranchName = async (repoPath: string): Promise<string | null> => {
  try {
    const result = await exec(["rev-parse", "--abbrev-ref", DETACHED_HEAD], repoPath);
    const branchName = result.stdout.trim();
    if (!branchName || branchName === DETACHED_HEAD) {
      return null;
    }
    return branchName;
  } catch {
    return null;
  }
};

const filterRepoScopedCandidates = (
  candidates: SwitchCandidate[],
  filter: string | undefined,
): SwitchCandidate[] => {
  if (!filter || filter.trim().length === ZERO) {
    return [...candidates];
  }

  const query = filter.trim().toLowerCase();

  const exactMatches = candidates.filter((candidate) => candidate.repoName.toLowerCase() === query);
  if (exactMatches.length > ZERO) {
    return exactMatches;
  }

  const partialRepoNames = [
    ...new Set(
      candidates
        .map((candidate) => candidate.repoName)
        .filter((repoName) => repoName.toLowerCase().includes(query)),
    ),
  ];

  if (partialRepoNames.length === ONE) {
    const partialRepoName = partialRepoNames[ZERO];
    return candidates.filter((candidate) => candidate.repoName === partialRepoName);
  }

  if (partialRepoNames.length > ONE) {
    const partialRepoSet = new Set(partialRepoNames);
    return candidates.filter((candidate) => partialRepoSet.has(candidate.repoName));
  }

  return [];
};

const filterSwitchCandidatesByExactPath = (
  candidates: SwitchCandidate[],
  filter: string | undefined,
): SwitchCandidate[] => {
  if (!filter || filter.trim().length === ZERO) {
    return [];
  }

  const normalizedPath = resolve(filter.trim());
  return candidates.filter((candidate) => resolve(candidate.worktreePath) === normalizedPath);
};

const buildRepoNoMatchMessage = (
  candidates: SwitchCandidate[],
  filter: string | undefined,
): string => {
  const availableRepos = [...new Set(candidates.map((candidate) => candidate.repoName))];
  availableRepos.sort();

  let availableReposText = "(no child repositories found)";
  if (availableRepos.length > ZERO) {
    availableReposText = availableRepos.join(", ");
  }

  if (!filter || filter.trim().length === ZERO) {
    return `No child repository matches were found. Available repositories: ${availableReposText}`;
  }

  return `No child repository matched \`${filter}\`. Available repositories: ${availableReposText}`;
};

const buildPathNoMatchMessage = (filter: string | undefined): string => {
  if (!filter || filter.trim().length === ZERO) {
    return "Exact path mode requires a worktree path. Run `aw switch --path <worktree-path>`.";
  }

  return `No worktree exists at exact path \`${resolve(filter.trim())}\`. Run \`aw list\` to see available worktree paths.`;
};

const validateSwitchOptions = (options: SwitchCommandOptions): void => {
  if (t3Enabled(options)) {
    if (
      options.cd === true ||
      hasLegacyNoCd(options) ||
      ["launch", "tab", "tmux", "sesh", "herdr", "vscode", "cursor", "kiro"].some(
        (key) => options[key as keyof SwitchCommandOptions] === true,
      )
    ) {
      throw new SwitchCommandError(
        "--t3 conflicts with explicit launch/CD actions.",
        SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS,
      );
    }
    validateSwitchT3Intent(options.t3Intent ?? "default");
  } else if (
    [
      "promptFile",
      "permission",
      "t3BaseDir",
      "t3Cli",
      "t3Provider",
      "t3Model",
      "t3Effort",
      "t3Intent",
    ].some((key) => options[key as keyof SwitchCommandOptions] !== undefined)
  ) {
    throw new T3HandoffError("T3_OPTIONS_REQUIRE_T3", "T3-only options require explicit --t3.");
  }
  if (t3Enabled(options) && options.repos && options.all) {
    throw new SwitchCommandError(
      "Conflicting repository scopes: choose --repos or --all.",
      SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS,
    );
  }
  const explicitLauncher = resolveExplicitLauncher(options);
  const hasLaunchIntent = Boolean(
    options.launch === true || hasLegacyNoCd(options) || options.tab === true || explicitLauncher,
  );
  if (options.cd === true && hasLaunchIntent) {
    throw new SwitchCommandError(
      "Conflicting switch behavior overrides provided (--cd with an explicit launch override). Choose either parent-shell switching or a launch target.",
      SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS,
    );
  }
};

const emitSwitchDeprecationWarnings = (options: SwitchCommandOptions): void => {
  if (hasLegacyNoCd(options)) {
    warn("--no-cd is deprecated; use --launch instead.");
  }
  if (hasLegacyNoDefaultLaunch(options)) {
    warn("--no-default-launch is deprecated; use --ignore-configured-launcher instead.");
  }
};

const hasLegacyNoCd = (options: SwitchCommandOptions): boolean =>
  options.legacyNoCd === true || options.cd === false;

const hasLegacyNoDefaultLaunch = (options: SwitchCommandOptions): boolean =>
  options.legacyNoDefaultLaunch === true || options.defaultLaunch === false;

export const resolveSwitchResolution = ({
  configMode,
  managedContextActive,
  options,
  shellIntegrationActive,
}: SwitchResolutionInput): SwitchResolution => {
  validateSwitchOptions(options);
  const explicitLauncher = resolveExplicitLauncher(options);
  const hasLaunchIntent = options.launch === true || hasLegacyNoCd(options);
  const ignoreConfiguredLauncher =
    options.ignoreConfiguredLauncher === true || hasLegacyNoDefaultLaunch(options);

  const configLaunchMode: LaunchMode | undefined =
    configMode === SESH_LAUNCH_MODE || configMode === HERDR_LAUNCH_MODE ? configMode : undefined;
  const configBehaviorMode: SwitchBehaviorMode | undefined =
    configMode === SESH_LAUNCH_MODE || configMode === HERDR_LAUNCH_MODE
      ? LAUNCH_SWITCH_MODE
      : configMode;

  return {
    behavior: resolveSwitchBehavior({
      configMode: configBehaviorMode,
      hasExplicitLaunchOverride:
        explicitLauncher !== undefined || options.tab === true || hasLaunchIntent,
      managedContextActive,
      options,
      shellIntegrationActive,
    }),
    launch: resolveLaunchOptions(
      options,
      configLaunchMode,
      explicitLauncher,
      ignoreConfiguredLauncher,
    ),
  };
};

const resolveLaunchOptions = (
  options: SwitchCommandOptions,
  configLaunchMode: LaunchMode | undefined,
  explicitLauncher: SupportedIde | "tmux" | "sesh" | "herdr" | undefined,
  ignoreConfiguredLauncher: boolean,
): LaunchResolution => {
  const disposition: LaunchDisposition = options.tab === true ? "tab" : "window";
  if (explicitLauncher === "tmux") {
    return { disposition, tmux: true };
  }
  if (explicitLauncher === HERDR_LAUNCH_MODE) {
    return { disposition, herdr: true, sesh: false };
  }
  if (explicitLauncher && explicitLauncher !== SESH_LAUNCH_MODE) {
    return {
      disposition,
      preferredIde: explicitLauncher,
      requirePreferredIde: true,
      sesh: false,
    };
  }

  const resolvedLaunchMode = resolveDefaultWithPrecedence<LaunchMode>({
    builtInValue: AUTO_LAUNCH_MODE,
    configValue: configLaunchMode,
    explicitValue: SESH_LAUNCH_MODE,
    hasExplicitValue: explicitLauncher === SESH_LAUNCH_MODE,
    optOut: ignoreConfiguredLauncher || options.tab === true,
  });

  if (resolvedLaunchMode.value === HERDR_LAUNCH_MODE) {
    return { disposition, herdr: true, sesh: false };
  }

  return { disposition, sesh: resolvedLaunchMode.value === SESH_LAUNCH_MODE };
};

const resolveSwitchBehavior = ({
  configMode,
  hasExplicitLaunchOverride,
  managedContextActive,
  options,
  shellIntegrationActive,
}: SwitchBehaviorInput): SwitchBehaviorResolution => {
  if (hasExplicitLaunchOverride) {
    return {
      mode: LAUNCH_SWITCH_MODE,
      skipLaunchWhenUnavailable: false,
      warnOnMissingIntegration: false,
    };
  }

  if (options.cd === true) {
    return {
      mode: CD_SWITCH_MODE,
      skipLaunchWhenUnavailable: true,
      warnOnMissingIntegration: true,
    };
  }

  if (options.cd === false) {
    return {
      mode: LAUNCH_SWITCH_MODE,
      skipLaunchWhenUnavailable: false,
      warnOnMissingIntegration: false,
    };
  }

  const mode = configMode ?? LAUNCH_SWITCH_MODE;
  if (mode === AUTO_SWITCH_MODE) {
    return {
      mode: managedContextActive || !shellIntegrationActive ? LAUNCH_SWITCH_MODE : CD_SWITCH_MODE,
      skipLaunchWhenUnavailable: false,
      warnOnMissingIntegration: false,
    };
  }

  return {
    mode,
    skipLaunchWhenUnavailable: false,
    warnOnMissingIntegration: mode === CD_SWITCH_MODE,
  };
};

const resolveExplicitLauncher = (
  options: SwitchCommandOptions,
): SupportedIde | "tmux" | "sesh" | "herdr" | undefined => {
  const launchOverrides = [
    options.tmux === true ? "tmux" : null,
    options.herdr === true ? "herdr" : null,
    options.sesh === true ? "sesh" : null,
    options.vscode === true ? "vscode" : null,
    options.cursor === true ? "cursor" : null,
    options.kiro === true ? "kiro" : null,
  ].filter((value): value is "tmux" | "sesh" | "herdr" | SupportedIde => value !== null);

  if (launchOverrides.length > ONE) {
    throw new SwitchCommandError(
      `Conflicting launch overrides provided (${launchOverrides.map((value) => `--${value}`).join(", ")}). Choose exactly one explicit switch mode.`,
      SwitchCommandErrorCode.CONFLICTING_LAUNCH_OPTIONS,
      { launchOverrides },
    );
  }

  return launchOverrides[ZERO];
};

const t3Enabled = (options: SwitchCommandOptions) =>
  options.t3 !== undefined && options.t3 !== false;
const cleanDisplay = (value: string) =>
  value.replaceAll(/\p{Cc}\[[0-9;]*[A-Za-z]/gu, "").replaceAll(/\p{Cc}/gu, "");
function switchT3RecoveryDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ["blockingIntentId", "requestedIntentId", "receiptPath", "lockPath"]) {
    if (typeof details[key] === "string") safe[key] = cleanDisplay(details[key]);
  }
  for (const key of ["lockCleanupFailed", "receiptWriteFailed"]) {
    if (typeof details[key] === "boolean") safe[key] = details[key];
  }
  return safe;
}
function safeSwitchContext(context: Record<string, unknown> | undefined) {
  if (!context) return undefined;
  const safe: Record<string, unknown> = {};
  for (const key of ["filter", "scope", "workspaceRoot"]) {
    if (typeof context[key] === "string") safe[key] = cleanDisplay(context[key]);
  }
  if (typeof context.pathMode === "boolean") safe.pathMode = context.pathMode;
  if (typeof context.matchCount === "number") safe.matchCount = context.matchCount;
  if (Array.isArray(context.launchOverrides)) {
    safe.launchOverrides = context.launchOverrides
      .filter((value): value is string => typeof value === "string")
      .map(cleanDisplay);
  }
  if (Array.isArray(context.candidates)) {
    safe.candidates = context.candidates.map((candidate: unknown) => {
      const value =
        candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
      const choice: Record<string, string> = {};
      for (const key of ["branchName", "repoName", "worktreePath"]) {
        if (typeof value[key] === "string") {
          choice[key] = cleanDisplay(value[key]);
        }
      }
      return choice;
    });
  }
  return safe;
}
const switchT3ExitCode = (error: unknown): number => {
  if (!(error instanceof T3HandoffError)) return USAGE_EXIT_CODE;
  if (error.result?.status === "succeeded") return ERROR_EXIT_CODE;
  const inputError =
    /^T3_(?:PROMPT|PERMISSION|CONFIG)_/u.test(error.code) ||
    ["T3_OPTIONS_INVALID", "T3_OPTIONS_REQUIRE_T3", "T3_INTENT_INVALID"].includes(error.code);
  return inputError ? USAGE_EXIT_CODE : ERROR_EXIT_CODE;
};
const safeSwitchT3Error = (error: unknown): Error => {
  if (error instanceof ConfigError) {
    return new T3HandoffError(
      "T3_CONFIG_INVALID",
      "Applicable workspace or user configuration is invalid. Repair it before handoff.",
    );
  }
  if (error instanceof SwitchCommandError) {
    return new SwitchCommandError(
      cleanDisplay(error.message),
      error.code,
      safeSwitchContext(error.context),
    );
  }
  if (error instanceof T3HandoffError) {
    return new T3HandoffError(
      error.code,
      cleanDisplay(error.message),
      error.details,
      error.result ? sanitizedHandoff(error.result) : undefined,
    );
  }
  return new T3HandoffError(
    "T3_HANDOFF_FAILED",
    "Native T3 handoff failed. Preserve receipts and reconcile saved IDs before retrying.",
  );
};
function sanitizedHandoff(result: T3HandoffResult): T3HandoffResult {
  const clean = (value: string | null | undefined) =>
    typeof value === "string" ? cleanDisplay(value) : null;
  return {
    adapter: result.adapter,
    adapterVersion: result.adapterVersion,
    dispatch: { status: result.dispatch.status },
    environment: {
      id: clean(result.environment?.id),
      serverVersion: clean(result.environment?.serverVersion),
    },
    permission: result.permission,
    project: {
      id: clean(result.project?.id),
      title: null,
      created: result.project?.created ?? null,
    },
    promptDigest: "",
    receiptPath: clean(result.receiptPath),
    retry: {
      safe: false,
      guidance:
        result.dispatch.status === "succeeded"
          ? "Task accepted. Manually select the reported native project/thread; no UI opened. Preserve acceptance and saved IDs; retries reconcile acceptance without resubmitting."
          : result.native?.phase === "preparing"
            ? "Reconcile saved preparation IDs using official project/thread evidence. Same-intent preparation may continue only after positive evidence permits it; never bypass uncertainty with a fresh intent."
            : "Retry only for read-only reconciliation of the saved user message in the original environment. An uncertain submission is never resent; never bypass it with a fresh intent.",
    },
    status: result.status,
    thread: { id: clean(result.thread?.id), title: null },
    ui: { mode: "none", kind: "none", exactThread: false, status: "skipped" },
    workspacePath: cleanDisplay(result.workspacePath),
    ...(result.native
      ? {
          native: {
            environmentId: cleanDisplay(result.native.environmentId),
            messageId: cleanDisplay(result.native.messageId),
            phase: result.native.phase,
            projectId: cleanDisplay(result.native.projectId),
            threadId: cleanDisplay(result.native.threadId),
          },
        }
      : {}),
    ...(result.selection
      ? {
          selection: {
            instanceId: cleanDisplay(result.selection.instanceId),
            model: cleanDisplay(result.selection.model),
            options: result.selection.options.map((option) => ({
              id: cleanDisplay(option.id),
              value: typeof option.value === "string" ? cleanDisplay(option.value) : option.value,
            })),
          },
        }
      : {}),
  };
}
function switchT3Output(
  result: T3HandoffResult | undefined,
  intentId: string,
  permission: T3PermissionMode,
) {
  const safe = result
    ? sanitizedHandoff(result)
    : {
        dispatch: { status: "failed" },
        environment: { id: null, serverVersion: null },
        native: undefined,
        permission,
        project: { id: null, title: null, created: null },
        receiptPath: null,
        retry: {
          safe: false,
          guidance:
            "Resolve the native prerequisite for this exact checkout and saved intent; no task was submitted.",
        },
        status: "failed",
        thread: { id: null, title: null },
        ui: { mode: "none", status: "skipped" },
        workspacePath: "",
      };
  const { promptDigest: _digest, ...output } = { ...safe, promptDigest: "" };
  return { ...output, intentId };
}
