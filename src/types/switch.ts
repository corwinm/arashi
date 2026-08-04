export const SwitchCommandErrorCode = {
  NO_TARGETS: "NO_TARGETS",
  NO_MATCHES: "NO_MATCHES",
  AMBIGUOUS_NON_INTERACTIVE: "AMBIGUOUS_NON_INTERACTIVE",
  USER_CANCELLED: "USER_CANCELLED",
  CONFLICTING_LAUNCH_OPTIONS: "CONFLICTING_LAUNCH_OPTIONS",
  SESH_REQUIRES_TMUX: "SESH_REQUIRES_TMUX",
  TMUX_CONTEXT_REQUIRED: "TMUX_CONTEXT_REQUIRED",
  SESH_NOT_FOUND: "SESH_NOT_FOUND",
  IDE_NOT_FOUND: "IDE_NOT_FOUND",
  LAUNCH_FAILED: "LAUNCH_FAILED",
  TAB_DISPOSITION_UNSUPPORTED: "TAB_DISPOSITION_UNSUPPORTED",
  CONFLICTING_SWITCH_OPTIONS: "CONFLICTING_SWITCH_OPTIONS",
} as const;

export type SwitchCommandErrorCode =
  (typeof SwitchCommandErrorCode)[keyof typeof SwitchCommandErrorCode];

export class SwitchCommandError extends Error {
  readonly name = "SwitchCommandError" as const;
  readonly code: SwitchCommandErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: SwitchCommandErrorCode, context?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.context = context;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SwitchCommandError);
    }
  }
}

export type SwitchLaunchMode =
  | "cd"
  | "sesh"
  | "tmux"
  | "herdr"
  | "cmux"
  | "kitty"
  | "vscode"
  | "cursor"
  | "kiro"
  | "fallback";
