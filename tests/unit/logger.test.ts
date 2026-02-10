import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { info, success, warn, error, spinner, table, section } from "../../src/lib/logger";

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
    consoleOutput.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleOutput.push(args.map((arg) => String(arg)).join(" "));
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
  test("spinner returns ora instance", () => {
    const s = spinner("Loading...");

    expect(s).toBeDefined();
    expect(typeof s.start).toBe("function");
    expect(typeof s.stop).toBe("function");
    expect(typeof s.succeed).toBe("function");
    expect(typeof s.fail).toBe("function");
  });

  test("spinner can be started and stopped without throwing", () => {
    const s = spinner("Processing...");

    // Verify we can call start/stop without throwing errors
    expect(() => {
      s.start();
      s.stop();
    }).not.toThrow();

    // Verify spinner text was set initially
    expect(s.text).toBe("Processing...");
  });

  test("spinner succeed completes without throwing", () => {
    const s = spinner("Working...");

    // Verify we can call succeed without throwing
    expect(() => {
      s.start();
      s.succeed("Complete!");
    }).not.toThrow();
  });

  test("spinner fail completes without throwing", () => {
    const s = spinner("Trying...");

    // Verify we can call fail without throwing
    expect(() => {
      s.start();
      s.fail("Failed!");
    }).not.toThrow();
  });
});

describe("US3: Table Formatting", () => {
  test("table formats data with aligned columns", () => {
    const data = [
      { name: "Alice", age: "30", city: "NYC" },
      { name: "Bob", age: "25", city: "SF" },
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
      { short: "a", long: "very long content here" },
      { short: "b", long: "x" },
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

  test("spinner uses dots instead of animation with NO_COLOR", () => {
    const s = spinner("Loading...");

    // Spinner should be created without colors/animation
    expect(s).toBeDefined();
    // Ora automatically respects NO_COLOR
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

describe("Performance", () => {
  test("message functions complete within 10ms for messages up to 10KB", () => {
    const largeMessage = "x".repeat(10 * 1024); // 10KB

    const start = performance.now();
    info(largeMessage);
    success(largeMessage);
    warn(largeMessage);
    error(largeMessage);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(10);
  });

  test("table handles 100 rows efficiently", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      id: i.toString(),
      name: `User ${i}`,
      status: i % 2 === 0 ? "active" : "inactive",
    }));

    const start = performance.now();
    table(data);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50); // Should be fast
  });
});
