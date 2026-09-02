import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("contribution guidance points to the agent-neutral OpenSpec workflow", () => {
  const contributing = readFileSync(resolve(import.meta.dirname, "../../CONTRIBUTING.md"), "utf8");

  expect(contributing).toContain("agent-neutral OpenSpec planning process");
  expect(contributing).not.toMatch(/spec-kit process/i);
});
