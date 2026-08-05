import { describe, expect, test } from "vitest";
import { Command } from "commander";
import pkg from "../../package.json";
import { buildProgram, discoverCommandPaths } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  serializeCommandContract,
  validateCommandSemantics,
} from "../../src/contracts/cli-commands.ts";

const expectedPaths = [
  "add",
  "clone",
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
    });
  });

  test("publishes schema-v4 tab policies without an environment prerequisite", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    expect(contract.schemaVersion).toBe(4);
    expect(
      contract.commands.find((command) => command.path === "switch")?.semantics.optionPolicies?.[
        "--tab"
      ],
    ).toEqual({
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
      overrides: ["--no-launch", "--no-switch"],
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

  test("serializes deterministically with structural metadata", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const first = serializeCommandContract(generateCommandContract(program, commandSemantics));
    const second = serializeCommandContract(
      generateCommandContract(buildProgram({ includeHelpBanner: false }), commandSemantics),
    );
    expect(first).toBe(second);
    const contract = JSON.parse(first);
    expect(contract.schemaVersion).toBe(4);
    expect(contract).not.toHaveProperty("cliVersion");
    expect(contract.commands.map((command: { path: string }) => command.path)).toEqual(
      expectedPaths,
    );
    expect(contract.commands[0]).toHaveProperty("options");
    expect(first.endsWith("\n")).toBe(true);
  });

  test("does not change when only the runtime release version changes", () => {
    const current = buildProgram({ includeHelpBanner: false });
    const alternateRelease = new Command().name("arashi").version("999.0.0");
    for (const command of buildProgram({ includeHelpBanner: false }).commands)
      alternateRelease.addCommand(command);

    expect(serializeCommandContract(generateCommandContract(current, commandSemantics))).toBe(
      serializeCommandContract(generateCommandContract(alternateRelease, commandSemantics)),
    );
  });
});
