import { describe, expect, test, vi } from "vitest";
import {
  collectRepositoryOnboarding,
  isRepositoryOnboardingEligible,
  type RepositoryOnboardingPrompts,
} from "../../../src/lib/repository-onboarding.ts";
import { createRepositoryEditorState } from "../../../src/lib/repository-config-editor.ts";

const state = () =>
  createRepositoryEditorState(
    {
      repos: { app: { path: "repos/app", gitUrl: "x", groups: ["keep"] } },
      reposDir: "repos",
      version: "1.0.0",
    },
    "app",
  );
const ok = <T>(value: T) => Promise.resolve({ status: "ok", value } as const);
const promptSet = (
  overrides: Partial<RepositoryOnboardingPrompts>,
): RepositoryOnboardingPrompts => ({
  confirm: vi.fn(),
  input: vi.fn(),
  multiSelect: vi.fn(),
  select: vi.fn(),
  showDiagnostic: vi.fn(),
  ...overrides,
});

describe("repository onboarding controller", () => {
  test("centralizes TTY/json/force eligibility", () => {
    expect(isRepositoryOnboardingEligible({ stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(isRepositoryOnboardingEligible({ stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(isRepositoryOnboardingEligible({ stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
    expect(
      isRepositoryOnboardingEligible({ json: true, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe(false);
    expect(
      isRepositoryOnboardingEligible({ force: true, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe(false);
  });

  test("default-no decline is minimal success and performs no discovery", async () => {
    const discover = vi.fn();
    const prompts = promptSet({ confirm: vi.fn(() => ok(false)) });
    const result = await collectRepositoryOnboarding({ discover, editor: state(), prompts });
    expect(result).toEqual({ editor: state(), status: "declined" });
    expect(discover).not.toHaveBeenCalled();
  });

  test("collects mixed setup with visible inline input and sanitized final confirmation", async () => {
    const canary = "VISIBLE_CONTROLLER_CANARY";
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(true)),
      input: vi.fn((message: string) =>
        ok(message.startsWith("Enter Bash command") ? canary : ".env.local"),
      ),
      multiSelect: vi
        .fn()
        .mockImplementationOnce(() => ok(["copy", "hooks"]))
        .mockImplementationOnce(() => ok(["pre-create", "post-remove"])),
      select: vi
        .fn()
        .mockImplementationOnce(() => ok(false))
        .mockImplementationOnce(() => ok("inline-bash"))
        .mockImplementationOnce(() => ok("file")),
    });
    const result = await collectRepositoryOnboarding({
      discover: () =>
        Promise.resolve({
          candidates: [{ kind: "file", path: ".env.local", selected: false }],
          inspectedEntries: 1,
        }),
      editor: state(),
      prompts,
      scriptContext: {
        activeConfigRoot: "/workspace",
        activeRepositoryPath: "/workspace/repos/app",
        platform: "linux",
      },
    });
    expect(result.status).toBe("confirmed");
    const finalPrompt = (prompts.confirm as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[0] as string;
    expect(finalPrompt).toContain("pre-create");
    expect(finalPrompt).toContain("post-remove.sh");
    expect(finalPrompt).not.toContain(canary);
    expect(prompts.input).toHaveBeenCalledWith("Enter Bash command for pre-create:");
  });

  test("collects direct array entries through an explicit add-another flow", async () => {
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(true)),
      input: vi
        .fn()
        .mockImplementationOnce(() => ok("config/a,config/b"))
        .mockImplementationOnce(() => ok("config/c")),
      multiSelect: vi.fn(() => ok(["copy"])) as RepositoryOnboardingPrompts["multiSelect"],
      select: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(false)),
    });
    const result = await collectRepositoryOnboarding({
      discover: () => Promise.resolve({ candidates: [], inspectedEntries: 0 }),
      editor: state(),
      prompts,
    });
    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed")
      expect(result.editor.candidate.repos.app.copy).toEqual(["config/a,config/b", "config/c"]);
    expect(prompts.select).toHaveBeenCalledWith("Add another copy path?", [
      { name: "Yes", value: true },
      { name: "No", value: false },
    ]);
  });

  test("shows bounded field diagnostic and retries the owning path prompt", async () => {
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(true)),
      input: vi
        .fn()
        .mockImplementationOnce(() => ok("../outside"))
        .mockImplementationOnce(() => ok(".env")),
      multiSelect: vi.fn(() => ok(["copy"])) as RepositoryOnboardingPrompts["multiSelect"],
      select: vi.fn(() => ok(false)) as RepositoryOnboardingPrompts["select"],
    });
    await expect(
      collectRepositoryOnboarding({
        discover: () => Promise.resolve({ candidates: [], inspectedEntries: 0 }),
        editor: state(),
        prompts,
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(prompts.showDiagnostic).toHaveBeenCalledTimes(1);
    const message = (prompts.showDiagnostic as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(message).toMatch(/^copy: /);
    expect(message.length).toBeLessThanOrEqual(240);
    expect(prompts.input).toHaveBeenCalledTimes(2);
  });

  test("invalid inline input emits lifecycle diagnostic and retries its visible prompt", async () => {
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(true)),
      multiSelect: vi
        .fn()
        .mockImplementationOnce(() => ok(["hooks"]))
        .mockImplementationOnce(() => ok(["pre-create"])),
      input: vi
        .fn()
        .mockImplementationOnce(() => ok("  "))
        .mockImplementationOnce(() => ok("printf recovered")),
      select: vi.fn(() => ok("inline-bash")) as RepositoryOnboardingPrompts["select"],
    });
    await expect(
      collectRepositoryOnboarding({ discover: vi.fn(), editor: state(), prompts }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(prompts.showDiagnostic).toHaveBeenCalledWith(expect.stringMatching(/^pre-create: /));
    expect(prompts.input).toHaveBeenCalledTimes(2);
  });

  test("active-path validation reports a bounded lifecycle diagnostic and retries its source choice", async () => {
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(true)),
      multiSelect: vi
        .fn()
        .mockImplementationOnce(() => ok(["hooks"]))
        .mockImplementationOnce(() => ok(["pre-create"])),
      input: vi.fn(() => ok("printf recovered")),
      select: vi
        .fn()
        .mockImplementationOnce(() => ok("file"))
        .mockImplementationOnce(() => ok("inline-bash")),
    });
    const observeActivePaths = vi
      .fn()
      .mockResolvedValueOnce([{ lifecycle: "pre-create", destinationExists: true }])
      .mockResolvedValue([]);
    await expect(
      collectRepositoryOnboarding({
        discover: vi.fn(),
        editor: state(),
        observeActivePaths,
        prompts,
        scriptContext: {
          activeConfigRoot: "/workspace",
          activeRepositoryPath: "/workspace/repos/app",
          platform: "linux",
        },
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(prompts.select).toHaveBeenCalledTimes(2);
    expect(prompts.showDiagnostic).toHaveBeenCalledTimes(1);
    const message = (prompts.showDiagnostic as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(message).toMatch(/^pre-create: .*destination already exists/i);
    expect(message.length).toBeLessThanOrEqual(240);
    const finalPrompt = (prompts.confirm as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[0] as string;
    expect(finalPrompt).not.toContain("destination already exists");
  });

  test("one existing Windows native candidate rejects file mode and retries the owning source choice", async () => {
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(true)),
      multiSelect: vi
        .fn()
        .mockImplementationOnce(() => ok(["hooks"]))
        .mockImplementationOnce(() => ok(["pre-create"])),
      input: vi.fn(() => ok("printf recovered")),
      select: vi
        .fn()
        .mockImplementationOnce(() => ok("file"))
        .mockImplementationOnce(() => ok("inline-bash")),
    });
    const observeActivePaths = vi
      .fn()
      .mockResolvedValueOnce([{ lifecycle: "pre-create", nativeCandidateCount: 1 }])
      .mockResolvedValue([]);

    const result = await collectRepositoryOnboarding({
      discover: vi.fn(),
      editor: state(),
      observeActivePaths,
      prompts,
      scriptContext: {
        activeConfigRoot: "C:\\workspace",
        activeRepositoryPath: "C:\\workspace\\repos\\app",
        platform: "win32",
      },
    });

    expect(result.status).toBe("confirmed");
    expect(prompts.select).toHaveBeenCalledTimes(2);
    expect(prompts.showDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/^pre-create: .*ambiguous native hook candidates/i),
    );
    if (result.status === "confirmed") {
      expect(result.editor.scripts).toEqual([]);
      expect(result.editor.candidate.repos.app.hooks?.["pre-create"]).toEqual({
        bash: "printf recovered",
      });
    }
  });

  test("persistent native hook collisions can be kept after trying file and inline sources", async () => {
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(true)),
      multiSelect: vi
        .fn()
        .mockImplementationOnce(() => ok(["hooks"]))
        .mockImplementationOnce(() => ok(["pre-create"])),
      input: vi.fn(() => ok("printf attempted")),
      select: vi
        .fn()
        .mockImplementationOnce(() => ok("file"))
        .mockImplementationOnce(() => ok("inline-bash"))
        .mockImplementationOnce(() => ok("skip")),
    });
    const observeActivePaths = vi.fn(async (request: { lifecycles: readonly unknown[] }) =>
      request.lifecycles.length > 0
        ? [{ lifecycle: "pre-create" as const, nativeCandidateCount: 1 }]
        : [],
    );

    const result = await collectRepositoryOnboarding({
      discover: vi.fn(),
      editor: state(),
      observeActivePaths,
      prompts,
      scriptContext: {
        activeConfigRoot: "/workspace",
        activeRepositoryPath: "/workspace/repos/app",
        platform: "linux",
      },
    });

    expect(result.status).toBe("confirmed");
    expect(prompts.select).toHaveBeenCalledTimes(3);
    expect((prompts.select as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toContainEqual(
      expect.objectContaining({ value: "skip" }),
    );
    expect((prompts.select as ReturnType<typeof vi.fn>).mock.calls[2][1]).toContainEqual({
      name: "Skip / keep existing active hook",
      value: "skip",
    });
    if (result.status === "confirmed") {
      expect(result.editor.scripts).toEqual([]);
      expect(result.editor.candidate.repos.app.hooks).toBeUndefined();
    }
  });

  test("final decline and Ctrl+C are controlled cancellation", async () => {
    const prompts = promptSet({
      confirm: vi
        .fn()
        .mockImplementationOnce(() => ok(true))
        .mockImplementationOnce(() => ok(false)),
      multiSelect: vi.fn(() => ok([])),
    });
    await expect(
      collectRepositoryOnboarding({ discover: vi.fn(), editor: state(), prompts }),
    ).resolves.toEqual({ reason: "declined", status: "cancelled" });
    const cancelled = promptSet({
      confirm: vi.fn(() =>
        Promise.resolve({ status: "cancelled" as const, reason: "exit" as const }),
      ),
    });
    await expect(
      collectRepositoryOnboarding({ discover: vi.fn(), editor: state(), prompts: cancelled }),
    ).resolves.toEqual({ reason: "exit", status: "cancelled" });
  });
});
