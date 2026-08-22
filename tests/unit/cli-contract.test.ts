import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import pkg from "../../package.json";
import { buildProgram, discoverCommandPaths } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
  repositoryBasePolicy,
  serializeCommandContract,
  validateCommandSemantics,
  validateOptionAudit,
  validateOptionSemanticPolicy,
} from "../../src/contracts/cli-commands.ts";

const expectedPaths = [
  "add",
  "clone",
  "completion",
  "completion __query",
  "create",
  "doctor",
  "exec",
  "handoff",
  "init",
  "install",
  "list",
  "move",
  "prune",
  "pull",
  "push",
  "remove",
  "setup",
  "shell",
  "shell init",
  "shell install",
  "status",
  "switch",
  "sync",
  "update",
];

const selectorFixturePolicy = (
  kind: "repository" | "group",
  counterpart: "--only" | "--group",
) => ({
  ownership: "command" as const,
  persisted: false as const,
  selector: {
    accepts: ["repeated", "comma-separated", "mixed"] as string[],
    blankSegments: "ignored-beside-values",
    combination: { empty: "error", mode: "intersection", with: counterpart },
    deduplicate: "first-occurrence",
    explicitEmpty: "error",
    flatten: "encounter-order",
    kind,
    omitted: "default-selection",
    standalone: "configured-only",
    supplied: "distinct-from-omitted",
    trim: true,
    unknown: "error",
    validationPrecedence: "before-repository-work",
  },
});

const createBaseFixturePolicy = {
  ownership: "command" as const,
  persisted: false as const,
  repositoryBase: repositoryBasePolicy,
};

