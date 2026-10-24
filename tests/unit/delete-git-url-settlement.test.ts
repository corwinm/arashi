import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import * as git from "../../src/lib/git.ts";
import { gitFetchUrlsMatch } from "../../src/lib/delete-git-url.ts";

afterEach(() => vi.restoreAllMocks());

test("waits for every started URL rewrite before rejecting malformed fetch URLs", async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const url = "ssh://git@example.test/org/repo";
  vi.spyOn(git, "exec").mockImplementation(async (args) => {
    if (args.at(-1) === `${url}.git`) {
      entered();
      await blocked;
    }
    return { exitCode: 0, stdout: `${args.at(-1)}\n`, stderr: "" };
  });
  let settled = false;
  const operation = gitFetchUrlsMatch({
    configuredCwd: process.cwd(),
    configuredUrl: url,
    fetchUrls: ["https://[", `${url}.git`],
  }).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  // Observe rejection immediately, including on the unfixed implementation.
  const outcome = operation.catch((error: unknown) => error);
  try {
    await started;
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    release();
    await outcome;
  }
  await expect(operation).rejects.toThrow("URL is malformed");
});
