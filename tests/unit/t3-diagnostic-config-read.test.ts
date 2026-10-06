import { afterEach, expect, test, vi } from "vitest";
import { constants } from "node:fs";
import {
  readDiagnosticConfigText,
  MAX_DIAGNOSTIC_CONFIG_BYTES,
} from "../../src/lib/diagnostic-config-read.ts";
const handles = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open: handles.open }));
afterEach(() => vi.resetAllMocks());
function handle(
  bytes: Buffer,
  options: { regular?: boolean; size?: number; failure?: "stat" | "read" } = {},
) {
  let position = 0;
  const file = {
    stat: vi.fn(async () => {
      if (options.failure === "stat") throw new Error("private path");
      return { isFile: () => options.regular !== false, size: options.size ?? bytes.length };
    }),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      if (options.failure === "read") throw new Error("private path");
      // Short reads include UTF-8 split across read boundaries.
      const count = Math.min(bytes.length > 1024 ? 65536 : 17, length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + count);
      position += count;
      return { bytesRead: count };
    }),
    close: vi.fn(async () => {}),
  };
  handles.open.mockResolvedValue(file);
  return file;
}
test("loops over partial reads and decodes UTF-8 after byte collection", async () => {
  const text = ' {"value":"é🙂"} '.repeat(4);
  const file = handle(Buffer.from(text));
  expect(await readDiagnosticConfigText("owned")).toBe(text);
  expect(handles.open).toHaveBeenCalledWith("owned", constants.O_RDONLY | constants.O_NONBLOCK);
  expect(file.read.mock.calls.length).toBeGreaterThan(1);
  expect(file.close).toHaveBeenCalledTimes(1);
});
test("rejects growth past the whole-document byte budget despite a small stat", async () => {
  const file = handle(Buffer.alloc(MAX_DIAGNOSTIC_CONFIG_BYTES + 100), { size: 1 });
  await expect(readDiagnosticConfigText("owned")).rejects.toThrow("byte budget");
  const total = file.read.mock.calls.reduce(
    (sum, [, , length]) => sum + Math.min(65536, length),
    0,
  );
  expect(total).toBe(MAX_DIAGNOSTIC_CONFIG_BYTES + 1);
  expect(file.close).toHaveBeenCalledTimes(1);
});
test.each(["stat", "read"] as const)("closes after %s failure", async (failure) => {
  const file = handle(Buffer.from("{}"), { failure });
  await expect(readDiagnosticConfigText("owned")).rejects.toThrow();
  expect(file.close).toHaveBeenCalledTimes(1);
});
test("rejects nonregular opened targets before any read and closes", async () => {
  const file = handle(Buffer.from("{}"), { regular: false });
  await expect(readDiagnosticConfigText("owned")).rejects.toThrow();
  expect(file.read).not.toHaveBeenCalled();
  expect(file.close).toHaveBeenCalledTimes(1);
});
