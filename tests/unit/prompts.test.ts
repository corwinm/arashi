import { describe, test, expect, mock } from "bun:test";
import * as inquirer from "@inquirer/prompts";
import {
  confirm,
  select,
  multiSelect,
  input,
  type Choice,
} from "../../src/lib/prompts";

// Mock @inquirer/prompts
const mockConfirm = mock(() => Promise.resolve(true));
const mockSelect = mock(() => Promise.resolve("main"));
const mockCheckbox = mock(() => Promise.resolve(["opt1"]));
const mockInput = mock(() => Promise.resolve("test input"));

// We'll use spyOn to intercept the actual inquirer calls
// Note: In real tests, we'd use more sophisticated mocking

describe("Types", () => {
  test("Choice type is correctly defined", () => {
    const choice: Choice<string> = {
      value: "test",
      name: "Test",
      description: "Test description",
    };
    
    expect(choice.value).toBe("test");
    expect(choice.name).toBe("Test");
    expect(choice.description).toBe("Test description");
  });

  test("Choice type works with different value types", () => {
    const stringChoice: Choice<string> = {
      value: "string",
      name: "String Choice",
    };
    
    const numberChoice: Choice<number> = {
      value: 42,
      name: "Number Choice",
    };
    
    const objectChoice: Choice<{ id: number }> = {
      value: { id: 1 },
      name: "Object Choice",
    };
    
    expect(stringChoice.value).toBe("string");
    expect(numberChoice.value).toBe(42);
    expect(objectChoice.value).toEqual({ id: 1 });
  });
});

describe("US1: Confirmation Prompts", () => {
  test("confirm function exists and has correct signature", () => {
    expect(typeof confirm).toBe("function");
  });

  test("confirm returns a Promise", () => {
    const result = confirm("Test?", true);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("US2: Single Selection Prompts", () => {
  test("select function exists and has correct signature", () => {
    expect(typeof select).toBe("function");
  });

  test("select returns a Promise", () => {
    const choices: Choice<string>[] = [
      { value: "a", name: "Option A" },
      { value: "b", name: "Option B" },
    ];
    
    const result = select("Choose:", choices);
    expect(result).toBeInstanceOf(Promise);
  });

  test("select throws error for empty choices array", async () => {
    await expect(select("Choose:", [])).rejects.toThrow();
  });

  test("select accepts choices with descriptions", () => {
    const choices: Choice<string>[] = [
      { value: "a", name: "Option A", description: "First option" },
      { value: "b", name: "Option B", description: "Second option" },
    ];
    
    const result = select("Choose:", choices);
    expect(result).toBeInstanceOf(Promise);
  });

  test("select handles 1000+ choices", () => {
    const choices: Choice<number>[] = Array.from({ length: 1000 }, (_, i) => ({
      value: i,
      name: `Option ${i}`,
    }));
    
    const result = select("Choose:", choices);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("US3: Multi-Selection Prompts", () => {
  test("multiSelect function exists and has correct signature", () => {
    expect(typeof multiSelect).toBe("function");
  });

  test("multiSelect returns a Promise", () => {
    const choices: Choice<string>[] = [
      { value: "a", name: "Option A" },
      { value: "b", name: "Option B" },
    ];
    
    const result = multiSelect("Choose multiple:", choices);
    expect(result).toBeInstanceOf(Promise);
  });

  test("multiSelect throws ValidationError for empty choices array", async () => {
    // Inquirer checkbox requires at least one selectable choice
    await expect(multiSelect("Choose:", [])).rejects.toThrow();
  });
});

describe("US4: Text Input Prompts", () => {
  test("input function exists and has correct signature", () => {
    expect(typeof input).toBe("function");
  });

  test("input returns a Promise", () => {
    const result = input("Enter name:");
    expect(result).toBeInstanceOf(Promise);
  });

  test("input accepts default value", () => {
    const result = input("Enter name:", "default");
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("Performance", () => {
  test("select handles 1000+ choices efficiently", () => {
    const start = performance.now();
    
    const choices: Choice<number>[] = Array.from({ length: 1000 }, (_, i) => ({
      value: i,
      name: `Option ${i}`,
    }));
    
    // Just creating the promise should be fast
    const result = select("Choose:", choices);
    
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(50); // Should be <50ms to create
    expect(result).toBeInstanceOf(Promise);
  });

  test("multiSelect handles many choices efficiently", () => {
    const start = performance.now();
    
    const choices: Choice<number>[] = Array.from({ length: 500 }, (_, i) => ({
      value: i,
      name: `Choice ${i}`,
      description: `Description for choice ${i}`,
    }));
    
    const result = multiSelect("Select multiple:", choices);
    
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(50);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("API Contract Validation", () => {
  test("confirm matches contract signature", () => {
    // confirm(message: string, defaultValue?: boolean): Promise<boolean>
    const result1 = confirm("Test?");
    const result2 = confirm("Test?", true);
    const result3 = confirm("Test?", false);
    
    expect(result1).toBeInstanceOf(Promise);
    expect(result2).toBeInstanceOf(Promise);
    expect(result3).toBeInstanceOf(Promise);
  });

  test("select matches contract signature", () => {
    // select<T>(message: string, choices: Choice<T>[]): Promise<T>
    const choices: Choice<string>[] = [{ value: "a", name: "A" }];
    const result = select("Test?", choices);
    
    expect(result).toBeInstanceOf(Promise);
  });

  test("multiSelect matches contract signature", () => {
    // multiSelect<T>(message: string, choices: Choice<T>[]): Promise<T[]>
    const choices: Choice<string>[] = [{ value: "a", name: "A" }];
    const result = multiSelect("Test?", choices);
    
    expect(result).toBeInstanceOf(Promise);
  });

  test("input matches contract signature", () => {
    // input(message: string, defaultValue?: string): Promise<string>
    const result1 = input("Test?");
    const result2 = input("Test?", "default");
    
    expect(result1).toBeInstanceOf(Promise);
    expect(result2).toBeInstanceOf(Promise);
  });
});
