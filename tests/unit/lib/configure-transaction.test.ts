import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { serializeConfig, type Config } from "../../../src/lib/config.ts";
import {
  persistConfigureAtomically,
  persistExpectedBytesAtomically,
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
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

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

  test.runIf(process.platform !== "win32")(
    "preserves the exact existing POSIX mode after a successful canonical save",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "arashi-configure-mode-save-"));
      const configPath = join(root, "config.json");
      const original = bytes("original bytes");
      await writeFile(configPath, original);
      await chmod(configPath, 0o640);

      await persistConfigureAtomically(configPath, config("children"), original);

      expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    },
  );

  test("transfers the existing POSIX group before replacing the live config", async () => {
    const original = bytes("original bytes");
    const chownStage = vi.fn(async () => {});
    const chmodStage = vi.fn(async () => {});

    expect(
      await persistExpectedBytesAtomically(
        join("workspace", ".arashi", "config.json"),
        bytes("replacement bytes"),
        original,
        {
          open: async () => ({
            chmod: chmodStage,
            chown: chownStage,
            close: async () => {},
            stat: async () => ({ gid: 20, uid: 501 }),
            sync: async () => {},
            writeFile: async () => {},
          }),
          platform: "linux",
          readFile: async () => original,
          rename: async () => {},
          rm: async () => {},
          stat: async () => ({ gid: 4242, mode: 0o100640 }),
          temporaryName: () => ".config.json.group.tmp",
        },
      ),
    ).toBe(true);
    expect(chownStage).toHaveBeenCalledOnce();
    expect(chownStage).toHaveBeenCalledWith(501, 4242);
    expect(chownStage.mock.invocationCallOrder[0]).toBeLessThan(
      chmodStage.mock.invocationCallOrder[0]!,
    );
  });

  test("skips POSIX ownership transfer when the staged file already inherited the live group", async () => {
    const original = bytes("original bytes");
    const chownStage = vi.fn(async () => {
      throw new Error("matching staged group must not be reassigned");
    });
    const chmodStage = vi.fn(async () => {});

    expect(
      await persistExpectedBytesAtomically(
        join("workspace", ".arashi", "config.json"),
        bytes("replacement bytes"),
        original,
        {
          open: async () => ({
            chmod: chmodStage,
            chown: chownStage,
            close: async () => {},
            stat: async () => ({ gid: 4242, uid: 501 }),
            sync: async () => {},
            writeFile: async () => {},
          }),
          platform: "linux",
          readFile: async () => original,
          rename: async () => {},
          rm: async () => {},
          stat: async () => ({ gid: 4242, mode: 0o100640 }),
          temporaryName: () => ".config.json.inherited-group.tmp",
        },
      ),
    ).toBe(true);
    expect(chownStage).not.toHaveBeenCalled();
    expect(chmodStage).toHaveBeenCalledWith(0o640);
  });

  test.runIf(process.platform !== "win32")(
    "preserves the exact existing POSIX mode through rollback restoration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "arashi-configure-mode-restore-"));
      const configPath = join(root, "config.json");
      const original = bytes("original bytes");
      const candidate = bytes("candidate bytes");
      await writeFile(configPath, original);
      await chmod(configPath, 0o664);

      expect(await persistExpectedBytesAtomically(configPath, candidate, original)).toBe(true);
      expect((await stat(configPath)).mode & 0o777).toBe(0o664);
      expect(await persistExpectedBytesAtomically(configPath, original, candidate)).toBe(true);

      expect(await readFile(configPath, "utf8")).toBe("original bytes");
      expect((await stat(configPath)).mode & 0o777).toBe(0o664);
    },
  );

  test.each(["stat", "stage-stat", "chown", "chmod"] as const)(
    "preserves live bytes and cleans the stage when POSIX %s metadata transfer fails",
    async (failure) => {
      const original = bytes("original bytes");
      let live = original;
      let staged = false;
      const rename = vi.fn(async () => {
        live = bytes("replacement bytes");
        staged = false;
      });
      const remove = vi.fn(async () => {
        staged = false;
      });

      await expect(
        persistExpectedBytesAtomically(
          join("workspace", ".arashi", "config.json"),
          bytes("replacement bytes"),
          original,
          {
            open: async () => {
              staged = true;
              return {
                chmod: async (mode: number) => {
                  expect(mode).toBe(0o640);
                  if (failure === "chmod") {
                    throw new Error("chmod failed");
                  }
                },
                chown: async (uid: number, gid: number) => {
                  if (failure !== "stage-stat") {
                    expect([uid, gid]).toEqual([501, 4242]);
                  }
                  if (failure === "chown") {
                    throw new Error("chown failed");
                  }
                },
                close: async () => {},
                stat: async () => {
                  if (failure === "stage-stat") {
                    throw new Error("stage-stat failed");
                  }
                  return { gid: 20, uid: 501 };
                },
                sync: async () => {},
                writeFile: async () => {},
              };
            },
            platform: "linux",
            readFile: async () => live,
            rename,
            rm: remove,
            stat: async () => {
              if (failure === "stat") {
                throw new Error("stat failed");
              }
              return { gid: 4242, mode: 0o640 };
            },
            temporaryName: () => ".config.json.mode.tmp",
          },
        ),
      ).rejects.toThrow(`${failure} failed`);

      expect(text(live)).toBe("original bytes");
      expect(staged).toBe(false);
      expect(rename).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledOnce();
    },
  );

  test("does not impose POSIX mode transfer on Windows", async () => {
    const original = bytes("original bytes");
    let live = original;
    let stage = original;
    const chmodStage = vi.fn(async () => {
      throw new Error("Windows chmod must not be called");
    });
    const chownStage = vi.fn(async () => {
      throw new Error("Windows chown must not be called");
    });
    const statStage = vi.fn(async () => {
      throw new Error("Windows staged stat must not be called");
    });
    const statLive = vi.fn(async () => {
      throw new Error("Windows stat must not be called");
    });

    expect(
      await persistExpectedBytesAtomically(
        String.raw`C:\workspace\.arashi\config.json`,
        bytes("replacement bytes"),
        original,
        {
          open: async () => ({
            chmod: chmodStage,
            chown: chownStage,
            close: async () => {},
            stat: statStage,
            sync: async () => {},
            writeFile: async (value) => {
              stage = value;
            },
          }),
          platform: "win32",
          readFile: async () => live,
          rename: async () => {
            live = stage;
          },
          rm: async () => {},
          stat: statLive,
          temporaryName: () => ".config.json.windows.tmp",
        },
      ),
    ).toBe(true);
    expect(text(live)).toBe("replacement bytes");
    expect(statLive).not.toHaveBeenCalled();
    expect(statStage).not.toHaveBeenCalled();
    expect(chownStage).not.toHaveBeenCalled();
    expect(chmodStage).not.toHaveBeenCalled();
  });

  test.each(["open", "write", "sync", "rename"] as const)(
    "cleans the sibling stage and preserves live bytes on %s failure",
    async (failure) => {
      const original = bytes("original bytes");
      const stageBytes: Uint8Array[] = [];
      let staged = false;
      let live = original;
      const remove = vi.fn(async () => {
        staged = false;
      });
      const close = vi.fn(async () => {});
      const configPath = join("workspace", ".arashi", "config.json");
      await expect(
        persistConfigureAtomically(configPath, config("children"), original, {
          open: async () => {
            if (failure === "open") throw new Error("open failed");
            staged = true;
            return {
              chmod: async () => {},
              chown: async () => {},
              close,
              stat: async () => ({ gid: 20, uid: 501 }),
              sync: async () => {
                if (failure === "sync") throw new Error("sync failed");
              },
              writeFile: async (value: Uint8Array) => {
                stageBytes.push(value.subarray(0, 7));
                if (failure === "write") throw new Error("partial stage write");
              },
            };
          },
          platform: "linux",
          readFile: async () => live,
          rename: async () => {
            if (failure === "rename") throw new Error("rename failed");
            live = stageBytes[0] ?? live;
            staged = false;
          },
          rm: remove,
          stat: async () => ({ gid: 4242, mode: 0o600 }),
          temporaryName: () => ".config.json.test.tmp",
        }),
      ).rejects.toThrow(failure === "write" ? /partial stage write/ : new RegExp(failure));
      expect(text(live)).toBe("original bytes");
      expect(staged).toBe(false);
      expect(stageBytes).toHaveLength(failure === "open" ? 0 : 1);
      expect(close).toHaveBeenCalledTimes(failure === "open" ? 0 : 1);
      expect(remove).toHaveBeenCalledTimes(failure === "open" ? 0 : 1);
      if (failure !== "open") {
        expect(remove).toHaveBeenCalledWith(
          join(dirname(configPath), ".config.json.test.tmp"),
          expect.objectContaining({ force: true }),
        );
      }
    },
  );

  test("restores bytes only through expected-byte atomic staging", async () => {
    const original = bytes("original bytes");
    const candidate = bytes("complete candidate bytes");
    let live = candidate;
    let stage: Uint8Array | undefined;
    const events: string[] = [];

    const restored = await persistExpectedBytesAtomically(
      join("workspace", ".arashi", "config.json"),
      original,
      candidate,
      {
        open: async () => {
          events.push("open-stage");
          return {
            chmod: async () => {
              events.push("chmod-stage");
            },
            chown: async () => {
              events.push("chown-stage");
            },
            close: async () => {
              events.push("close-stage");
            },
            stat: async () => {
              events.push("stat-stage");
              return { gid: 20, uid: 501 };
            },
            sync: async () => {
              events.push("sync-stage");
            },
            writeFile: async (value) => {
              events.push("write-stage");
              stage = value;
            },
          };
        },
        platform: "linux",
        readFile: async () => live,
        rename: async () => {
          events.push("replace-live");
          live = stage!;
          stage = undefined;
        },
        rm: async () => {
          events.push("remove-stage");
          stage = undefined;
        },
        stat: async () => ({ gid: 4242, mode: 0o100640 }),
        temporaryName: () => ".config.json.restore.tmp",
      },
    );

    expect(restored).toBe(true);
    expect(text(live)).toBe("original bytes");
    expect(events).toEqual([
      "open-stage",
      "write-stage",
      "sync-stage",
      "stat-stage",
      "chown-stage",
      "chmod-stage",
      "sync-stage",
      "close-stage",
      "replace-live",
    ]);
  });

  test("does not replace newer bytes observed after complete staging", async () => {
    const original = bytes("original bytes");
    const newer = bytes("newer external bytes");
    const rename = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    let reads = 0;
    await expect(
      persistConfigureAtomically("/workspace/.arashi/config.json", config("children"), original, {
        open: async () => ({
          chmod: async () => {},
          chown: async () => {},
          close: async () => {},
          stat: async () => ({ gid: 20, uid: 501 }),
          sync: async () => {},
          writeFile: async () => {},
        }),
        platform: "linux",
        readFile: async () => (++reads === 1 ? original : newer),
        rename,
        rm: remove,
        stat: async () => ({ gid: 4242, mode: 0o600 }),
        temporaryName: () => ".config.json.test.tmp",
      }),
    ).rejects.toThrow(/changed concurrently.*preserv/i);
    expect(rename).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  test("reports stage cleanup failure after preserving newer live bytes", async () => {
    const original = bytes("original bytes");
    const newer = bytes("newer external bytes");
    let reads = 0;
    await expect(
      persistExpectedBytesAtomically(
        join("workspace", ".arashi", "config.json"),
        bytes("replacement"),
        original,
        {
          open: async () => ({
            chmod: async () => {},
            chown: async () => {},
            close: async () => {},
            stat: async () => ({ gid: 20, uid: 501 }),
            sync: async () => {},
            writeFile: async () => {},
          }),
          platform: "linux",
          readFile: async () => (++reads === 1 ? original : newer),
          rename: async () => {},
          rm: async () => {
            throw new Error("stage cleanup failed");
          },
          stat: async () => ({ gid: 4242, mode: 0o600 }),
          temporaryName: () => ".config.json.cleanup.tmp",
        },
      ),
    ).rejects.toThrow(/stage cleanup failed|could not clean/i);
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

  test.each([
    ["unchanged original", "original bytes", false],
    ["partial candidate prefix", '{\n  "repos":', false],
    ["arbitrary different bytes", "external replacement", false],
    ["exact complete candidate", serializeConfig(config("children")), true],
  ] as const)(
    "after a reported save failure restores only %s",
    async (_name, liveValue, shouldRestore) => {
      const original = bytes("original bytes");
      const candidateBytes = bytes(serializeConfig(config("children")));
      let live = bytes(liveValue);
      const restore = vi.fn(async (originalBytes: Uint8Array, expectedCandidate: Uint8Array) => {
        expect(text(originalBytes)).toBe("original bytes");
        expect(text(expectedCandidate)).toBe(serializeConfig(config("children")));
        if (text(live) !== text(expectedCandidate)) return false;
        live = originalBytes;
        return true;
      });
      await expect(
        runConfigureTransaction({
          candidate: config("children"),
          expectedBytes: original,
          plans: [],
          dependencies: {
            installScripts: async () => [],
            readConfigBytes: async () => original,
            restoreConfig: restore,
            rollbackScripts: async () => ({ preserved: [], removed: [] }),
            saveConfig: async () => {
              expect(text(candidateBytes)).toBe(serializeConfig(config("children")));
              throw new Error("save failed after replacement");
            },
            withLock: async (operation) => operation(),
          },
        }),
      ).rejects.toThrow("save failed after replacement");
      expect(restore).toHaveBeenCalledOnce();
      expect(text(live)).toBe(shouldRestore ? "original bytes" : liveValue);
    },
  );

  test("preserves an external replacement that occurs immediately before recovery", async () => {
    const original = bytes("original bytes");
    const external = bytes("newer external bytes");
    let live = original;
    await expect(
      runConfigureTransaction({
        candidate: config("children"),
        expectedBytes: original,
        plans: [],
        dependencies: {
          installScripts: async () => [],
          readConfigBytes: async () => original,
          restoreConfig: async (_original, expectedCandidate) => {
            live = external;
            if (text(live) !== text(expectedCandidate)) return false;
            live = original;
            return true;
          },
          rollbackScripts: async () => ({ preserved: [], removed: [] }),
          saveConfig: async (candidate) => {
            live = bytes(serializeConfig(candidate));
            throw new Error("save failed after replacement");
          },
          withLock: async (operation) => operation(),
        },
      }),
    ).rejects.toThrow("save failed after replacement");
    expect(text(live)).toBe("newer external bytes");
  });

  test.each(["recovery succeeds", "recovery fails"] as const)(
    "active-file rollback still runs when config %s",
    async (outcome) => {
      const owned = [{ path: "/owned.sh" }] as OwnedRepositoryScript[];
      const rollback = vi.fn(async () => ({ preserved: [], removed: ["/owned.sh"] }));
      const failure = new Error("save failed after replacement");
      const promise = runConfigureTransaction({
        candidate: config("children"),
        expectedBytes: bytes("original"),
        plans: [],
        dependencies: {
          installScripts: async () => owned,
          readConfigBytes: async () => bytes("original"),
          restoreConfig: async () => {
            if (outcome === "recovery fails") throw new Error("config recovery failed");
            return true;
          },
          rollbackScripts: rollback,
          saveConfig: async () => {
            throw failure;
          },
          withLock: async (operation) => operation(),
        },
      });
      if (outcome === "recovery succeeds") await expect(promise).rejects.toBe(failure);
      else {
        await expect(promise).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.some((entry) => entry === failure) &&
            error.errors.some(
              (entry) => entry instanceof Error && entry.message === "config recovery failed",
            ),
        );
      }
      expect(rollback).toHaveBeenCalledWith(owned);
    },
  );

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
