import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");

describe("secret prompt raw PTY", () => {
  test("terminal bytes disclose no body or body derivative", () => {
    const canary = "SECRET-Pty:/274?body=value";
    const result = spawnSync(
      process.execPath,
      [join(root, "tests/helpers/secret-prompt-pty.mjs"), root, canary],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const transcript = Buffer.from(result.stdout, "base64").toString("utf8");
    expect(transcript).toContain("__SECRET_PROMPT_DONE__");
    for (const derivative of [
      canary,
      canary.slice(0, 8),
      Buffer.from(canary).toString("base64"),
      Buffer.from(canary).toString("hex"),
      encodeURIComponent(canary),
      canary.replaceAll(/[/?:=]/g, (character) => `\\${character}`),
      createHash("sha256").update(canary).digest("hex"),
      "*".repeat(canary.length),
    ]) {
      expect(transcript).not.toContain(derivative);
    }
  });
});
