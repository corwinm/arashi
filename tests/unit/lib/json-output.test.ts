import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  stringifyJsonEnvelope,
  unknownErrorToJsonError,
} from "../../../src/lib/json-output.ts";
import { EmptyRepositoryFiltersError } from "../../../src/lib/repo-filter.ts";
import { describe, expect, test } from "vitest";

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

  test("preserves structured repository-filter usage errors", () => {
    expect(unknownErrorToJsonError(new EmptyRepositoryFiltersError(["only", "group"]))).toEqual({
      code: "EMPTY_REPOSITORY_FILTERS",
      details: { emptyFilters: ["only", "group"] },
      message: "Explicitly empty repository filters: --only, --group",
    });
  });
});
