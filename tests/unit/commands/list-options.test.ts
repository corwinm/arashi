import { describe, expect, it } from "vitest";
import { parseMaxDepth } from "../../../src/commands/list.ts";

describe("parseMaxDepth", () => {
  it.each([
    ["0", 0],
    ["1", 1],
    ["3", 3],
  ])("parses %s as a non-negative integer", (value, expected) => {
    expect(parseMaxDepth(value)).toBe(expected);
  });

  it.each(["abc", "2junk", "1.5", "-1", "", " ", "9007199254740992"])(
    "rejects invalid depth %j",
    (value) => {
      expect(() => parseMaxDepth(value)).toThrow("--max-depth must be a non-negative safe integer");
    },
  );
});