describe("CLI command contract", () => {
  test("constructs a fresh reusable program without parsing or process side effects", () => {
    const first = buildProgram({ includeHelpBanner: false });
    const second = buildProgram({ includeHelpBanner: false });
    expect(first).toBeInstanceOf(Command);
    expect(second).not.toBe(first);
    expect(first.name()).toBe("arashi");
    expect(first.version()).toBe(pkg.version);
  });

  test("discovers every registered command path exactly", () => {
    expect(discoverCommandPaths(buildProgram({ includeHelpBanner: false }))).toEqual(expectedPaths);
  });

  test("requires complete, non-stale semantic metadata", () => {
    const paths = discoverCommandPaths(buildProgram({ includeHelpBanner: false }));
    expect(validateCommandSemantics(paths, commandSemantics)).toEqual([]);
    expect(
      validateCommandSemantics(paths, { ...commandSemantics, stale: commandSemantics.add }),
    ).toContain('Semantic metadata references unregistered command path "stale"');
    const { add: _add, ...missing } = commandSemantics;
    expect(validateCommandSemantics(paths, missing)).toContain(
      'Missing semantic metadata for command path "add"',
    );
  });

  test("requires reasons for conditional JSON and non-required companion policies", () => {
    const invalid = structuredClone(commandSemantics);
    invalid.create.json = { support: "conditional", reason: "" };
    invalid.install.docs = { expectation: "excluded", reason: "" };
    expect(validateCommandSemantics(expectedPaths, invalid)).toEqual([
      'Command "create" conditional JSON support requires a reason',
      'Command "install" docs exclusion requires a reason',
    ]);
  });

  test("classifies standalone support and configured-only boundaries", () => {
    expect(commandSemantics.create.standalone).toEqual({ support: "full" });
    expect(commandSemantics.move.standalone).toEqual({ support: "full" });
    expect(commandSemantics.init.standalone.support).toBe("conditional");
    for (const command of ["add", "clone", "exec", "pull", "push", "setup", "sync"] as const) {
      expect(commandSemantics[command].standalone.support).toBe("configured-only");
      expect(commandSemantics[command].standalone).toHaveProperty("reason");
    }
  });

  test("publishes add materialization and result-role policy", () => {
    expect(commandSemantics.add).toMatchObject({
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
    });
  });

  test("publishes optional-user SSH alias syntax in add help and generated contract", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const add = program.commands.find((command) => command.name() === "add");
    expect(add?.helpInformation()).toContain("[user@]host:path");
    expect(add?.helpInformation()).toContain("ssh://[user@]host/path");

    const contract = generateCommandContract(program, commandSemantics, optionAuditPolicies);
    const addArgument = contract.commands.find((command) => command.path === "add")?.arguments[0];
    expect(addArgument?.description).toContain("[user@]host:path");
    expect(addArgument?.description).toContain("ssh://[user@]host/path");
  });

  test("publishes the complete optional add-onboarding contract and practical filesystem safety guidance", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const add = program.commands.find((command) => command.name() === "add");
    const help = (add?.helpInformation() ?? "").replaceAll(/\s+/g, " ");
    expect(help).toContain("optional repository worktree setup");
    expect(help).toContain("TTY");
    expect(help).toContain("--json and --force suppress setup");

    const contract = generateCommandContract(program, commandSemantics, optionAuditPolicies);
    expect(
      contract.commands.find((command) => command.path === "add")?.semantics.addOnboarding,
    ).toEqual({
      activeFiles: {
        createOwner: "active-config-root",
        removeOwner: "runtime-resolved-target-repository",
        safeNoOp: true,
        executableReady: true,
        noOverwrite: true,
      },
      cancellation: { finalDeclineAndInterrupt: "rollback", topLevelDecline: "minimal-success" },
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
    });

    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain(
      "`aw add` walks you through repository configuration and hook initialization.",
    );
    expect(readme).not.toContain("Pure Node/Bun");
    expect(readme).not.toContain("Rust");
  });

  test("publishes enforceable init zero-config option and output policy", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    const init = contract.commands.find((command) => command.path === "init");

    expect(init?.semantics.zeroConfig).toEqual({
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
    });
  });

  test("publishes repository-aware init worktree defaults", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    const init = contract.commands.find((command) => command.path === "init");
    const worktreesOption = init?.options.find(
      (option) => option.flags === "--worktrees-dir <path>",
    );

    expect(worktreesOption?.description).toBe(
      "Custom worktree base (default: .. for bare repositories; .arashi/worktrees otherwise)",
    );
  });

  test("publishes enforceable explicit tmux option policies", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    const create = contract.commands.find((command) => command.path === "create");
    const switchCommand = contract.commands.find((command) => command.path === "switch");

    expect(create?.semantics.optionPolicies?.["--tmux"]).toEqual({
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
    });
    expect(switchCommand?.semantics.optionPolicies?.["--tmux"]).toEqual({
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
    });
  });

  test("publishes invocation-only hook input policy on exactly create and remove", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const owners = contract.commands
      .filter((command) => command.options.some((option) => option.long === "--no-hook-input"))
      .map((command) => command.path);

    expect(owners).toEqual(["create", "remove"]);
    for (const owner of owners) {
      const option = contract.commands
        .find((command) => command.path === owner)
        ?.options.find((candidate) => candidate.long === "--no-hook-input");
      expect(option?.semanticPolicy).toEqual({
        hookInput: {
          disabledMode: "disabled",
          immediateEof: true,
          jsonPrecedence: true,
          modes: ["tty", "disabled", "unavailable"],
          skipsHooks: false,
        },
        ownership: "command",
        persisted: false,
      });
    }

    const createHelp = buildProgram({ includeHelpBanner: false })
      .commands.find((command) => command.name() === "create")
      ?.helpInformation();
    expect(createHelp).toContain("--no-hook-input");
    expect(createHelp).toContain("--interactive");
    expect(createHelp).toContain("--no-hooks");
  });

  test("publishes only the canonical shared repository base policy for create --base", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const base = contract.commands
      .find((command) => command.path === "create")
      ?.options.find((option) => option.long === "--base");
    expect(base).toMatchObject({
      description: "Base branch to use when creating new target branches",
      flags: "--base <branch>",
      required: true,
      semanticPolicy: createBaseFixturePolicy,
      semanticPolicyOwner: "command",
      valueShape: "required",
    });
    expect(base?.semanticPolicy).toEqual(createBaseFixturePolicy);
  });

  test("publishes the shared repository base policy on create and clone options", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    for (const [commandPath, optionNames] of [
      ["create", ["--base", "--repo-base"]],
      ["clone", ["--base", "--repo-base"]],
    ] as const) {
      for (const optionName of optionNames) {
        const option = contract.commands
          .find((command) => command.path === commandPath)
          ?.options.find((candidate) => candidate.long === optionName);
        if (optionName === "--repo-base") expect(option?.repeatable).toBe(true);
        expect(option?.semanticPolicy).toMatchObject({
          repositoryBase: {
            configuration: {
              child: "repos.<name>.baseBranch",
              meta: "meta.baseBranch",
              workspace: "baseBranch",
            },
            precedence: [
              "repository-cli",
              "cli",
              "repository-config",
              "workspace-config",
              "legacy-omitted",
            ],
            sources: [
              "repository-cli",
              "cli",
              "repository-config",
              "workspace-config",
              "legacy-omitted",
            ],
            output: {
              cloneProperty: "base",
              createProperty: "base",
              fields: ["repositoryIdentity", "repositoryName", "requestedBranch", "source"],
              omitted: "all-legacy-omitted",
            },
          },
        });
      }
    }
  });

  test("serializes schema-v8 repository base policy deterministically with an exact shape", () => {
    const first = serializeCommandContract(
      generateCommandContract(
        buildProgram({ includeHelpBanner: false }),
        commandSemantics,
        optionAuditPolicies,
      ),
    );
    const second = serializeCommandContract(
      generateCommandContract(
        buildProgram({ includeHelpBanner: false }),
        commandSemantics,
        optionAuditPolicies,
      ),
    );
    const serialized = JSON.parse(first) as {
      schemaVersion: number;
      commands: Array<{
        path: string;
        options: Array<{ long: string; semanticPolicy?: unknown }>;
      }>;
    };

    expect(first).toBe(second);
    expect(serialized.schemaVersion).toBe(8);
    expect(
      serialized.commands
        .find((command) => command.path === "create")
        ?.options.find((option) => option.long === "--base")?.semanticPolicy,
    ).toEqual(createBaseFixturePolicy);
  });

  test("publishes real canonical switch compatibility policies", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const options = contract.commands.find((command) => command.path === "switch")?.options;

    expect(options?.find((option) => option.long === "--launch")?.semanticPolicy).toMatchObject({
      compatibility: {
        alternatives: ["--no-cd"],
        canonical: { option: "--launch" },
        deprecatedAlternatives: true,
        removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
      },
      conflicts: ["--cd"],
      implies: ["launch"],
      ownership: "command",
      persisted: false,
    });
    expect(
      options?.find((option) => option.long === "--ignore-configured-launcher")?.semanticPolicy,
    ).toMatchObject({
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
    });
  });

  test("publishes typed redundant handoff compatibility and removal policy", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const markdown = contract.commands
      .find((command) => command.path === "handoff")
      ?.options.find((option) => option.long === "--markdown");

    expect(markdown).toMatchObject({
      deprecated: true,
      hidden: true,
      semanticPolicy: {
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
      semanticPolicyOwner: "command",
    });
  });

  test("publishes reciprocal update inspection conflicts for human and JSON paths", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const options = contract.commands.find((command) => command.path === "update")?.options;
    expect(options?.find((option) => option.long === "--check")?.semanticPolicy).toEqual({
      conflicts: ["--dry-run"],
      inspection: { executionPaths: ["human", "json"] },
      ownership: "command",
    });
    expect(options?.find((option) => option.long === "--dry-run")?.semanticPolicy).toEqual({
      conflicts: ["--check"],
      inspection: { executionPaths: ["human", "json"] },
      ownership: "command",
    });
    expect(options?.find((option) => option.long === "--json")?.semanticPolicy).toEqual({
      jsonExecution: {
        apply: "unsupported",
        bare: "inspection-only",
        mutation: false,
        prompt: false,
      },
      ownership: "command",
    });
  });

  test("publishes the exact deterministic selector policy for every registered selector", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const standaloneByCommand = {
      create: "unsupported",
      exec: "configured-only",
      pull: "configured-only",
      push: "configured-only",
      setup: "configured-only",
      status: "unsupported",
      sync: "configured-only",
    } as const;
    const expectedRegistrations: string[] = [];

    for (const [path, standalone] of Object.entries(standaloneByCommand)) {
      const command = contract.commands.find((candidate) => candidate.path === path);
      for (const [optionName, kind, counterpart] of [
        ["--only", "repository", "--group"],
        ["--group", "group", "--only"],
      ] as const) {
        expectedRegistrations.push(`${path} ${optionName}`);
        expect(
          command?.options.find((option) => option.long === optionName)?.semanticPolicy,
          `${path} ${optionName}`,
        ).toEqual({
          ownership: "command",
          persisted: false,
          selector: {
            accepts: ["repeated", "comma-separated", "mixed"],
            blankSegments: "ignored-beside-values",
            combination: { empty: "error", mode: "intersection", with: counterpart },
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
      }
    }

    const actualRegistrations = contract.commands.flatMap((command) =>
      command.options
        .filter((option) => option.long === "--only" || option.long === "--group")
        .map((option) => `${command.path} ${option.long}`),
    );
    expect(actualRegistrations.toSorted()).toEqual(expectedRegistrations.toSorted());
  });

  test("publishes complete typed switch mode, interaction, and conflict policy", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const options = contract.commands.find((command) => command.path === "switch")?.options;
    const policyFor = (name: string) =>
      options?.find((option) => option.long === name)?.semanticPolicy;
    const launchInteractions = {
      explicitLauncher: { authoritative: true, compatible: true, noFallback: "preserved" },
      jsonGuardPrecedence: "before-option-and-conflict-validation",
      tab: { bypassesConfiguredDefaults: true, compatible: true, disposition: "tab" },
    } as const;

    expect(policyFor("--launch")?.switch).toEqual({
      configuredModeEffects: {
        auto: "launch",
        cd: "launch",
        herdr: "preserve-named-launcher",
        launch: "launch",
        sesh: "preserve-named-launcher",
      },
      ...launchInteractions,
    });
    expect(policyFor("--no-cd")?.switch).toEqual(policyFor("--launch")?.switch);
    expect(policyFor("--ignore-configured-launcher")?.switch).toEqual({
      configuredModeEffects: {
        auto: "preserve-configured-or-contextual-behavior",
        cd: "preserve-configured-or-contextual-behavior",
        herdr: "automatic-launch",
        launch: "preserve-configured-or-contextual-behavior",
        sesh: "automatic-launch",
      },
      ...launchInteractions,
    });
    expect(policyFor("--no-default-launch")?.switch).toEqual(
      policyFor("--ignore-configured-launcher")?.switch,
    );

    const expectedConflicts = {
      "--cd": [
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
      "--cursor": ["--cd", "--herdr", "--kiro", "--sesh", "--tmux", "--vscode"],
      "--herdr": ["--cd", "--cursor", "--kiro", "--sesh", "--tmux", "--vscode"],
      "--kiro": ["--cd", "--cursor", "--herdr", "--sesh", "--tmux", "--vscode"],
      "--launch": ["--cd"],
      "--no-cd": ["--cd"],
      "--sesh": ["--cd", "--cursor", "--herdr", "--kiro", "--tmux", "--vscode"],
      "--tab": ["--cd"],
      "--tmux": ["--cd", "--cursor", "--herdr", "--kiro", "--sesh", "--vscode"],
      "--vscode": ["--cd", "--cursor", "--herdr", "--kiro", "--sesh", "--tmux"],
    } as const;
    for (const [name, conflicts] of Object.entries(expectedConflicts)) {
      expect(policyFor(name), `${name} must publish switch policy`).toMatchObject({
        conflicts,
        ownership: "command",
        persisted: false,
      });
    }
    expect(policyFor("--ignore-configured-launcher")).toMatchObject({ conflicts: [] });
    expect(policyFor("--no-default-launch")).toMatchObject({ conflicts: [] });
    for (const name of ["--cursor", "--herdr", "--kiro", "--sesh", "--tmux", "--vscode"])
      expect(policyFor(name)?.switch).toMatchObject({
        explicitLauncher: { authoritative: true, compatible: true, noFallback: "preserved" },
        jsonGuardPrecedence: "before-option-and-conflict-validation",
        tab: { bypassesConfiguredDefaults: true, compatible: true, disposition: "tab" },
      });
  });

  test("publishes schema-v5 tab policies without an environment prerequisite", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    expect(contract.schemaVersion).toBe(8);
    expect(
      contract.commands.find((command) => command.path === "switch")?.semantics.optionPolicies?.[
        "--tab"
      ],
    ).toEqual({
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
      json: { guardPrecedence: "before-option-validation", mode: "launch", unsupported: true },
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
    });
    expect(
      contract.commands.find((command) => command.path === "create")?.semantics.optionPolicies?.[
        "--tab"
      ],
    ).toEqual({
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
    });
  });

  test("requires the existing tmux environment prerequisite while tab has none", () => {
    const invalid = structuredClone(commandSemantics);
    delete invalid.switch.optionPolicies?.["--tmux"].environment;
    expect(validateCommandSemantics(expectedPaths, invalid)).toContain(
      'Command "switch" --tmux policy requires a non-empty TMUX environment',
    );
    expect(commandSemantics.switch.optionPolicies?.["--tab"]).not.toHaveProperty("environment");
  });

  test("rejects an option policy key that is not registered on that exact command", () => {
    const invalid = structuredClone(commandSemantics);
    invalid.switch.optionPolicies!["--taab"] = invalid.switch.optionPolicies!["--tab"]!;
    delete invalid.switch.optionPolicies!["--tab"];

    expect(() =>
      generateCommandContract(buildProgram({ includeHelpBanner: false }), invalid),
    ).toThrow('Command "switch" option policy references unregistered option "--taab"');
  });

  test("accepts a structurally valid future policy for any registered command option", () => {
    const future = structuredClone(commandSemantics);
    future.switch.optionPolicies!["--cursor"] = structuredClone(
      future.switch.optionPolicies!["--tab"]!,
    );

    expect(() =>
      generateCommandContract(buildProgram({ includeHelpBanner: false }), future),
    ).not.toThrow();
  });

  test.each([
    [
      "top-level extras",
      (policy: Record<string, unknown>): void => {
        policy.extra = true;
      },
    ],
    [
      "persisted literal",
      (policy: Record<string, unknown>): void => {
        policy.persisted = true;
      },
    ],
    [
      "required top-level shape",
      (policy: Record<string, unknown>): void => {
        delete policy.implies;
      },
    ],
    [
      "array element types",
      (policy: Record<string, unknown>): void => {
        policy.compatibleOptions = ["--cursor", 7];
      },
    ],
    [
      "JSON shape",
      (policy: Record<string, unknown>) =>
        (policy.json = {
          guardPrecedence: "before-option-validation",
          mode: "launch",
          unsupported: true,
          extra: true,
        }),
    ],
    [
      "JSON unsupported literal",
      (policy: Record<string, unknown>) =>
        (policy.json = {
          guardPrecedence: "before-option-validation",
          mode: "launch",
          unsupported: false,
        }),
    ],
    [
      "JSON guard literal",
      (policy: Record<string, unknown>) =>
        (policy.json = {
          guardPrecedence: "after-option-validation",
          mode: "launch",
          unsupported: true,
        }),
    ],
    [
      "dry-run supported literal",
      (policy: Record<string, unknown>) =>
        (policy.dryRun = { runtimeTargetEvidenceRequired: false, supported: false }),
    ],
    [
      "dry-run exact shape",
      (policy: Record<string, unknown>) =>
        (policy.dryRun = {
          runtimeTargetEvidenceRequired: false,
          supported: true,
          extra: true,
        }),
    ],
    [
      "launcher no-fallback literal",
      (policy: Record<string, unknown>) => {
        const launcher = policy.launcherSupport as Record<string, unknown>;
        launcher.noFallback = false;
      },
    ],
    [
      "launcher exact shape",
      (policy: Record<string, unknown>) => {
        const launcher = policy.launcherSupport as Record<string, unknown>;
        launcher.extra = true;
      },
    ],
    [
      "environment exact shape",
      (policy: Record<string, unknown>) =>
        (policy.environment = { name: "TERM", nonEmptyAfterTrim: true, extra: true }),
    ],
    [
      "environment non-empty literal",
      (policy: Record<string, unknown>) =>
        (policy.environment = { name: "TERM", nonEmptyAfterTrim: false }),
    ],
    ["unique arrays", (policy: Record<string, unknown>) => (policy.conflicts = ["--cd", "--cd"])],
    [
      "disjoint launcher support",
      (policy: Record<string, unknown>) => {
        const launcher = policy.launcherSupport as Record<string, unknown>;
        launcher.unsupported = [
          ...((launcher.unsupported as string[]) ?? []),
          (launcher.supported as string[])[0],
        ];
      },
    ],
  ] as const)("runtime-validates arbitrary policy %s", (_label, mutate) => {
    const invalid = structuredClone(commandSemantics);
    const policy = invalid.switch.optionPolicies!["--tab"] as unknown as Record<string, unknown>;
    mutate(policy);

    expect(() =>
      generateCommandContract(buildProgram({ includeHelpBanner: false }), invalid),
    ).toThrow("Invalid CLI command semantics");
  });

  test("audits the complete baseline option surface with normalized structural fields", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    const options = contract.commands.flatMap((command) => command.options);

    expect(contract.commands).toHaveLength(24);
    expect(options).toHaveLength(137);
    expect(new Set(options.map((option) => option.long))).toHaveLength(62);
    expect(options.every((option) => option.semanticPolicyOwner.length > 0)).toBe(true);
    expect(
      contract.commands
        .find((command) => command.path === "add")
        ?.options.find((option) => option.long === "--json"),
    ).toMatchObject({
      deprecated: false,
      hidden: false,
      long: "--json",
      semanticPolicyOwner: "structural",
      short: "-j",
      valueShape: "boolean",
    });
    expect(
      contract.commands
        .find((command) => command.path === "switch")
        ?.options.filter((option) =>
          ["--launch", "--ignore-configured-launcher", "--no-cd", "--no-default-launch"].includes(
            option.long,
          ),
        ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deprecated: false, hidden: false, long: "--launch" }),
        expect.objectContaining({
          deprecated: false,
          hidden: false,
          long: "--ignore-configured-launcher",
        }),
        expect.objectContaining({ deprecated: true, hidden: true, long: "--no-cd" }),
        expect.objectContaining({ deprecated: true, hidden: true, long: "--no-default-launch" }),
      ]),
    );
  });

  test("rejects command-local alias collisions and stale option policy ownership", () => {
    const colliding = new Command().name("arashi");
    const sample = new Command("sample").option("-j, --json");
    (sample.options as Option[]).push(new Option("-j, --jobs <count>"));
    colliding.addCommand(sample);
    expect(validateOptionAudit(colliding, {})).toContain(
      'Command "sample" short alias "-j" collides between "--jobs" and "--json"',
    );

    const program = new Command().name("arashi");
    program.addCommand(new Command("sample").option("--json"));
    expect(
      validateOptionAudit(program, {
        sample: { "--stale": { ownership: "command" } },
      }),
    ).toContain('Command "sample" option policy references unregistered option "--stale"');
  });

  test("validates typed compatibility, switch, selector, and inspection policy shapes", () => {
    expect(
      validateOptionSemanticPolicy("switch", "--launch", {
        ownership: "command",
        compatibility: {
          alternatives: ["--no-cd"],
          canonical: { option: "--launch" },
          deprecatedAlternatives: true,
          removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
        },
        conflicts: ["--cd"],
        implies: ["launch"],
        persisted: false,
      }),
    ).toEqual([]);
    expect(
      validateOptionSemanticPolicy("handoff", "--markdown", {
        ownership: "command",
        compatibility: {
          alternatives: ["--markdown"],
          canonical: { behavior: "markdown", omittedDefault: true },
          deprecatedAlternatives: true,
          removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
        },
        persisted: false,
        role: "redundant-compatibility",
      }),
    ).toEqual([]);
    expect(
      validateOptionSemanticPolicy("pull", "--only", {
        ownership: "command",
        selector: {
          commaSeparated: true,
          explicitEmpty: "distinct",
          repeated: true,
          standalone: "configured-only",
        },
      }),
    ).not.toEqual([]);
    expect(
      validateOptionSemanticPolicy("update", "--check", {
        ownership: "command",
        conflicts: ["--dry-run"],
        inspection: { executionPaths: ["human", "json"] },
      }),
    ).toEqual([]);

    expect(
      validateOptionSemanticPolicy("update", "--check", {
        ownership: "command",
        conflicts: ["--dry-run", "--dry-run"],
        inspection: { executionPaths: ["human"] },
      }),
    ).toEqual([
      'Command "update" --check policy.conflicts entries must be unique',
      'Command "update" --check policy.inspection.executionPaths must contain human and json',
    ]);
    expect(
      validateOptionSemanticPolicy("pull", "--only", {
        ownership: "command",
        selector: {
          commaSeparated: true,
          explicitEmpty: "omitted",
          repeated: true,
          standalone: "configured-only",
        },
      }),
    ).not.toEqual([]);
  });

  test("rejects missing, misplaced, stale, wrong-kind, and incomplete selector policies", () => {
    const program = new Command().name("arashi");
    program.addCommand(
      new Command("sample")
        .option("-o, --only <repo>")
        .option("-g, --group <group>")
        .option("-j, --json"),
    );
    const complete = {
      sample: {
        "--group": selectorFixturePolicy("group", "--only"),
        "--only": selectorFixturePolicy("repository", "--group"),
      },
    };

    const audit = (policies: unknown) =>
      validateOptionAudit(program, policies as Parameters<typeof validateOptionAudit>[1]);

    expect(audit(complete)).toEqual([]);
    expect(audit({ sample: { "--only": complete.sample["--only"] } })).toContain(
      'Command "sample" registered selector "--group" requires a complete selector policy',
    );
    expect(
      audit({
        sample: { ...complete.sample, "--json": selectorFixturePolicy("repository", "--group") },
      }),
    ).toContain('Command "sample" non-selector option "--json" must not declare selector policy');

    const wrongKind = structuredClone(complete);
    wrongKind.sample["--only"].selector.kind = "group";
    expect(audit(wrongKind)).toContain(
      'Command "sample" --only selector kind must be "repository"',
    );
    expect(audit({ stale: complete.sample })).toEqual(
      expect.arrayContaining([
        'Option policy references unregistered command path "stale"',
        'Command "sample" registered selector "--only" requires a complete selector policy',
        'Command "sample" registered selector "--group" requires a complete selector policy',
      ]),
    );
  });

  test("rejects malformed selector enums, arrays, literals, and interaction shape", () => {
    const valid = {
      ownership: "command" as const,
      persisted: false as const,
      selector: {
        accepts: ["repeated", "comma-separated", "mixed"],
        blankSegments: "ignored-beside-values",
        combination: { empty: "error", mode: "intersection", with: "--group" },
        deduplicate: "first-occurrence",
        explicitEmpty: "error",
        flatten: "encounter-order",
        kind: "repository",
        omitted: "default-selection",
        standalone: "configured-only",
        supplied: "distinct-from-omitted",
        trim: true,
        unknown: "error",
        validationPrecedence: "before-repository-work",
      },
    };
    expect(validateOptionSemanticPolicy("pull", "--only", valid)).toEqual([]);

    for (const mutate of [
      (selector: Record<string, unknown>) => (selector.accepts = "mixed"),
      (selector: Record<string, unknown>) => (selector.accepts = ["repeated", "mixed"]),
      (selector: Record<string, unknown>) => (selector.flatten = "sorted"),
      (selector: Record<string, unknown>) => (selector.trim = false),
      (selector: Record<string, unknown>) => (selector.explicitEmpty = "omitted"),
      (selector: Record<string, unknown>) => (selector.unknown = "ignored"),
      (selector: Record<string, unknown>) => {
        (selector.combination as Record<string, unknown>).mode = "union";
      },
      (selector: Record<string, unknown>) => {
        delete (selector.combination as Record<string, unknown>).empty;
      },
    ]) {
      const invalid = structuredClone(valid) as unknown as Record<string, unknown>;
      mutate(invalid.selector as Record<string, unknown>);
      expect(validateOptionSemanticPolicy("pull", "--only", invalid)).not.toEqual([]);
    }
  });

  test("validates the exact typed switch policy shape and configured-mode effects", () => {
    const policy = {
      ownership: "command" as const,
      persisted: false as const,
      switch: {
        configuredModeEffects: {
          auto: "launch",
          cd: "launch",
          herdr: "preserve-named-launcher",
          launch: "launch",
          sesh: "preserve-named-launcher",
        },
        explicitLauncher: { authoritative: true, compatible: true, noFallback: "preserved" },
        jsonGuardPrecedence: "before-option-and-conflict-validation",
        tab: { bypassesConfiguredDefaults: true, compatible: true, disposition: "tab" },
      },
    };

    expect(validateOptionSemanticPolicy("switch", "--launch", policy)).toEqual([]);
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.extra = true;
      },
      (value: Record<string, unknown>) => {
        const effects = value.configuredModeEffects as Record<string, unknown>;
        delete effects.herdr;
      },
      (value: Record<string, unknown>) => {
        value.jsonGuardPrecedence = "after-option-validation";
      },
      (value: Record<string, unknown>) => {
        const explicitLauncher = value.explicitLauncher as Record<string, unknown>;
        explicitLauncher.noFallback = false;
      },
      (value: Record<string, unknown>) => {
        const tab = value.tab as Record<string, unknown>;
        tab.disposition = "window";
      },
    ]) {
      const invalid = structuredClone(policy) as unknown as Record<string, unknown>;
      mutate(invalid.switch as Record<string, unknown>);
      expect(validateOptionSemanticPolicy("switch", "--launch", invalid)).not.toEqual([]);
    }
  });

  test("rejects the stale createBase policy producer", () => {
    expect(validateOptionSemanticPolicy("create", "--base", createBaseFixturePolicy)).toEqual([]);
    expect(
      validateOptionSemanticPolicy("create", "--base", {
        ...createBaseFixturePolicy,
        createBase: { precedence: ["defaults.create.baseBranch"] },
      }),
    ).toContain('Command "create" --base policy has unsupported fields: createBase');
  });

  test("rejects unregistered conflict and option implication references without rejecting semantic tokens", () => {
    const program = new Command().name("arashi");
    program.addCommand(new Command("sample").option("--alpha").option("--beta").option("--gamma"));

    expect(
      validateOptionAudit(program, {
        sample: {
          "--alpha": {
            conflicts: ["--missing-conflict"],
            implies: ["launch", "--missing-implication"],
            ownership: "command",
          },
        },
      }),
    ).toEqual([
      'Command "sample" --alpha conflict "--missing-conflict" is not registered',
      'Command "sample" --alpha implication "--missing-implication" is not registered',
    ]);
  });

  test("requires registered conflicts to be reciprocal", () => {
    const program = new Command().name("arashi");
    program.addCommand(new Command("sample").option("--alpha").option("--beta"));

    expect(
      validateOptionAudit(program, {
        sample: {
          "--alpha": { conflicts: ["--beta"], ownership: "command" },
          "--beta": { conflicts: [], ownership: "command" },
        },
      }),
    ).toContain('Command "sample" conflict "--alpha" -> "--beta" must be reciprocal');
  });

  test("requires compatibility removal to start no earlier than major 2", () => {
    expect(
      validateOptionSemanticPolicy("switch", "--launch", {
        ownership: "command",
        compatibility: {
          alternatives: ["--no-cd"],
          canonical: { option: "--launch" },
          deprecatedAlternatives: true,
          removal: { earliestMajor: 1, requiresApprovedBreakingChange: true },
        },
      }),
    ).toContain(
      'Command "switch" --launch policy.compatibility.removal.earliestMajor must be an integer greater than or equal to 2',
    );
  });

  test("requires redundant compatibility to encode non-persistence and omitted default behavior", () => {
    expect(
      validateOptionSemanticPolicy("handoff", "--markdown", {
        ownership: "command",
        compatibility: {
          alternatives: ["--markdown"],
          canonical: { omittedDefault: true },
          deprecatedAlternatives: true,
          removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
        },
        role: "redundant-compatibility",
      }),
    ).toEqual([
      'Command "handoff" --markdown policy.persisted must be false for redundant compatibility',
      'Command "handoff" --markdown policy.compatibility.canonical.behavior must be a non-empty string',
    ]);
  });

  test("requires omitted-default compatibility to declare its redundant role", () => {
    expect(
      validateOptionSemanticPolicy("handoff", "--markdown", {
        ownership: "command",
        compatibility: {
          alternatives: ["--markdown"],
          canonical: { behavior: "markdown", omittedDefault: true },
          deprecatedAlternatives: true,
          removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
        },
        persisted: false,
      }),
    ).toContain(
      'Command "handoff" --markdown policy.role must be "redundant-compatibility" for an omitted default',
    );
  });

  test("requires compatibility alternatives to use long option names", () => {
    expect(
      validateOptionSemanticPolicy("switch", "--launch", {
        ownership: "command",
        compatibility: {
          alternatives: ["-n"],
          canonical: { option: "--launch" },
          deprecatedAlternatives: true,
          removal: { earliestMajor: 2, requiresApprovedBreakingChange: true },
        },
      }),
    ).toContain(
      'Command "switch" --launch policy.compatibility.alternatives entries must be long option names',
    );
  });

  test("requires compatibility options to be registered with canonical visibility and deprecated alternatives", () => {
    const program = new Command().name("arashi");
    const sample = new Command("sample");
    const canonical = new Option("--launch").hideHelp();
    const alternative = new Option("--no-cd");
    sample.addOption(canonical).addOption(alternative);
    program.addCommand(sample);
    const compatibility = {
      ownership: "command" as const,
      compatibility: {
        alternatives: ["--no-cd"],
        canonical: { option: "--launch" },
        deprecatedAlternatives: true as const,
        removal: { earliestMajor: 2, requiresApprovedBreakingChange: true as const },
      },
    };

    expect(validateOptionAudit(program, { sample: { "--launch": compatibility } })).toEqual([
      'Command "sample" --launch compatibility canonical option "--launch" must be visible',
      'Command "sample" --launch compatibility alternative "--no-cd" must be hidden and deprecated',
    ]);

    canonical.hidden = false;
    alternative.hidden = true;
    (alternative as Option & { deprecated?: boolean }).deprecated = true;
    expect(validateOptionAudit(program, { sample: { "--launch": compatibility } })).toEqual([]);

    compatibility.compatibility.canonical = { option: "--missing" };
    expect(validateOptionAudit(program, { sample: { "--launch": compatibility } })).toContain(
      'Command "sample" --launch compatibility canonical option "--missing" is not registered',
    );
  });

  test("produces typed option policy in the generated contract", () => {
    const policy = {
      ownership: "command" as const,
      conflicts: ["--dry-run"],
      inspection: { executionPaths: ["human", "json"] as Array<"human" | "json"> },
    };
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      { ...optionAuditPolicies, update: { "--check": policy } },
    );

    expect(
      contract.commands
        .find((command) => command.path === "update")
        ?.options.find((option) => option.long === "--check"),
    ).toMatchObject({ semanticPolicy: policy, semanticPolicyOwner: "command" });
  });

  test("serializes deterministically with structural metadata", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const first = serializeCommandContract(generateCommandContract(program, commandSemantics));
    const second = serializeCommandContract(
      generateCommandContract(buildProgram({ includeHelpBanner: false }), commandSemantics),
    );
    expect(first).toBe(second);
    const contract = JSON.parse(first);
    expect(contract.schemaVersion).toBe(8);
    expect(contract).not.toHaveProperty("cliVersion");
    expect(contract.commands.map((command: { path: string }) => command.path)).toEqual(
      expectedPaths,
    );
    expect(contract.commands[0]).toHaveProperty("options");
    expect(first.endsWith("\n")).toBe(true);
  });

  test("does not change when only the runtime release version changes", () => {
    const current = buildProgram({ includeHelpBanner: false });
    const alternateRelease = new Command()
      .name("arashi")
      .description("Git worktree manager for meta-repositories")
      .version("999.0.0");
    for (const command of buildProgram({ includeHelpBanner: false }).commands)
      alternateRelease.addCommand(command);

    expect(serializeCommandContract(generateCommandContract(current, commandSemantics))).toBe(
      serializeCommandContract(generateCommandContract(alternateRelease, commandSemantics)),
    );
  });
});
