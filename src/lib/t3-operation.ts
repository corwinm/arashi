import { T3HandoffError } from "./t3-error.ts";

/** Readiness-only controls. deadline and now share the same monotonic clock. */
export interface T3ReadControls {
  signal?: AbortSignal;
  deadline: number;
  now?: () => number;
}
export const t3Now = () => performance.now();
export const t3ReadError = (code: string) =>
  new T3HandoffError(code, "The bounded official T3 read was interrupted or unavailable.");
export function checkT3Read(control: T3ReadControls): void {
  if (control.signal?.aborted) throw t3ReadError("T3_CHECK_CANCELLED");
  if (control.deadline <= (control.now ?? t3Now)()) throw t3ReadError("T3_CHECK_TIMEOUT");
}

/** Abort the actual operation, not only its promise. Production dependencies
 * cooperate by stopping children/streams/sockets. Arbitrary injected effects
 * cannot be forcibly cancelled; late issuance is observed by its owning ledger.
 * Issuance gets at most 250ms to return captured attributable output after stop.
 */
export async function runT3Read<T>(
  control: T3ReadControls,
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    interruptedOutput?: boolean;
    lateOutput?: (value: T) => void;
    interrupted?: (error: T3HandoffError) => void;
    operationMs?: number;
    timeoutCode?: string;
  } = {},
): Promise<T> {
  checkT3Read(control);
  const remaining = control.deadline - (control.now ?? t3Now)();
  const controller = new AbortController();
  let stopped: T3HandoffError | undefined;
  let returned = false;
  let timer: ReturnType<typeof setTimeout>;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (error: T3HandoffError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  const stop = (code: string) => {
    if (stopped) return;
    stopped = t3ReadError(code);
    options.interrupted?.(stopped);
    controller.abort(stopped);
    if (options.interruptedOutput) grace = setTimeout(() => rejectStop(stopped!), 250);
    else rejectStop(stopped);
  };
  const abort = () => stop("T3_CHECK_CANCELLED");
  control.signal?.addEventListener("abort", abort, { once: true });
  const operationMs = options.operationMs ?? 15_000;
  timer = setTimeout(
    () =>
      stop(
        remaining <= operationMs ? "T3_CHECK_TIMEOUT" : (options.timeoutCode ?? "T3_UNREACHABLE"),
      ),
    Math.min(operationMs, remaining),
  );
  const effect = Promise.resolve().then(() => {
    // Close the subscription/operation-entry race without issuing after cancel.
    checkT3Read(control);
    return operation(controller.signal);
  });
  void effect.then(
    (value) => {
      if (returned && stopped) options.lateOutput?.(value);
    },
    () => {},
  );
  try {
    const value = await Promise.race([effect, interrupted]);
    if (stopped && !options.interruptedOutput) throw stopped;
    return value;
  } catch (error) {
    throw stopped ?? error;
  } finally {
    returned = true;
    clearTimeout(timer);
    if (grace !== undefined) clearTimeout(grace);
    control.signal?.removeEventListener("abort", abort);
    // Even early protocol/status/byte failures must release the real fetch or
    // process effect, not leave it alive until a now-cleared operation timer.
    controller.abort(stopped);
  }
}
