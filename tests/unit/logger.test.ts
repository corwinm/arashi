import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  error,
  info,
  section,
  spinner,
  success,
  table,
  warn,
  withSpinnerPaused,
} from "../../src/lib/logger";

// Capture console output
let consoleOutput: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  consoleOutput = [];

  // Mock console.log and console.error to capture output
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;

  // Clean up environment
  delete process.env.NO_COLOR;
});

describe("US1: Message Output Functions", () => {
  test("info prints message with default color", () => {
    info("Test info message");

    const output = consoleOutput.join("");
    expect(output).toContain("Test info message");
  });

  test("success prints message in green with ✓ symbol", () => {
    success("Test success message");

    const output = consoleOutput.join("");
    expect(output).toContain("✓");
    expect(output).toContain("Test success message");
  });

  test("warn prints message in yellow with ⚠ symbol", () => {
    warn("Test warning message");

    const output = consoleOutput.join("");
    expect(output).toContain("⚠");
    expect(output).toContain("Test warning message");
  });

  test("error prints message in red with ✗ symbol", () => {
    error("Test error message");

    const output = consoleOutput.join("");
    expect(output).toContain("✗");
    expect(output).toContain("Test error message");
  });
});

describe("US2: Spinner Display", () => {
  test("spinner preserves its initial text", () => {
    expect(spinner("Processing...").text).toBe("Processing...");
  });

  test("pauses spinner output while another operation writes to the terminal", async () => {
    const events: string[] = [];
    const pausableSpinner = {
      isSpinning: true,
      start: () => events.push("spinner:start"),
      stopAndPersist: () => events.push("spinner:persist"),
    };

    await withSpinnerPaused(pausableSpinner, async () => {
      events.push("hook:output");
    });

    expect(events).toEqual(["spinner:persist", "hook:output", "spinner:start"]);
  });

  test("restarts paused spinner output when the operation fails", async () => {
    const events: string[] = [];
    const pausableSpinner = {
      isSpinning: true,
      start: () => events.push("spinner:start"),
      stopAndPersist: () => events.push("spinner:persist"),
    };

    await expect(
      withSpinnerPaused(pausableSpinner, async () => {
        events.push("hook:output");
        throw new Error("hook failed");
      }),
    ).rejects.toThrow("hook failed");

    expect(events).toEqual(["spinner:persist", "hook:output", "spinner:start"]);
  });

  test("does not restart a spinner when animation is disabled", async () => {
    const events: string[] = [];
    const inactiveSpinner = {
      isSpinning: false,
      start: () => events.push("spinner:start"),
      stopAndPersist: () => events.push("spinner:persist"),
    };

    await withSpinnerPaused(inactiveSpinner, async () => {
      events.push("hook:output");
    });

    expect(events).toEqual(["hook:output"]);
  });
});

describe("US3: Table Formatting", () => {
  test("table formats data with aligned columns", () => {
    const data = [
      { age: "30", city: "NYC", name: "Alice" },
      { age: "25", city: "SF", name: "Bob" },
    ];

    table(data);

    const output = consoleOutput.join("");
    expect(output).toContain("Alice");
    expect(output).toContain("Bob");
    expect(output).toContain("30");
    expect(output).toContain("25");
    expect(output).toContain("NYC");
    expect(output).toContain("SF");
  });

  test("table handles empty array", () => {
    table([]);

    const output = consoleOutput.join("");
    // Should not crash, output may be empty
    expect(output).toBeDefined();
  });

  test("table handles single row", () => {
    const data = [{ name: "Alice", status: "active" }];

    table(data);

    const output = consoleOutput.join("");
    expect(output).toContain("Alice");
    expect(output).toContain("active");
  });

  test("table auto-sizes columns based on content", () => {
    const data = [
      { long: "very long content here", short: "a" },
      { long: "x", short: "b" },
    ];

    table(data);

    const output = consoleOutput.join("");
    expect(output).toContain("very long content here");
    // Column should be wide enough for longest content
  });
});

describe("US4: Section Headers", () => {
  test("section prints title with visual emphasis", () => {
    section("Test Section");

    const output = consoleOutput.join("");
    expect(output).toContain("Test Section");
  });

  test("section handles empty string", () => {
    section("");

    const output = consoleOutput.join("");
    expect(output).toBeDefined();
  });

  test("section handles long titles", () => {
    const longTitle = "This is a very long section title that spans multiple words";
    section(longTitle);

    const output = consoleOutput.join("");
    expect(output).toContain(longTitle);
  });
});

describe("US5: NO_COLOR Support", () => {
  beforeEach(() => {
    process.env.NO_COLOR = "1";
  });

  test("success uses [OK] instead of ✓ with NO_COLOR", () => {
    success("Success message");

    const output = consoleOutput.join("");
    expect(output).toContain("[OK]");
    expect(output).not.toContain("✓");
  });

  test("warn uses [WARN] instead of ⚠ with NO_COLOR", () => {
    warn("Warning message");

    const output = consoleOutput.join("");
    expect(output).toContain("[WARN]");
    expect(output).not.toContain("⚠");
  });

  test("error uses [ERR] instead of ✗ with NO_COLOR", () => {
    error("Error message");

    const output = consoleOutput.join("");
    expect(output).toContain("[ERR]");
    expect(output).not.toContain("✗");
  });

  test("info has no colors with NO_COLOR", () => {
    info("Info message");

    const output = consoleOutput.join("");
    expect(output).toContain("Info message");
  });

  test("section has no formatting with NO_COLOR", () => {
    section("Section Title");

    const output = consoleOutput.join("");
    expect(output).toContain("Section Title");
  });

  test("table has no colors with NO_COLOR", () => {
    const data = [{ name: "Alice", status: "active" }];

    table(data);

    const output = consoleOutput.join("");
    expect(output).toContain("Alice");
  });
});
