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
  adoptUnpreparedQuarantine,
  captureDeletionIdentity,
  quarantineAndRetainIdentity,
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
      new RegExp(
        `^${process.platform === "win32" ? "windows" : "posix"}-v2:[0-9]+:[0-9]+:[0-9]+$`,
        "u",
      ),
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

    await expect(quarantineAndRetainIdentity(captured, io)).rejects.toMatchObject({
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
      quarantineAndRetainIdentity(captured, {
        beforeRetain: async (moved) => {
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

  test("retires an accepted identity without recursively unlinking it", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");

    const quarantine = await quarantineAndRetainIdentity(captured);
    expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("owned\n");
    await expect(readFile(join(owned, "KEEP"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("accepts a durable legacy retirement without unlinking it", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const quarantine = `${owned}.quarantine`;
    const retired = `${quarantine}.retiring`;
    await rename(owned, retired);
    await expect(
      quarantineAndRetainIdentity(captured, {
        alreadyQuarantined: true,
        quarantinePath: quarantine,
      }),
    ).resolves.toBe(retired);
    expect(await readFile(join(retired, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("preserves the quarantined object after post-rename validation fails", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    let quarantine = "";
    await expect(
      quarantineAndRetainIdentity(captured, {
        afterRename: async (_source, moved) => {
          quarantine = moved;
          throw new Error("injected validation failure");
        },
      }),
    ).rejects.toThrow(/injected validation failure/u);
    await expect(readFile(join(owned, "KEEP"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("owned\n");
  });

  test.each(["directory", "file"] as const)(
    "never attempts a %s quarantine restoration that can overwrite a recreated source",
    async (kind) => {
      const { owned } = await fixture();
      const source = kind === "directory" ? owned : join(dirname(owned), "owned-file");
      if (kind === "file") await writeFile(source, "owned-file\n");
      const captured = await captureDeletionIdentity(source, kind);
      let calls = 0;
      let quarantine = "";
      await expect(
        quarantineAndRetainIdentity(captured, {
          rename: async (from, to) => {
            calls += 1;
            await rename(from, to);
            if (calls === 1) quarantine = to;
          },
          afterRename: async () => {
            throw new Error("injected post-rename failure");
          },
        }),
      ).rejects.toThrow(/injected post-rename failure/u);
      expect(calls).toBe(1);
      await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "directory")
        expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("owned\n");
      else expect(await readFile(quarantine, "utf8")).toBe("owned-file\n");
    },
  );

  test("adopts an exact unprepared quarantine and fails closed on a recreated source", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const quarantine = `${owned}.quarantine`;
    await rename(owned, quarantine);
    await expect(adoptUnpreparedQuarantine(captured, quarantine)).resolves.toBe(quarantine);
    await mkdir(owned);
    await writeFile(join(owned, "REPLACEMENT"), "replacement\n");
    await expect(adoptUnpreparedQuarantine(captured, quarantine)).rejects.toMatchObject({
      code: "DELETE_CONCURRENT_CHANGE",
    });
    expect(await readFile(join(owned, "REPLACEMENT"), "utf8")).toBe("replacement\n");
    expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("preserves quarantine when restoration destination was recreated", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    let quarantine = "";
    await expect(
      quarantineAndRetainIdentity(captured, {
        afterRename: async (source, moved) => {
          quarantine = moved;
          await mkdir(source);
          await writeFile(join(source, "REPLACEMENT"), "keep\n");
          throw new Error("injected validation failure");
        },
      }),
    ).rejects.toThrow(/injected validation failure/u);
    expect(await readFile(join(owned, "REPLACEMENT"), "utf8")).toBe("keep\n");
    expect(await readFile(join(quarantine, "KEEP"), "utf8")).toBe("owned\n");
  });

  test("treats cross-device or non-atomic rename anomalies as unsafe and does not remove", async () => {
    const { owned } = await fixture();
    const captured = await captureDeletionIdentity(owned, "directory");
    const renameFailure = Object.assign(new Error("cross-device"), { code: "EXDEV" });

    await expect(
      quarantineAndRetainIdentity(captured, {
        rename: async () => Promise.reject(renameFailure),
      }),
    ).rejects.toMatchObject({ code: "DELETE_PATH_UNSAFE", reason: "atomic-rename-unavailable" });

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
