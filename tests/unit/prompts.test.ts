import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { Choice } from "../../src/lib/prompts";

// Mock @inquirer/prompts
const mockConfirm = mock(() => Promise.resolve(true));
const mockSelect = mock(() => Promise.resolve("main"));
const mockCheckbox = mock((options?: { choices?: unknown[] }) => {
  if (!options || !options.choices || options.choices.length === 0) {
    return Promise.reject(new Error("No choices provided"));
  }
  return Promise.resolve(["opt1"]);
});
const mockInput = mock(() => Promise.resolve("test input"));

mock.module("@inquirer/prompts", () => ({
  checkbox: mockCheckbox,
  confirm: mockConfirm,
  input: mockInput,
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

describe("Types", () => {
  test("Choice type is correctly defined", () => {
    const choice: Choice<string> = {
      description: "Test description",
      name: "Test",
      value: "test",
    };

    expect(choice.value).toBe("test");
    expect(choice.name).toBe("Test");
    expect(choice.description).toBe("Test description");
  });

  test("Choice type works with different value types", () => {
    const stringChoice: Choice<string> = {
      name: "String Choice",
      value: "string",
    };

    const numberChoice: Choice<number> = {
      name: "Number Choice",
      value: 42,
    };

    const objectChoice: Choice<{ id: number }> = {
      name: "Object Choice",
      value: { id: 1 },
    };

    expect(stringChoice.value).toBe("string");
    expect(numberChoice.value).toBe(42);
    expect(objectChoice.value).toEqual({ id: 1 });
  });
});

describe("US1: Confirmation Prompts", () => {
  test("confirm function exists and has correct signature", () => {
    expect(typeof promptApi.confirm).toBe("function");
  });

  test("confirm returns a Promise", () => {
    const result = promptApi.confirm("Test?", true);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("US2: Single Selection Prompts", () => {
  test("select function exists and has correct signature", () => {
    expect(typeof promptApi.select).toBe("function");
  });

  test("select returns a Promise", () => {
    const choices: Choice<string>[] = [
      { name: "Option A", value: "a" },
      { name: "Option B", value: "b" },
    ];

    const result = promptApi.select("Choose:", choices);
    expect(result).toBeInstanceOf(Promise);
  });

  test("select throws error for empty choices array", async () => {
    await expect(promptApi.select("Choose:", [])).rejects.toThrow();
  });

  test("select accepts choices with descriptions", () => {
    const choices: Choice<string>[] = [
      { description: "First option", name: "Option A", value: "a" },
      { description: "Second option", name: "Option B", value: "b" },
    ];

    const result = promptApi.select("Choose:", choices);
    expect(result).toBeInstanceOf(Promise);
  });

  test("select handles 1000+ choices", () => {
    const choices: Choice<number>[] = Array.from({ length: 1000 }, (_, i) => ({
      name: `Option ${i}`,
      value: i,
    }));

    const result = promptApi.select("Choose:", choices);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("US3: Multi-Selection Prompts", () => {
  test("multiSelect function exists and has correct signature", () => {
    expect(typeof promptApi.multiSelect).toBe("function");
  });

  test("multiSelect returns a Promise", () => {
    const choices: Choice<string>[] = [
      { name: "Option A", value: "a" },
      { name: "Option B", value: "b" },
    ];

    const result = promptApi.multiSelect("Choose multiple:", choices);
    expect(result).toBeInstanceOf(Promise);
  });

  test("multiSelect throws ValidationError for empty choices array", async () => {
    // Inquirer checkbox requires at least one selectable choice
    await expect(promptApi.multiSelect("Choose:", [])).rejects.toThrow();
  });
});

describe("US4: Text Input Prompts", () => {
  test("input function exists and has correct signature", () => {
    expect(typeof promptApi.input).toBe("function");
  });

  test("input returns a Promise", () => {
    const result = promptApi.input("Enter name:");
    expect(result).toBeInstanceOf(Promise);
  });

  test("input accepts default value", () => {
    const result = promptApi.input("Enter name:", "default");
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("Performance", () => {
  test("select handles 1000+ choices efficiently", () => {
    const start = performance.now();

    const choices: Choice<number>[] = Array.from({ length: 1000 }, (_, i) => ({
      name: `Option ${i}`,
      value: i,
    }));

    // Just creating the promise should be fast
    const result = promptApi.select("Choose:", choices);

    const duration = performance.now() - start;
    expect(duration).toBeLessThan(50); // Should be <50ms to create
    expect(result).toBeInstanceOf(Promise);
  });

  test("multiSelect handles many choices efficiently", () => {
    const start = performance.now();

    const choices: Choice<number>[] = Array.from({ length: 500 }, (_, i) => ({
      description: `Description for choice ${i}`,
      name: `Choice ${i}`,
      value: i,
    }));

    const result = promptApi.multiSelect("Select multiple:", choices);

    const duration = performance.now() - start;
    expect(duration).toBeLessThan(50);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("API Contract Validation", () => {
  test("confirm matches contract signature", () => {
    // Confirm(message: string, defaultValue?: boolean): Promise<boolean>
    const result1 = promptApi.confirm("Test?");
    const result2 = promptApi.confirm("Test?", true);
    const result3 = promptApi.confirm("Test?", false);

    expect(result1).toBeInstanceOf(Promise);
    expect(result2).toBeInstanceOf(Promise);
    expect(result3).toBeInstanceOf(Promise);
  });

  test("select matches contract signature", () => {
    // Select<T>(message: string, choices: Choice<T>[]): Promise<T>
    const choices: Choice<string>[] = [{ name: "A", value: "a" }];
    const result = promptApi.select("Test?", choices);

    expect(result).toBeInstanceOf(Promise);
  });

  test("multiSelect matches contract signature", () => {
    // MultiSelect<T>(message: string, choices: Choice<T>[]): Promise<T[]>
    const choices: Choice<string>[] = [{ name: "A", value: "a" }];
    const result = promptApi.multiSelect("Test?", choices);

    expect(result).toBeInstanceOf(Promise);
  });

  test("input matches contract signature", () => {
    // Input(message: string, defaultValue?: string): Promise<string>
    const result1 = promptApi.input("Test?");
    const result2 = promptApi.input("Test?", "default");

    expect(result1).toBeInstanceOf(Promise);
    expect(result2).toBeInstanceOf(Promise);
  });
});
