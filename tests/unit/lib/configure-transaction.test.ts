import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { serializeConfig, type Config } from "../../../src/lib/config.ts";
import {
  persistConfigureAtomically,
  revalidateRepositoryScriptPlans,
  runConfigureTransaction,
} from "../../../src/lib/configure-transaction.ts";
import {
  RepositoryScriptTransactionError,
  type OwnedRepositoryScript,
} from "../../../src/lib/repository-script-transaction.ts";

const config = (reposDir: string): Config => ({
  repos: {},
  reposDir,
  version: "1.0.0",
});
const bytes = (value: string) => new TextEncoder().encode(value);

describe("configure transaction", () => {
  test("atomically persists exact canonical bytes through a sibling stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-configure-atomic-"));
    const configPath = join(root, ".arashi", "config.json");
    await mkdir(join(root, ".arashi"));
    const original = bytes("original bytes");
    await writeFile(configPath, original);

    await persistConfigureAtomically(configPath, config("children"), original);

    expect(await readFile(configPath, "utf8")).toBe(serializeConfig(config("children")));
    expect(await readdir(join(root, ".arashi"))).toEqual(["config.json"]);
  });

  test.each(["write", "sync", "rename"] as const)(
    "cleans the sibling stage and preserves live bytes on %s failure",
    async (failure) => {
      const original = bytes("original bytes");
      const stageBytes: Uint8Array[] = [];
      const remove = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      await expect(
        persistConfigureAtomically("/workspace/.arashi/config.json", config("children"), original, {
          open: async () => ({
            close,
            sync: async () => {
              if (failure === "sync") throw new Error("sync failed");
            },
            writeFile: async (value: Uint8Array) => {
              stageBytes.push(value.subarray(0, 7));
              if (failure === "write") throw new Error("partial stage write");
            },
          }),
          readFile: async () => original,
          rename: async () => {
            if (failure === "rename") throw new Error("rename failed");
          },
          rm: remove,
          temporaryName: () => ".config.json.test.tmp",
        }),
      ).rejects.toThrow(failure === "write" ? /partial stage write/ : new RegExp(failure));
      expect(stageBytes).toHaveLength(1);
      expect(close).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith(
        "/workspace/.arashi/.config.json.test.tmp",
        expect.objectContaining({ force: true }),
      );
    },
  );

  test("does not replace newer bytes observed after complete staging", async () => {
    const original = bytes("original bytes");
    const newer = bytes("newer external bytes");
    const rename = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    let reads = 0;
    await expect(
      persistConfigureAtomically("/workspace/.arashi/config.json", config("children"), original, {
        open: async () => ({
          close: async () => {},
          sync: async () => {},
          writeFile: async () => {},
        }),
        readFile: async () => (++reads === 1 ? original : newer),
        rename,
        rm: remove,
        temporaryName: () => ".config.json.test.tmp",
      }),
    ).rejects.toThrow(/changed concurrently.*preserv/i);
    expect(rename).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  test("checks expected bytes, installs files, and saves exactly once", async () => {
    const expected = bytes("original");
    const save = vi.fn(async () => {});
    const install = vi.fn(async () => [] as OwnedRepositoryScript[]);
    await runConfigureTransaction({
      candidate: config("children"),
      expectedBytes: expected,
      plans: [],
      dependencies: {
        installScripts: install,
        readConfigBytes: async () => expected,
        rollbackScripts: async () => ({ preserved: [], removed: [] }),
        saveConfig: save,
        withLock: async (operation) => operation(),
      },
    });
    expect(install).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(config("children"));
  });

  test("preserves newer bytes and performs no install or save on mismatch", async () => {
    const install = vi.fn(async () => [] as OwnedRepositoryScript[]);
    const save = vi.fn(async () => {});
    await expect(
      runConfigureTransaction({
        candidate: config("children"),
        expectedBytes: bytes("original"),
        plans: [],
        dependencies: {
          installScripts: install,
          readConfigBytes: async () => bytes("newer"),
          rollbackScripts: async () => ({ preserved: [], removed: [] }),
          saveConfig: save,
          withLock: async (operation) => operation(),
        },
      }),
    ).rejects.toThrow(/changed concurrently.*preserv/i);
    expect(install).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("rolls back owned unchanged files when the one save fails", async () => {
    const owned = [{ path: "/owned.sh" }] as OwnedRepositoryScript[];
    const rollback = vi.fn(async () => ({ preserved: [], removed: ["/owned.sh"] }));
    await expect(
      runConfigureTransaction({
        candidate: config("children"),
        expectedBytes: bytes("original"),
        plans: [],
        dependencies: {
          installScripts: async () => owned,
          readConfigBytes: async () => bytes("original"),
          rollbackScripts: rollback,
          saveConfig: async () => {
            throw new Error("save failed");
          },
          withLock: async (operation) => operation(),
        },
      }),
    ).rejects.toThrow("save failed");
    expect(rollback).toHaveBeenCalledWith(owned);
  });

  test("does not attempt live-file restoration after a save failure", async () => {
    const expected = bytes("original bytes");
    await expect(
      runConfigureTransaction({
        candidate: config("children"),
        expectedBytes: expected,
        plans: [],
        dependencies: {
          installScripts: async () => [],
          readConfigBytes: async () => expected,
          rollbackScripts: async () => ({ preserved: [], removed: [] }),
          saveConfig: async () => {
            throw new Error("save failed after write");
          },
          withLock: async (operation) => operation(),
        },
      }),
    ).rejects.toThrow("save failed after write");
  });

  test("revalidates the complete accumulated plan under the lock before no-replace install", async () => {
    const events: string[] = [];
    const plans = [
      {
        extension: ".ps1" as const,
        lifecycle: "pre-create" as const,
        mode: null,
        ownerRoot: "C:\\workspace",
        path: "C:\\workspace\\.arashi\\hooks\\pre-create.app.ps1",
        repositoryName: "app",
        state: "safe-no-op" as const,
      },
    ];
    await runConfigureTransaction({
      candidate: config("children"),
      expectedBytes: bytes("original"),
      plans,
      dependencies: {
        installScripts: async () => {
          events.push("install");
          return [];
        },
        readConfigBytes: async () => bytes("original"),
        revalidatePlans: async (observed) => {
          events.push("revalidate");
          expect(observed).toEqual(plans);
        },
        rollbackScripts: async () => ({ preserved: [], removed: [] }),
        saveConfig: async () => {
          events.push("save");
        },
        withLock: async (operation) => {
          events.push("lock");
          return operation();
        },
      },
    });
    expect(events).toEqual(["lock", "revalidate", "install", "save"]);
  });

  test("a sibling native extension race fails revalidation before installation", async () => {
    const install = vi.fn(async () => [] as OwnedRepositoryScript[]);
    await expect(
      runConfigureTransaction({
        candidate: config("children"),
        expectedBytes: bytes("original"),
        plans: [],
        dependencies: {
          installScripts: install,
          readConfigBytes: async () => bytes("original"),
          revalidatePlans: async () => {
            throw new Error("Sibling native hook pre-create.app.cmd appeared concurrently.");
          },
          rollbackScripts: async () => ({ preserved: [], removed: [] }),
          saveConfig: async () => {},
          withLock: async (operation) => operation(),
        },
      }),
    ).rejects.toThrow(/sibling native hook/i);
    expect(install).not.toHaveBeenCalled();
  });

  test("the default revalidator checks every plan and Windows sibling extension", async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["C:\\workspace\\.arashi\\hooks\\post-create.app.cmd"]);
    const plans = [
      {
        extension: ".ps1" as const,
        lifecycle: "pre-create" as const,
        mode: null,
        ownerRoot: "C:\\workspace",
        path: "C:\\workspace\\.arashi\\hooks\\pre-create.app.ps1",
        repositoryName: "app",
        state: "safe-no-op" as const,
      },
      {
        extension: ".ps1" as const,
        lifecycle: "post-create" as const,
        mode: null,
        ownerRoot: "C:\\workspace",
        path: "C:\\workspace\\.arashi\\hooks\\post-create.app.ps1",
        repositoryName: "app",
        state: "safe-no-op" as const,
      },
    ];
    await expect(
      revalidateRepositoryScriptPlans(plans, { discoverLifecycleHookCandidates: discover }),
    ).rejects.toThrow(/native active hook.*post-create/i);
    expect(discover).toHaveBeenNthCalledWith(1, "pre-create.app", "C:\\workspace", "win32");
    expect(discover).toHaveBeenNthCalledWith(2, "post-create.app", "C:\\workspace", "win32");
  });

  test("rolls back files reported by a partially failed no-replace installation", async () => {
    const owned = [{ path: "/first-owned.sh" }] as OwnedRepositoryScript[];
    const rollback = vi.fn(async () => ({ preserved: [], removed: ["/first-owned.sh"] }));
    await expect(
      runConfigureTransaction({
        candidate: config("children"),
        dependencies: {
          installScripts: async () => {
            throw new RepositoryScriptTransactionError(
              "second collided",
              owned,
              new Error("EEXIST"),
            );
          },
          readConfigBytes: async () => bytes("original"),
          rollbackScripts: rollback,
          saveConfig: async () => {},
          withLock: async (operation) => operation(),
        },
        expectedBytes: bytes("original"),
        plans: [],
      }),
    ).rejects.toThrow("second collided");
    expect(rollback).toHaveBeenCalledWith(owned);
  });
});
