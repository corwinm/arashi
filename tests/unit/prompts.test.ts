import { beforeAll, describe, expect, test, vi } from "vitest";

const mockCheckbox = vi.fn((options?: { choices?: unknown[] }) => {
  if (!options?.choices?.length) {
    return Promise.reject(new Error("No choices provided"));
  }
  return Promise.resolve(["opt1"]);
});
const mockConfirm = vi.fn(() => Promise.resolve(true));
const mockInput = vi.fn(() => Promise.resolve("test input"));
const mockPassword = vi.fn(() => Promise.resolve("secret input"));
const mockSelect = vi.fn(() => Promise.resolve("main"));

vi.mock("@inquirer/prompts", () => ({
  checkbox: mockCheckbox,
  confirm: mockConfirm,
  input: mockInput,
  password: mockPassword,
  select: mockSelect,
}));

async function loadPromptApi() {
  return import("../../src/lib/prompts");
}

type PromptApi = Awaited<ReturnType<typeof loadPromptApi>>;

let promptApi: PromptApi;

beforeAll(async () => {
  promptApi = await loadPromptApi();
});

describe("prompt outcomes", () => {
  test("returns successful values from the prompt wrappers", async () => {
    await expect(promptApi.confirm("Continue?", true)).resolves.toEqual({
      status: "ok",
      value: true,
    });
    await expect(promptApi.input("Name", "default")).resolves.toEqual({
      status: "ok",
      value: "test input",
    });
    await expect(promptApi.secretInput("Hook body")).resolves.toEqual({
      status: "ok",
      value: "secret input",
    });
    await expect(promptApi.select("Branch", [{ name: "Main", value: "main" }])).resolves.toEqual({
      status: "ok",
      value: "main",
    });
    await expect(
      promptApi.multiSelect("Options", [{ name: "One", value: "opt1" }]),
    ).resolves.toEqual({ status: "ok", value: ["opt1"] });

    expect(mockConfirm).toHaveBeenCalledWith({ default: true, message: "Continue?" });
    expect(mockInput).toHaveBeenCalledWith({ default: "default", message: "Name" });
    expect(mockPassword).toHaveBeenCalledWith({ mask: "", message: "Hook body" });
  });

  test.each([
    ["ExitPromptError", "exit"],
    ["AbortPromptError", "abort"],
  ] as const)("converts %s into a controlled cancellation", async (name, reason) => {
    mockConfirm.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name }));

    await expect(promptApi.confirm("Continue?")).resolves.toEqual({
      reason,
      status: "cancelled",
    });
  });

  test("rethrows non-cancellation prompt failures", async () => {
    mockInput.mockRejectedValueOnce(new Error("terminal unavailable"));

    await expect(promptApi.input("Name")).rejects.toThrow("terminal unavailable");
  });
});

describe("prompt validation", () => {
  test("select rejects an empty choices array", async () => {
    await expect(promptApi.select("Choose:", [])).rejects.toThrow(
      "Cannot display select prompt with empty choices array",
    );
  });

  test("multiSelect propagates empty-choice validation", async () => {
    await expect(promptApi.multiSelect("Choose:", [])).rejects.toThrow("No choices provided");
  });
});
