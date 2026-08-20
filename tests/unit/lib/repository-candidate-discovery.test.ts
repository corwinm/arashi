import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverRepositoryLocalCandidates } from "../../../src/lib/repository-candidate-discovery.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "arashi-discovery-"));
  roots.push(root);
  await exec("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), ".env*\n.cache/\nnode_modules/\n");
  await writeFile(join(root, ".env.local"), "DISCOVERY_SECRET_CANARY");
  await mkdir(join(root, ".cache"));
  await writeFile(join(root, ".cache", "nested"), "hidden");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", ".env"), "hidden");
  return root;
}

describe("bounded repository candidate discovery", () => {
  test("stops root iteration at the observation bound before materializing more entries", async () => {
    let observed = 0;
    const entries = [".env.c", ".env.a", ".env.b", ".env.never"];
    const result = await discoverRepositoryLocalCandidates(
      "/virtual",
      { maxRootEntries: 3, maxSuggestions: 3 },
      {
        checkIgnored: async (paths) => paths,
        openRoot: async function* () {
          for (const name of entries) {
            observed += 1;
            if (observed > 3) throw new Error("unbounded iteration");
            yield { isDirectory: () => false, name };
          }
        },
      },
    );
    expect(observed).toBe(3);
    expect(result.candidates.map(({ path }) => path)).toEqual([".env.a", ".env.b", ".env.c"]);
  });

  test("excluded dependency metadata still consumes the observation budget", async () => {
    let observed = 0;
    const result = await discoverRepositoryLocalCandidates(
      "/virtual",
      { maxRootEntries: 2, maxSuggestions: 2 },
      {
        checkIgnored: async (paths) => paths,
        openRoot: async function* () {
          for (const name of ["node_modules", ".env.a", ".env.must-not-be-observed"]) {
            observed += 1;
            yield { isDirectory: () => true, name };
          }
        },
      },
    );
    expect(observed).toBe(2);
    expect(result.inspectedEntries).toBe(2);
    expect(result.candidates.map(({ path }) => path)).toEqual([".env.a"]);
  });

  test("returns deterministic unselected ignored root metadata without reading contents", async () => {
    const root = await fixture();
    await chmod(join(root, ".env.local"), 0o000);
    const result = await discoverRepositoryLocalCandidates(root);
    expect(result.candidates).toEqual([
      { kind: "directory", path: ".cache", selected: false },
      { kind: "file", path: ".env.local", selected: false },
    ]);
    expect(JSON.stringify(result)).not.toContain("DISCOVERY_SECRET_CANARY");
    expect(JSON.stringify(result)).not.toContain("node_modules");
  });

  test("enforces hard root-entry and suggestion limits without recursion", async () => {
    const root = await fixture();
    for (let index = 0; index < 300; index += 1) {
      await writeFile(join(root, `.env.${String(index).padStart(3, "0")}`), "x");
    }
    const result = await discoverRepositoryLocalCandidates(root, {
      maxRootEntries: 32,
      maxSuggestions: 8,
    });
    expect(result.inspectedEntries).toBeLessThanOrEqual(32);
    expect(result.candidates.length).toBeLessThanOrEqual(8);
    expect(result.candidates.every(({ path }) => !path.includes("/"))).toBe(true);
  });
});
