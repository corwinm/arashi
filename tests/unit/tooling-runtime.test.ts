import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("contributor tooling runtimes", () => {
  test("runs the installed pre-commit tool through pnpm", () => {
    expect(read(".husky/pre-commit").trim()).toBe("#!/usr/bin/env sh\n\npnpm exec lint-staged");
  });

  test("runs release scripts through pnpm while preserving the Bun compiler", () => {
    const release = JSON.parse(read(".releaserc.json"));
    const [, options] = release.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@semantic-release/exec",
    );
    expect(options.prepareCmd).toContain("pnpm run build:all");
    expect(options.prepareCmd).not.toMatch(/\bbun(?:x)?\b/);
    const { scripts } = JSON.parse(read("package.json"));
    expect(scripts.build).toContain("bun build src/index.ts --compile");
  });

  test("uses Node for the source entrypoint", () => {
    expect(read("src/index.ts").split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});
