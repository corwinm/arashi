import type { EventEmitter } from "node:events";

export function waitForProcessClose(child: EventEmitter): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code: number | null) => resolve(code ?? 1));
  });
}
