import { describe, expect, test, vi } from "vitest";
import {
  closedDeleteErrorCode,
  createDeletePlan,
  createDeleteResult,
  markDeletePhaseFailure,
  orchestrateDelete,
  type AcceptedDeletePlan,
  type DeleteRepositoryPlan,
} from "../../src/commands/delete.ts";

const plan = (warning?: string): DeleteRepositoryPlan =>
  createDeletePlan([], warning ? [warning] : [], { configDigest: "a".repeat(64) });

const context = {
  repositoryKeys: ["zeta", "alpha"],
  workspace: {
    mode: "configured" as const,
    repositoriesBase: "/workspace/repos",
    workspaceRoot: "/workspace",
    worktreesBase: "/workspace/.arashi/worktrees",
  },
};

describe("delete command orchestration", () => {
  test("preserves recognized identity-race codes in phase and batch classification", () => {
    const acceptedPlan = plan();
    const result = createDeleteResult(acceptedPlan, "alpha", false);
    const phase = result.phases[0]!;
    const race = Object.assign(new Error("identity changed"), {
      code: "DELETE_CONCURRENT_CHANGE",
    });

    markDeletePhaseFailure(result, phase, race, null);

    expect(closedDeleteErrorCode(race)).toBe("DELETE_CONCURRENT_CHANGE");
    expect(phase.error?.code).toBe("DELETE_CONCURRENT_CHANGE");
  });

  test.each([
    { force: false, dryRun: false, json: false },
    { force: true, dryRun: false, json: false },
    { force: false, dryRun: true, json: false },
    { force: true, dryRun: true, json: false },
    { force: false, dryRun: false, json: true },
    { force: true, dryRun: false, json: true },
    { force: false, dryRun: true, json: true },
    { force: true, dryRun: true, json: true },
  ])("requires an explicit key when selection cannot run: %o", async (options) => {
    const planner = vi.fn();
    const result = await orchestrateDelete({
      context,
      options,
      planner,
      repository: undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });

    expect(result).toMatchObject({ exitCode: 2, errorCode: "DELETE_SELECTION_REQUIRED" });
    expect(planner).not.toHaveBeenCalled();
  });

  test("presents key-only choices, plans all selected keys, then confirms once", async () => {
    const events: string[] = [];
    const result = await orchestrateDelete({
      context,
      options: {},
      repository: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      select: async (_message, choices) => {
        expect(choices).toEqual([
          { name: "alpha", value: "alpha" },
          { name: "zeta", value: "zeta" },
        ]);
        events.push("select");
        return { status: "ok", value: ["zeta", "alpha", "alpha"] };
      },
      planner: async (key) => {
        events.push(`plan:${key}`);
        return plan();
      },
      preview: (accepted) => {
        events.push(`preview:${accepted.map(({ repositoryKey }) => repositoryKey).join(",")}`);
      },
      confirm: async () => {
        events.push("confirm");
        return { status: "ok", value: true };
      },
      executeBatch: async (accepted) => {
        events.push(`execute:${accepted.map(({ repositoryKey }) => repositoryKey).join(",")}`);
        return accepted.map(({ plan: acceptedPlan, repositoryKey }) => ({
          plan: acceptedPlan,
          repositoryKey,
          result: null,
          state: "completed" as const,
        }));
      },
    });

    expect(result.exitCode).toBe(0);
    expect(events).toEqual([
      "select",
      "plan:alpha",
      "plan:zeta",
      "preview:alpha,zeta",
      "confirm",
      "execute:alpha,zeta",
    ]);
  });

  test("preflights every selected repository before refusing Git data loss", async () => {
    const planned: string[] = [];
    const confirm = vi.fn();
    const executeBatch = vi.fn();
    const result = await orchestrateDelete({
      context,
      options: {},
      repository: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      select: async () => ({ status: "ok", value: ["zeta", "alpha"] }),
      planner: async (key) => {
        planned.push(key);
        return plan(key === "alpha" ? "DELETE_GIT_DATA_LOSS: dirty worktree" : undefined);
      },
      confirm,
      executeBatch,
    });

    expect(planned).toEqual(["alpha", "zeta"]);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "DELETE_GIT_DATA_LOSS" });
    expect(confirm).not.toHaveBeenCalled();
    expect(executeBatch).not.toHaveBeenCalled();
  });

  test("force accepts disclosed Git loss without prompting", async () => {
    const confirm = vi.fn();
    const executeBatch = vi.fn(async (accepted: AcceptedDeletePlan[]) =>
      accepted.map(({ plan: acceptedPlan, repositoryKey }) => ({
        plan: acceptedPlan,
        repositoryKey,
        result: null,
        state: "completed" as const,
      })),
    );
    const result = await orchestrateDelete({
      context,
      options: { force: true },
      repository: "alpha",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      planner: async () => plan("DELETE_GIT_DATA_LOSS: refs/heads/local deadbeef"),
      confirm,
      executeBatch,
    });

    expect(result).toMatchObject({ exitCode: 0, confirmation: "not-required" });
    expect(result.repositories[0]?.plan.warnings).toEqual([
      "DELETE_GIT_DATA_LOSS: refs/heads/local deadbeef",
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(executeBatch).toHaveBeenCalledOnce();
  });

  test("force cannot convert malformed Git evidence into an accepted plan", async () => {
    const confirm = vi.fn();
    const executeBatch = vi.fn();

    await expect(
      orchestrateDelete({
        context,
        options: { force: true },
        repository: "alpha",
        stdinIsTTY: true,
        stdoutIsTTY: true,
        planner: async () => {
          throw new Error("DELETE_GIT_DATA_LOSS: malformed Git ref evidence");
        },
        confirm,
        executeBatch,
      }),
    ).rejects.toThrow(/malformed Git ref evidence/u);
    expect(confirm).not.toHaveBeenCalled();
    expect(executeBatch).not.toHaveBeenCalled();
  });

  test("dry-run returns complete plans without confirmation or execution", async () => {
    const confirm = vi.fn();
    const executeBatch = vi.fn();
    const result = await orchestrateDelete({
      context,
      options: { dryRun: true },
      repository: "alpha",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      planner: async () => plan("DELETE_GIT_DATA_LOSS: local ref"),
      confirm,
      executeBatch,
    });

    expect(result).toMatchObject({ exitCode: 0, confirmation: "not-required" });
    expect(result.repositories).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(executeBatch).not.toHaveBeenCalled();
  });

  test("preserves accepted plans and creates result ledgers when batch setup fails", async () => {
    const result = await orchestrateDelete({
      context,
      options: { force: true },
      repository: "alpha",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      planner: async () => plan(),
      executeBatch: async () => {
        throw Object.assign(new Error("configuration changed"), {
          code: "DELETE_CONCURRENT_CHANGE",
        });
      },
    });

    expect(result).toMatchObject({ exitCode: 1, errorCode: "DELETE_CONCURRENT_CHANGE" });
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]?.plan).toEqual(plan());
    expect(result.repositories[0]?.state).toBe("failed");
    expect(result.repositories[0]?.result).not.toBeNull();
    expect(result.repositories[0]?.result?.phases[0]).toMatchObject({
      name: "provenance",
      state: "failed",
    });
    expect(result.repositories[0]?.result?.retry).toEqual({
      safe: false,
      argv: null,
      guidance: "No current durable receipt exists; inspect surviving state before retrying.",
    });
  });

  test("maps open-ended system error codes into the closed execution vocabulary", async () => {
    const result = await orchestrateDelete({
      context,
      options: { force: true },
      repository: "alpha",
      stdinIsTTY: false,
      stdoutIsTTY: false,
      planner: async () => plan(),
      executeBatch: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    expect(result.errorCode).toBe("DELETE_EXECUTION_FAILED");
    expect(result.repositories[0]?.failureCode).toBe("DELETE_EXECUTION_FAILED");
    expect(result.repositories[0]?.result?.phases[0]?.error?.code).toBe("DELETE_EXECUTION_FAILED");
  });
});
