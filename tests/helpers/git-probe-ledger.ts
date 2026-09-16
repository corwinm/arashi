import { expect } from "vitest";

export interface ProbeCall {
  executable: string;
  argv: string[];
  cwd: string;
  environment: Record<string, string>;
  parser: string;
  attemptToken: number | null;
  generation: number;
  repository: string | null;
}
export interface ProbeResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}
export const result = (stdout = "", exitCode = 0, stderr = ""): ProbeResult => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(stderr),
  exitCode,
});
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export class ProbeLedger {
  readonly calls: Array<ProbeCall & { stdout?: Buffer }> = [];
  readonly pending: Array<{ argv: string[]; reply: ProbeResult | Promise<ProbeResult> }> = [];
  enqueue(argv: string[], reply: ProbeResult | Promise<ProbeResult>) {
    this.pending.push({ argv, reply });
    return this;
  }
  run = async (call: ProbeCall): Promise<ProbeResult> => {
    const entry: ProbeCall & { stdout?: Buffer } = { ...call };
    this.calls.push(entry);
    const step = this.pending.shift();
    expect(step, "Unexpected Git subprocess").toBeDefined();
    expect(call.argv).toEqual(step!.argv);
    expect(call.executable).toBe("/tools/git");
    expect(call.cwd.startsWith("/")).toBe(true);
    expect(typeof call.parser).toBe("string");
    const reply = await step!.reply;
    entry.stdout = reply.stdout;
    return reply;
  };
}
