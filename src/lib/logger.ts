import chalk from "chalk";
import ora, { Ora } from "ora";

// ============================================================================
// NO_COLOR Detection
// ============================================================================

/**
 * Check if colors should be disabled based on NO_COLOR environment variable
 * Follows the NO_COLOR standard: https://no-color.org/
 */
function shouldDisableColors(): boolean {
  return process.env.NO_COLOR !== undefined;
}

// ============================================================================
// Symbol Helpers
// ============================================================================

/**
 * Get appropriate symbol based on NO_COLOR setting
 */
function getSymbol(colored: string, plain: string): string {
  return shouldDisableColors() ? plain : colored;
}

/**
 * Apply color if colors are enabled
 */
function applyColor(text: string, colorFn: (text: string) => string): string {
  return shouldDisableColors() ? text : colorFn(text);
}

// ============================================================================
// US1: Message Output Functions
// ============================================================================

/**
 * Print informational message in default color
 * 
 * @param message - Message to print
 */
export function info(message: string): void {
  console.log(message);
}

/**
 * Print success message in green with ✓ symbol
 * 
 * @param message - Success message to print
 */
export function success(message: string): void {
  const symbol = getSymbol("✓", "[OK]");
  const formatted = applyColor(`${symbol} ${message}`, chalk.green);
  console.log(formatted);
}

/**
 * Print warning message in yellow with ⚠ symbol
 * 
 * @param message - Warning message to print
 */
export function warn(message: string): void {
  const symbol = getSymbol("⚠", "[WARN]");
  const formatted = applyColor(`${symbol} ${message}`, chalk.yellow);
  console.error(formatted);
}

/**
 * Print error message in red with ✗ symbol
 * 
 * @param message - Error message to print
 */
export function error(message: string): void {
  const symbol = getSymbol("✗", "[ERR]");
  const formatted = applyColor(`${symbol} ${message}`, chalk.red);
  console.error(formatted);
}

// ============================================================================
// US2: Spinner Display
// ============================================================================

/**
 * Create and return ora spinner instance
 * 
 * Caller controls start/stop/succeed/fail.
 * Automatically respects NO_COLOR environment variable.
 * 
 * @param text - Initial spinner text
 * @returns Ora spinner instance
 * 
 * @example
 * ```typescript
 * const s = spinner('Loading...');
 * s.start();
 * // do work
 * s.succeed('Done!');
 * ```
 */
export function spinner(text: string): Ora {
  return ora({
    text,
    // Ora automatically respects NO_COLOR environment variable
    // When NO_COLOR is set, it uses simpler output without animation
  });
}

// ============================================================================
// US3: Table Formatting
// ============================================================================

/**
 * Format and print tabular data with auto-sized columns
 * 
 * @param data - Array of records to display as table
 * 
 * @example
 * ```typescript
 * table([
 *   { name: "Alice", age: "30", city: "NYC" },
 *   { name: "Bob", age: "25", city: "SF" },
 * ]);
 * ```
 */
export function table(data: Array<Record<string, string>>): void {
  if (data.length === 0) {
    return;
  }

  // Get all unique column names from all rows
  const columns = Array.from(
    new Set(data.flatMap(row => Object.keys(row)))
  );

  // Calculate maximum width for each column
  const columnWidths: Record<string, number> = {};
  for (const col of columns) {
    // Start with header width
    columnWidths[col] = col.length;
    
    // Check all row values
    for (const row of data) {
      const value = row[col] || "";
      columnWidths[col] = Math.max(columnWidths[col], value.length);
    }
  }

  // Format and print header
  const header = columns
    .map(col => col.padEnd(columnWidths[col]))
    .join("  ");
  
  const headerFormatted = applyColor(header, chalk.bold);
  console.log(headerFormatted);

  // Print separator
  const separator = columns
    .map(col => "-".repeat(columnWidths[col]))
    .join("  ");
  console.log(separator);

  // Print rows
  for (const row of data) {
    const rowStr = columns
      .map(col => (row[col] || "").padEnd(columnWidths[col]))
      .join("  ");
    console.log(rowStr);
  }
}

// ============================================================================
// US4: Section Headers
// ============================================================================

/**
 * Print section header with visual emphasis (bold/underline)
 * 
 * @param title - Section title to print
 */
export function section(title: string): void {
  const formatted = applyColor(title, text => chalk.bold.underline(text));
  console.log();
  console.log(formatted);
  console.log();
}
