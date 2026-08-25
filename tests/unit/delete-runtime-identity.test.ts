import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  captureRuntimeDeletionIdentities,
  removePlannedWorkspaceHooks,
  validateRuntimeDeletionIdentities,
} from "../../src/commands/delete.ts";
import type { WorktreeRemovalPlan } from "../../src/lib/delete-topology.ts";

const roots: string[] = [];
const fixture = async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), "arashi-delete-runtime-identity-"));
  roots.push(createdRoot);
  const root = await realpath(createdRoot);
  const clone = join(root, "clone");
  const worktree = join(root, "worktree");
  const metadata = join(clone, ".git", "worktrees", "topic");
  const hook = join(root, "hooks", "pre-create.api.sh");
  await Promise.all([
    mkdir(clone, { recursive: true }),
    mkdir(worktree, { recursive: true }),
    mkdir(metadata, { recursive: true }),
    mkdir(join(root, "hooks"), { recursive: true }),
  ]);
  await writeFile(hook, "planned hook\n");
  const topology: WorktreeRemovalPlan = {
    canonicalClonePath: clone,
    commonDirectory: join(clone, ".git"),
    configuredActivePath: clone,
    inventory: [],
    linkedWorktrees: [
      {
        bare: false,
        branch: "refs/heads/topic",
        detached: false,
        head: "a".repeat(40),
        locked: null,
        metadataPath: null,
        path: worktree,
        present: true,
        prunable: null,
      },
    ],
    primaryPath: clone,
    staleMetadata: [{ path: metadata, worktreePath: join(root, "missing") }],
  };
  return { clone, hook, metadata, root, topology, worktree };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("delete runtime planned identities", () => {
  test("captures the canonical clone, every registered worktree and metadata directory, and exact hooks", async () => {
    const { clone, hook, metadata, topology, worktree } = await fixture();
    const identities = await captureRuntimeDeletionIdentities(topology, [hook]);

    expect(identities.clone.path).toBe(clone);
    expect(identities.worktrees.map(({ path }) => path)).toEqual([worktree]);
    expect(identities.metadata.map(({ path }) => path)).toEqual([metadata]);
    expect(identities.hooks.map(({ path }) => path)).toEqual([hook]);
    await expect(validateRuntimeDeletionIdentities(identities)).resolves.toBeUndefined();
  });

  test("uses planning-time hook identity after confirmation instead of trusting fresh metadata", async () => {
    const { hook, topology } = await fixture();
    const identities = await captureRuntimeDeletionIdentities(topology, [hook]);
    const original = `${hook}.original`;
    await rename(hook, original);
    await writeFile(hook, "replacement hook\n");

    await expect(removePlannedWorkspaceHooks(identities.hooks)).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
      reason: "identity-changed",
    });
    expect(await readFile(hook, "utf8")).toBe("replacement hook\n");
    expect(await readFile(original, "utf8")).toBe("planned hook\n");
  });
});
