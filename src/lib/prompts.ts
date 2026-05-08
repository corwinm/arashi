import {
  checkbox as inquirerCheckbox,
  confirm as inquirerConfirm,
  input as inquirerInput,
  select as inquirerSelect,
} from "@inquirer/prompts";
import readline from "readline";

// ============================================================================
// Types
// ============================================================================

/**
 * Choice type for select and multiSelect prompts
 */
export interface Choice<T> {
  value: T;
  name: string;
  description?: string;
}

export type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason: "exit" | "abort" };

interface PromptKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

// ============================================================================
// Prompt Outcome Wrapper
// ============================================================================

/**
 * Convert prompt cancellation into a controlled outcome
 * This wrapper ensures consistent behavior across all prompt functions
 */
async function withPromptOutcome<T>(promptFn: () => Promise<T>): Promise<PromptOutcome<T>> {
  try {
    const value = await promptFn();
    return { status: "ok", value };
  } catch (error: unknown) {
    const promptError =
      typeof error === "object" && error !== null
        ? (error as { name?: string; message?: string })
        : undefined;

    // Check if this is a Ctrl+C / cancellation error
    if (
      promptError?.name === "ExitPromptError" ||
      promptError?.name === "AbortPromptError" ||
      promptError?.message?.includes("User force closed")
    ) {
      const reason = promptError?.name === "AbortPromptError" ? "abort" : "exit";
      return { reason, status: "cancelled" };
    }
    // Re-throw other errors
    throw error;
  }
}

function handleVimNavigationKeypress(_str: string, key: PromptKey): void {
  if (!key || key.ctrl || key.meta) {
    return;
  }

  if (key.name === "j") {
    process.stdin.emit("keypress", "", { ctrl: false, meta: false, name: "down", shift: false });
  }

  if (key.name === "k") {
    process.stdin.emit("keypress", "", { ctrl: false, meta: false, name: "up", shift: false });
  }
}

function withVimNavigation<T>(
  promptFn: () => Promise<PromptOutcome<T>>,
): Promise<PromptOutcome<T>> {
  if (!process.stdin.isTTY) {
    return promptFn();
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", handleVimNavigationKeypress);
  return promptFn().finally(() => {
    process.stdin.off("keypress", handleVimNavigationKeypress);
  });
}

// ============================================================================
// US1: Confirmation Prompts
// ============================================================================

/**
 * Display yes/no prompt and return user's choice
 *
 * @param message - Prompt message to display
 * @param defaultValue - Default value if user presses Enter (optional)
 * @returns User's boolean choice
 *
 * @example
 * ```typescript
 * const shouldDelete = await confirm('Delete worktree?', false);
 * if (shouldDelete) {
 *   // perform deletion
 * }
 * ```
 *
 * **Ctrl+C**: Exits process with code 2
 */
export function confirm(message: string, defaultValue?: boolean): Promise<PromptOutcome<boolean>> {
  return withPromptOutcome(() =>
    inquirerConfirm({
      default: defaultValue,
      message,
    }),
  );
}

// ============================================================================
// US2: Single Selection Prompts
// ============================================================================

/**
 * Display single-selection list and return selected value
 *
 * @param message - Prompt message to display
 * @param choices - Array of choices with value, name, and optional description
 * @returns Selected value of type T
 * @throws Error if choices array is empty
 *
 * @example
 * ```typescript
 * const branch = await select('Select branch:', [
 *   { value: 'main', name: 'main', description: 'Main branch' },
 *   { value: 'dev', name: 'dev', description: 'Development branch' }
 * ]);
 * ```
 *
 * **Ctrl+C**: Exits process with code 2
 */
export function select<T>(message: string, choices: Choice<T>[]): Promise<PromptOutcome<T>> {
  if (choices.length === 0) {
    return Promise.reject(new Error("Cannot display select prompt with empty choices array"));
  }

  return withVimNavigation(() =>
    withPromptOutcome(() =>
      inquirerSelect({
        choices,
        message,
      }),
    ),
  );
}

// ============================================================================
// US3: Multi-Selection Prompts
// ============================================================================

/**
 * Display multi-selection list (checkboxes) and return array of selected values
 *
 * @param message - Prompt message to display
 * @param choices - Array of choices with value, name, and optional description
 * @returns Array of selected values of type T
 *
 * @example
 * ```typescript
 * const features = await multiSelect('Select features:', [
 *   { value: 'auth', name: 'Authentication' },
 *   { value: 'db', name: 'Database' },
 *   { value: 'api', name: 'API' }
 * ]);
 * console.log(`Selected: ${features.join(', ')}`);
 * ```
 *
 * **Ctrl+C**: Exits process with code 2
 */
export function multiSelect<T>(message: string, choices: Choice<T>[]): Promise<PromptOutcome<T[]>> {
  return withVimNavigation(() =>
    withPromptOutcome(() =>
      inquirerCheckbox({
        choices,
        message,
      }),
    ),
  );
}

// ============================================================================
// US4: Text Input Prompts
// ============================================================================

/**
 * Display text input prompt and return entered string
 *
 * @param message - Prompt message to display
 * @param defaultValue - Default value if user presses Enter (optional)
 * @returns User's input string
 *
 * @example
 * ```typescript
 * const name = await input('Enter your name:', 'Anonymous');
 * console.log(`Hello, ${name}!`);
 * ```
 *
 * **Ctrl+C**: Exits process with code 2
 */
export function input(message: string, defaultValue?: string): Promise<PromptOutcome<string>> {
  return withPromptOutcome(() =>
    inquirerInput({
      default: defaultValue,
      message,
    }),
  );
}
