export enum SwitchCommandErrorCode {
  NO_TARGETS = "NO_TARGETS",
  NO_MATCHES = "NO_MATCHES",
  AMBIGUOUS_NON_INTERACTIVE = "AMBIGUOUS_NON_INTERACTIVE",
  USER_CANCELLED = "USER_CANCELLED",
  SESH_REQUIRES_TMUX = "SESH_REQUIRES_TMUX",
  SESH_NOT_FOUND = "SESH_NOT_FOUND",
  LAUNCH_FAILED = "LAUNCH_FAILED",
}

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

export type SwitchLaunchMode = "sesh" | "tmux" | "vscode" | "fallback";
