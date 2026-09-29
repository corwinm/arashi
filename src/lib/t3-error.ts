import type { T3HandoffResult } from "./t3-handoff.ts";

export class T3HandoffError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly result?: T3HandoffResult;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    result?: T3HandoffResult,
  ) {
    super(message);
    this.name = "T3HandoffError";
    this.code = code;
    this.details = details;
    this.result = result;
  }
}
