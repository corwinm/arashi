import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  captureDeletionIdentity,
  quarantineAndRemoveIdentity,
  validateDeletionIdentity,
  validateExpectedAbsence,
  type DeletionIdentityIO,
} from "../../src/lib/delete-identity.ts";

const roots: string[] = [];
const fixture = async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), "arashi-delete-identity-"));
  roots.push(createdRoot);
  const root = await realpath(createdRoot);
  const owned = join(root, "managed", "owned");
  await mkdir(owned, { recursive: true });
  await writeFile(join(owned, "KEEP"), "owned\n");
  return { owned, root };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("identity-anchored deletion", () => {
  test("captures no-follow leaf and ancestor identities and rejects an ancestor alias", async () => {
    const { owned, root } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");

    expect(captured.leaf.identity).toMatch(
      new RegExp(`^${process.platform === "win32" ? "windows" : "posix"}:`, "u"),
    );
    expect(captured.ancestors.map(({ path }) => path)).toContain(dirname(owned));

    const alias = join(root, "alias");
    await symlink(join(root, "managed"), alias, "dir");
    await expect(captureDeletionIdentity(join(alias, "owned"), "directory")).rejects.toMatchObject({
      code: "DELETE_PATH_UNSAFE",
      reason: "symbolic-link",
    });
  });

  test("refuses leaf replacement captured before locked execution", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const original = `${owned}.original`;
    await rename(owned, original);
    await mkdir(owned);
    await writeFile(join(owned, "REPLACEMENT"), "keep\n");

    await expect(validateDeletionIdentity(captured)).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
      reason: "identity-changed",
    });
    expect(await readFile(join(owned, "REPLACEMENT"), "utf8")).toBe("keep\n");
  });

  test("proves a completed mutation only when the leaf is absent under unchanged ancestors", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    await rm(owned, { recursive: true });

    await expect(validateExpectedAbsence(captured)).resolves.toBeUndefined();

    await mkdir(owned);
    await expect(validateExpectedAbsence(captured)).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
      reason: "expected-path-still-present",
    });
  });

  test("refuses ancestor replacement captured before locked execution", async () => {
    const { owned, root } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const managed = dirname(owned);
    await rename(managed, `${managed}.original`);
    await mkdir(owned, { recursive: true });
    await writeFile(join(owned, "REPLACEMENT"), "keep\n");

    await expect(validateDeletionIdentity(captured)).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
      reason: "ancestor-identity-changed",
    });
    expect(await readFile(join(root, "managed", "owned", "REPLACEMENT"), "utf8")).toBe("keep\n");
  });

  test("never recursively removes a replacement swapped into quarantine", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const replacement = `${owned}.replacement`;
    await mkdir(replacement);
    await writeFile(join(replacement, "KEEP"), "replacement\n");
    let quarantine = "";
    const io: Partial<DeletionIdentityIO> = {
      afterRename: async (_source, moved) => {
        quarantine = moved;
        await rename(moved, `${moved}.owned`);
        await rename(replacement, moved);
      },
    };

    await expect(quarantineAndRemoveIdentity(captured, io)).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
      reason: "quarantine-identity-changed",
    });
    expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("replacement\n");
    expect(await readFile(join(`${quarantine}.owned`, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("never removes a replacement swapped in after quarantine validation", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const replacement = `${owned}.replacement`;
    await mkdir(replacement);
    await writeFile(join(replacement, "KEEP"), "replacement\n");
    let quarantine = "";

    await expect(
      quarantineAndRemoveIdentity(captured, {
        beforeRemove: async (moved) => {
          quarantine = moved;
          await rename(moved, `${moved}.owned`);
          await rename(replacement, moved);
        },
      } as Partial<DeletionIdentityIO>),
    ).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
      reason: "quarantine-identity-changed",
    });
    expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("replacement\n");
    expect(await readFile(join(`${quarantine}.owned`, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("restores the quarantined object after post-rename validation fails when guards still match", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    await expect(
      quarantineAndRemoveIdentity(captured, {
        afterRename: async () => {
          throw new Error("injected validation failure");
        },
      }),
    ).rejects.toThrow(/injected validation failure/u);
    expect(await readFile(join(owned, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("preserves quarantine when restoration destination was recreated", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    let quarantine = "";
    await expect(
      quarantineAndRemoveIdentity(captured, {
        afterRename: async (source, moved) => {
          quarantine = moved;
          await mkdir(source);
          await writeFile(join(source, "REPLACEMENT"), "keep\n");
          throw new Error("injected validation failure");
        },
      }),
    ).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
      reason: "quarantine-restore-unsafe",
    });
    expect(await readFile(join(owned, "REPLACEMENT"), "utf8")).toBe("keep\n");
    expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("treats cross-device or non-atomic rename anomalies as unsafe and does not remove", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const remove = vi.fn();
    const renameFailure = Object.assign(new Error("cross-device"), { code: "EXDEV" });

    await expect(
      quarantineAndRemoveIdentity(captured, {
        rename: async () => Promise.reject(renameFailure),
        rm: remove,
      }),
    ).rejects.toMatchObject({ code: "DELETE_PATH_UNSAFE", reason: "atomic-rename-unavailable" });
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(join(owned, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("supports a platform-equivalent file identity abstraction", async () => {
    const { owned } = await fixture();
    const identityOf = vi.fn((_metadata, path: string) => `windows-file-id:${path}`);
    const captured = await captureDeletionIdentity(owned, "directory", { identityOf });

    expect(captured.leaf.identity).toBe(`windows-file-id:${owned}`);
    await expect(validateDeletionIdentity(captured, { identityOf })).resolves.toBeUndefined();
    expect(identityOf).toHaveBeenCalled();
  });
});
