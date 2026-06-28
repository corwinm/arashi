import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  stringifyJsonEnvelope,
} from "../../../src/lib/json-output.ts";
import { describe, expect, test } from "bun:test";

describe("json output envelopes", () => {
  test("creates a parseable success envelope", () => {
    const output = stringifyJsonEnvelope(
      createJsonSuccessEnvelope("status", { repositories: [], summary: { total: 0 } }, [
        { code: "NO_REPOS", message: "No repositories configured" },
      ]),
    );

    const parsed = JSON.parse(output);

    expect(parsed).toEqual({
      command: "status",
      data: { repositories: [], summary: { total: 0 } },
      ok: true,
      schemaVersion: 1,
      warnings: [{ code: "NO_REPOS", message: "No repositories configured" }],
    });
  });

  test("creates a parseable failure envelope", () => {
    const output = stringifyJsonEnvelope(
      createJsonErrorEnvelope("create", {
        code: "INTERACTIVE_INPUT_REQUIRED",
        details: { flag: "--only" },
        message: "JSON mode requires explicit repository selection",
      }),
    );

    const parsed = JSON.parse(output);

    expect(parsed).toEqual({
      command: "create",
      error: {
        code: "INTERACTIVE_INPUT_REQUIRED",
        details: { flag: "--only" },
        message: "JSON mode requires explicit repository selection",
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });
});
