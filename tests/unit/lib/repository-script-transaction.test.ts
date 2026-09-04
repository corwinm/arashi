import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  RepositoryScriptTransactionError,
  installRepositoryScripts,
  rollbackRepositoryScripts,
} from "../../../src/lib/repository-script-transaction.ts";
import { repositoryNoOpScaffold } from "../../../src/lib/repository-config-editor.ts";
import { tmpdir } from "node:os";
import type { OwnedRepositoryScript } from "../../../src/lib/repository-script-transaction.ts";

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "arashi-script-tx-"));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
);

const createOwned = async (path: string): Promise<OwnedRepositoryScript> => {
  const bytes = repositoryNoOpScaffold(".sh");
  await writeFile(path, bytes, { mode: 0o755 });
  await chmod(path, 0o755);
  const observed = await lstat(path, { bigint: true });
  const mode = (await stat(path)).mode & 0o777;
  return {
    birthtimeNs: observed.birthtimeNs,
    bytes,
    dev: Number(observed.dev),
    ino: Number(observed.ino),
    mode,
    path,
  };
};

describe("repository script transaction", () => {
  test("accepts an empty plan without filesystem mutation", async () => {
    await expect(installRepositoryScripts([])).resolves.toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "privately prepares and atomically publishes a complete POSIX script",
    async () => {
      const root = await fixture();
      const path = join(root, ".arashi", "hooks", "pre-create.app.sh");
      const bytes = repositoryNoOpScaffold(".sh");

      const owned = await installRepositoryScripts([
        {
          extension: ".sh",
          lifecycle: "pre-create",
          mode: 0o755,
          ownerRoot: root,
          path,
          state: "safe-no-op",
        },
      ]);

      expect(await readFile(path)).toEqual(Buffer.from(bytes));
      expect((await stat(path)).mode & 0o777).toBe(0o755);
      expect(owned).toHaveLength(1);
      expect(owned[0]).toMatchObject({ bytes, mode: 0o755, path });
      expect(owned[0].dev).toBe((await lstat(path)).dev);
      expect(owned[0].ino).toBe((await lstat(path)).ino);
      expect(owned[0].birthtimeNs).toBe((await lstat(path, { bigint: true })).birthtimeNs);
      expect(await readdir(dirname(path))).toEqual(["pre-create.app.sh"]);
    },
  );

  test("publishes a Windows plan as one complete runtime-ready PowerShell file", async () => {
    const root = await fixture();
    const path = join(root, ".arashi", "hooks", "post-create.app.ps1");

    const owned = await installRepositoryScripts([
      {
        extension: ".ps1",
        lifecycle: "post-create",
        mode: null,
        ownerRoot: root,
        path,
        state: "safe-no-op",
      },
    ]);

    expect(await readFile(path)).toEqual(Buffer.from(repositoryNoOpScaffold(".ps1")));
    expect(owned[0]).toMatchObject({ mode: null, path });
    expect(await readdir(dirname(path))).toEqual(["post-create.app.ps1"]);
  });

  test.each(["unexpected.sh", join(".arashi", "hooks", "nested", "unexpected.sh")])(
    "rejects a destination outside the exact lifecycle hooks directory: %s",
    async (relativePath) => {
      const root = await fixture();
      const path = join(root, relativePath);

      await expect(
        installRepositoryScripts([
          {
            extension: ".sh",
            lifecycle: "pre-create",
            mode: 0o755,
            ownerRoot: root,
            path,
            state: "safe-no-op",
          },
        ]),
      ).rejects.toThrow(
        "Active hook destination must be directly inside the lifecycle hooks directory.",
      );
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("never overwrites an existing destination", async () => {
    const root = await fixture();
    const path = join(root, ".arashi", "hooks", "pre-create.app.sh");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "user-owned");

    await expect(
      installRepositoryScripts([
        {
          extension: ".sh",
          lifecycle: "pre-create",
          mode: 0o755,
          ownerRoot: root,
          path,
          state: "safe-no-op",
        },
      ]),
    ).rejects.toMatchObject({ owned: [] });
    expect(await readFile(path, "utf8")).toBe("user-owned");
    expect(await readdir(dirname(path))).toEqual(["pre-create.app.sh"]);
  });

  test("never replaces a symlink destination", async () => {
    const root = await fixture();
    const target = join(root, "user-script.sh");
    const path = join(root, ".arashi", "hooks", "pre-create.app.sh");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(target, "user-owned");
    await symlink(target, path);

    await expect(
      installRepositoryScripts([
        {
          extension: ".sh",
          lifecycle: "pre-create",
          mode: 0o755,
          ownerRoot: root,
          path,
          state: "safe-no-op",
        },
      ]),
    ).rejects.toMatchObject({ owned: [] });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("user-owned");
    expect(await readdir(dirname(path))).toEqual(["pre-create.app.sh"]);
  });

  test("rejects a symlinked parent without writing through it", async () => {
    const root = await fixture();
    const attacker = await fixture();
    await symlink(attacker, join(root, ".arashi"), "dir");
    const path = join(root, ".arashi", "hooks", "pre-create.app.sh");

    await expect(
      installRepositoryScripts([
        {
          extension: ".sh",
          lifecycle: "pre-create",
          mode: 0o755,
          ownerRoot: root,
          path,
          state: "safe-no-op",
        },
      ]),
    ).rejects.toThrow(/symbolic link/i);
    await expect(lstat(join(attacker, "hooks", "pre-create.app.sh"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects an earlier symlinked ancestor when its target already has the destination parent", async () => {
    const root = await fixture();
    const attacker = await fixture();
    await mkdir(join(attacker, "hooks"));
    await symlink(attacker, join(root, ".arashi"), "dir");
    const path = join(root, ".arashi", "hooks", "pre-create.app.sh");

    await expect(
      installRepositoryScripts([
        {
          extension: ".sh",
          lifecycle: "pre-create",
          mode: 0o755,
          ownerRoot: root,
          path,
          state: "safe-no-op",
        },
      ]),
    ).rejects.toThrow(/symbolic link/i);
    await expect(lstat(join(attacker, "hooks", "pre-create.app.sh"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(attacker, "hooks"))).toEqual([]);
  });

  test("detects an observable parent substitution before publication and removes private artifacts", async () => {
    const root = await fixture();
    const attacker = await fixture();
    const hooks = join(root, ".arashi", "hooks");
    const path = join(hooks, "pre-create.app.sh");

    await expect(
      installRepositoryScripts(
        [
          {
            extension: ".sh",
            lifecycle: "pre-create",
            mode: 0o755,
            ownerRoot: root,
            path,
            state: "safe-no-op",
          },
        ],
        {
          beforePublication: async () => {
            await rm(hooks, { recursive: true });
            await symlink(attacker, hooks, "dir");
          },
        },
      ),
    ).rejects.toThrow(/changed identity|symbolic link/i);
    await expect(lstat(join(attacker, "pre-create.app.sh"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(attacker)).toEqual([]);
  });

  test("reports prior owned scripts when a later no-replace publication fails", async () => {
    const root = await fixture();
    const hooks = join(root, ".arashi", "hooks");
    const extension = process.platform === "win32" ? ".ps1" : ".sh";
    const mode = process.platform === "win32" ? null : 0o755;
    const first = join(hooks, `pre-create.app${extension}`);
    const second = join(hooks, `post-create.app${extension}`);
    await mkdir(hooks, { recursive: true });
    await writeFile(second, "pre-existing");
    let failure: unknown;

    try {
      await installRepositoryScripts(
        ["pre-create", "post-create"].map((lifecycle, index) => ({
          extension,
          lifecycle: lifecycle as "pre-create" | "post-create",
          mode,
          ownerRoot: root,
          path: index === 0 ? first : second,
          state: "safe-no-op" as const,
        })),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RepositoryScriptTransactionError);
    expect((failure as RepositoryScriptTransactionError).owned).toHaveLength(1);
    expect((failure as RepositoryScriptTransactionError).owned[0].path).toBe(first);
    expect(await readFile(second, "utf8")).toBe("pre-existing");
    await expect(
      rollbackRepositoryScripts((failure as RepositoryScriptTransactionError).owned),
    ).resolves.toEqual({ preserved: [], removed: [first] });
    await expect(lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports publication ownership when post-publication destination validation detects replacement", async () => {
    const root = await fixture();
    const replacement = join(root, "replacement.sh");
    const path = join(root, ".arashi", "hooks", "pre-create.app.sh");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(replacement, "replacement");
    let failure: unknown;

    try {
      await installRepositoryScripts(
        [
          {
            extension: ".sh",
            lifecycle: "pre-create",
            mode: 0o755,
            ownerRoot: root,
            path,
            state: "safe-no-op",
          },
        ],
        {
          afterPublication: async () => {
            await rm(path);
            await symlink(replacement, path);
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RepositoryScriptTransactionError);
    expect((failure as RepositoryScriptTransactionError).owned).toHaveLength(1);
    await expect(
      rollbackRepositoryScripts((failure as RepositoryScriptTransactionError).owned),
    ).resolves.toEqual({ preserved: [path], removed: [] });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "reports the canonical remove script as owned when a compatible claim races publication",
    async () => {
      const root = await fixture();
      const repository = await fixture();
      const path = join(root, ".arashi", "hooks", "pre-remove.app.sh");
      const compatible = join(repository, ".arashi", "hooks", "pre-remove.sh");
      let failure: unknown;

      try {
        await installRepositoryScripts(
          [
            {
              compatibleSourceRoot: repository,
              extension: ".sh",
              lifecycle: "pre-remove",
              mode: 0o755,
              ownerRoot: root,
              path,
              state: "safe-no-op",
            },
          ],
          {
            afterPublication: async () => {
              await mkdir(dirname(compatible), { recursive: true });
              await writeFile(compatible, "#!/bin/sh\nexit 0\n");
            },
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(RepositoryScriptTransactionError);
      expect((failure as RepositoryScriptTransactionError).owned).toHaveLength(1);
      expect((failure as RepositoryScriptTransactionError).owned[0].path).toBe(path);
      await expect(
        rollbackRepositoryScripts((failure as RepositoryScriptTransactionError).owned),
      ).resolves.toEqual({ preserved: [], removed: [path] });
      expect(await readFile(compatible, "utf8")).toContain("exit 0");
    },
  );

  test("rollback removes only identity-byte-mode-owned regular files", async () => {
    const root = await fixture();
    const paths = ["owned.sh", "edited.sh", "chmodded.sh", "replaced.sh", "linked.sh"].map((name) =>
      join(root, name),
    );
    const owned = await Promise.all(paths.map((path) => createOwned(path)));

    await writeFile(paths[1], "user edit");
    if (process.platform === "win32") {
      owned[2] = { ...owned[2], mode: 0o700 };
    } else {
      await chmod(paths[2], 0o700);
    }
    await rm(paths[3]);
    await writeFile(paths[3], owned[3].bytes, { mode: 0o755 });
    await rm(paths[4]);
    await symlink(paths[0], paths[4]);

    const result = await rollbackRepositoryScripts(owned);
    expect(result.removed).toEqual([paths[0]]);
    expect(result.preserved).toEqual(paths.slice(1));
    await expect(lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(paths[1], "utf8")).toBe("user edit");
    if (process.platform !== "win32") {
      expect((await stat(paths[2])).mode & 0o777).toBe(0o700);
    }
    expect((await lstat(paths[4])).isSymbolicLink()).toBe(true);
  });

  test("rollback preserves a same-path replacement with recycled dev and ino but a new birth identity", async () => {
    const root = await fixture();
    const path = join(root, "replaced.sh");
    const owned = await createOwned(path);

    await rm(path);
    await writeFile(path, owned.bytes, { mode: 0o755 });
    await chmod(path, 0o755);
    const replacement = await lstat(path, { bigint: true });
    const recycledIdentity = {
      ...owned,
      birthtimeNs: replacement.birthtimeNs - 1n,
      dev: Number(replacement.dev),
      ino: Number(replacement.ino),
    };

    await expect(rollbackRepositoryScripts([recycledIdentity])).resolves.toEqual({
      preserved: [path],
      removed: [],
    });
    expect(await readFile(path)).toEqual(Buffer.from(owned.bytes));
  });

  test("rollback preserves a file when its recorded birth identity is unavailable", async () => {
    const root = await fixture();
    const path = join(root, "unavailable-birthtime.sh");
    const owned = await createOwned(path);

    await expect(rollbackRepositoryScripts([{ ...owned, birthtimeNs: 0n }])).resolves.toEqual({
      preserved: [path],
      removed: [],
    });
    expect(await readFile(path)).toEqual(Buffer.from(owned.bytes));
  });
});
