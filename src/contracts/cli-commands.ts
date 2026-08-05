import type { Command } from "commander";
import { discoverCommandPaths } from "../cli-program.ts";

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
}
export type CommandSemantics = Record<string, CommandSemanticMetadata>;

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
  add: standard(
    { support: "full" },
    configuredOnly("Adding child repositories requires persisted configuration."),
  ),
  clone: standard(
    undefined,
    configuredOnly("Cloning configured child repositories requires persisted configuration."),
  ),
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
        overrides: ["--no-launch", "--no-switch"],
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
          "--kiro",
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
        compatibleOptions: ["--no-cd", "--no-default-launch"],
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

export interface CliCommandContract {
  schemaVersion: 4;
  commands: ContractCommand[];
}
interface ContractCommand {
  path: string;
  description: string;
  aliases: string[];
  hidden: boolean;
  arguments: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  options: Array<{
    flags: string;
    description: string;
    required: boolean;
    optional: boolean;
    variadic: boolean;
  }>;
  semantics: CommandSemanticMetadata;
}

export function generateCommandContract(
  program: Command,
  metadata: CommandSemantics,
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
  const errors = validateCommandSemantics(paths, metadata, registeredOptions);
  if (errors.length) throw new Error(`Invalid CLI command semantics:\n${errors.join("\n")}`);
  const commands: ContractCommand[] = [];
  const visit = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      commands.push({
        path,
        description: command.description(),
        aliases: command.aliases().toSorted(),
        hidden: Boolean((command as Command & { _hidden?: boolean })._hidden),
        arguments: command.registeredArguments.map((argument) => ({
          name: argument.name(),
          required: argument.required,
          variadic: argument.variadic,
          description: argument.description,
        })),
        options: command.options
          .map((option) => ({
            flags: option.flags,
            description: option.description,
            required: option.required,
            optional: option.optional,
            variadic: option.variadic,
          }))
          .toSorted((a, b) => a.flags.localeCompare(b.flags)),
        semantics: metadata[path]!,
      });
      visit(command, path);
    }
  };
  visit(program, "");
  return {
    schemaVersion: 4,
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
