import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildProgram } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
} from "../../src/contracts/cli-commands.ts";

describe("configured repository delete command contract", () => {
  test("registers optional exact repository deletion without changing remove", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const deleteCommand = program.commands.find((command) => command.name() === "delete");
    const removeCommand = program.commands.find((command) => command.name() === "remove");

    expect(deleteCommand).toBeDefined();
    expect(deleteCommand?.registeredArguments).toHaveLength(1);
    expect(deleteCommand?.registeredArguments[0]).toMatchObject({
      required: false,
      variadic: false,
    });
    expect(deleteCommand?.registeredArguments[0]?.name()).toBe("repository");
    expect(deleteCommand?.options.map((option) => [option.short, option.long])).toEqual(
      expect.arrayContaining([
        ["-f", "--force"],
        ["-n", "--dry-run"],
        ["-j", "--json"],
      ]),
    );
    expect(removeCommand?.description()).toBe("Remove worktrees and delete branches");
  });

  test("publishes configured-only delete policy and exact-key completion", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const deletion = contract.commands.find((command) => command.path === "delete");

    expect(deletion?.arguments[0]).toMatchObject({
      candidateKind: "configured-repository",
      name: "repository",
      required: false,
    });
    expect(deletion?.semantics).toMatchObject({
      json: { support: "full" },
      standalone: { support: "configured-only" },
      vscode: { expectation: "excluded" },
      deleteRepository: {
        selection: "explicit-exact-key-or-tty-checkbox",
        batchOrder: "bytewise",
        confirmation: "one-combined-default-no",
        confirmationStates: ["not-required", "confirmed", "declined", "required"],
        dataFields: [
          "workspace",
          "repositoryKey",
          "dryRun",
          "force",
          "confirmation",
          "plan",
          "result",
        ],
        lock: ".arashi-add.transaction.lock",
        errorPrecedence: [
          "configured-workspace-or-config",
          "target-selection",
          "structural-and-git-inspection",
          "complete-plan-set",
          "git-loss-refusal",
          "dry-run-success",
          "confirmation",
          "post-lock-revalidation",
          "execution-failure",
          "partial-failure",
        ],
        errorCodes: [
          "CONFIGURED_WORKSPACE_REQUIRED",
          "DELETE_SELECTION_REQUIRED",
          "DELETE_REPOSITORY_NOT_FOUND",
          "DELETE_CONFIG_INVALID",
          "DELETE_TOPOLOGY_INVALID",
          "DELETE_PATH_UNSAFE",
          "DELETE_HOOK_AMBIGUOUS",
          "DELETE_GIT_DATA_LOSS",
          "DELETE_CONFIRMATION_REQUIRED",
          "DELETE_CANCELLED",
          "DELETE_CONCURRENT_CHANGE",
          "DELETE_EXECUTION_FAILED",
          "DELETE_PARTIAL_FAILURE",
          "DELETE_RECEIPT_INVALID",
          "DELETE_RECEIPT_STALE",
          "DELETE_RECEIPT_UNSAFE",
        ],
        exits: {
          success: 0,
          selectionOrConfirmation: 2,
          failure: 1,
          selectionOrConfirmationErrors: [
            "DELETE_SELECTION_REQUIRED",
            "DELETE_CONFIRMATION_REQUIRED",
            "DELETE_CANCELLED",
          ],
        },
        forceBoundaries: {
          overridable: ["confirmation", "git-data-loss"],
          structural: ["config", "topology", "path", "hook-ambiguity", "concurrent-change"],
        },
        itemKinds: [
          "resume-receipt",
          "canonical-clone",
          "linked-worktree",
          "worktree-metadata",
          "local-ref",
          "config-entry",
          "workspace-hook",
          "preserved-global-hook",
        ],
        itemFields: [
          "id",
          "kind",
          "ownership",
          "path",
          "ref",
          "oid",
          "planned",
          "completed",
          "state",
          "reasonCode",
          "message",
        ],
        itemStates: ["planned", "completed", "preserved", "blocked", "failed", "not-started"],
        phaseFields: ["name", "state", "itemIds", "error", "startedOrder", "completedOrder"],
        phaseErrorFields: ["code", "message"],
        phaseNames: [
          "provenance",
          "worktrees",
          "metadata",
          "canonical-clone",
          "workspace-hooks",
          "configuration",
          "verification",
        ],
        phaseStates: ["not-started", "started", "completed", "failed"],
        planFields: ["id", "items", "warnings"],
        resultFields: ["items", "phases", "retry", "warnings"],
        retry: {
          classification: "safe-only-with-current-durable-receipt",
          fields: ["safe", "argv", "guidance"],
          humanArgv: ["aw", "delete", "<repository>", "--force"],
          jsonArgv: ["aw", "delete", "<repository>", "--force", "--json"],
        },
        workspaceFields: ["mode", "repositoriesBase", "workspaceRoot", "worktreesBase"],
      },
    });
  });

  test("keeps dedicated CLI README, config, and hook guidance aligned", () => {
    const readme = readFileSync("README.md", "utf8");
    const command = readFileSync("docs/commands/delete.md", "utf8");
    const configuration = readFileSync("docs/configuration.md", "utf8");
    const hooks = readFileSync("docs/hooks.md", "utf8");

    expect(readme).toContain("`aw delete`");
    expect(readme).toContain("configured repository dependencies");
    expect(command).toContain("aw delete <repository> --dry-run");
    expect(command).toContain("error.details.plan");
    expect(command).toContain("argument vector");
    expect(command).toContain("does not override");
    expect(configuration).toContain("`aw delete <repository>`");
    expect(configuration).toContain("managed-ignore");
    expect(hooks).toContain("concrete `.example` template");
    expect(hooks).toContain("user-global hooks are preserved");
  });
});
