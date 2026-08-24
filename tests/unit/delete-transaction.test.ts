import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createDeleteResumeReceipt,
  receiptPlanConfigDigest,
  parseWindowsOwnerOnlyAcl,
  readValidatedDeleteReceipt,
  readValidatedDeleteReceiptBytes,
  receiptPathForRepositoryKey,
  removeDeleteResumeReceipt,
  runDeleteBatchTransaction,
  updateDeleteResumeReceipt,
  windowsAclPowerShellEnvironment,
  type DeleteResumeReceipt,
} from "../../src/lib/delete-transaction.ts";
const createTempDir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));
const provenReceiptSafety = { assertWindowsOwnerOnly: async (): Promise<boolean> => true };

const receipt = (repositoryKey: string, receiptPath = "/receipt"): DeleteResumeReceipt => ({
  version: 1,
  planId: "c".repeat(64),
  parentIdentity: "d".repeat(64),
  repositoryKey,
  configDigest: "a".repeat(64),
  originalEntryDigest: "b".repeat(64),
  identities: [
    { id: "receipt", kind: "resume-receipt", path: receiptPath, ref: null, oid: null },
    { id: "item", kind: "canonical-clone", path: "/repo", ref: null, oid: null },
  ],
  completedItemIds: [],
  completedPhases: [],
  remainingPhases: [
    "provenance",
    "worktrees",
    "metadata",
    "canonical-clone",
    "workspace-hooks",
    "configuration",
    "verification",
  ],
  retryArgv: ["aw", "delete", repositoryKey, "--force"],
  warnings: [],
  runtime: {
    workspaceRoot: "/workspace",
    configPath: "/workspace/.arashi/config.json",
    clonePath: "/repo",
    hookPaths: [],
    expectedConfigBase64: Buffer.from("before").toString("base64"),
    nextConfigBase64: Buffer.from("after").toString("base64"),
    topology: {
      commonDirectory: "/repo/.git",
      configuredActivePath: "/repo",
      primaryPath: "/repo",
      canonicalClonePath: "/repo",
      linkedWorktrees: [],
      staleMetadata: [],
      inventory: [],
    },
    identities: {
      clone: {
        path: "/repo",
        leaf: { path: "/repo", identity: "dev:ino", kind: "directory" },
        ancestors: [{ path: "/", identity: "root", kind: "directory" }],
      },
      worktrees: [],
      metadata: [],
      hooks: [],
    },
  },
});

describe("delete resume receipts", () => {
  test("isolates Windows PowerShell from an incompatible inherited module path", () => {
    expect(
      windowsAclPowerShellEnvironment("C:\\receipt", {
        Path: "C:\\Windows",
        PSModulePath: "C:\\Program Files\\PowerShell\\Modules",
        pSmOdUlEpAtH: "C:\\other-modules",
      }),
    ).toEqual({
      ARASHI_DELETE_RECEIPT_PATH: "C:\\receipt",
      Path: "C:\\Windows",
    });
  });

  test("accepts only a Windows ACL owned by and granting access to the current user", () => {
    const owner = "S-1-5-21-1000";
    expect(
      parseWindowsOwnerOnlyAcl(
        JSON.stringify({
          owner,
          currentUser: owner,
          access: [{ identity: owner, type: "Allow" }],
        }),
      ),
    ).toBe(true);
    expect(
      parseWindowsOwnerOnlyAcl(
        JSON.stringify({
          owner,
          currentUser: owner,
          access: [
            { identity: owner, type: "Allow" },
            { identity: "S-1-5-32-545", type: "Allow" },
          ],
        }),
      ),
    ).toBe(false);
    expect(parseWindowsOwnerOnlyAcl("not-json")).toBe(false);
  });

  test("applies and verifies owner-only ACLs for Windows receipt creation", async () => {
    const root = await createTempDir("delete-receipt-windows-acl-");
    const path = receiptPathForRepositoryKey(root, "api");
    const setWindowsOwnerOnly = vi.fn(async () => undefined);
    const assertWindowsOwnerOnly = vi.fn(async () => true);

    await createDeleteResumeReceipt(path, receipt("api", path), {
      platform: "win32",
      assertWindowsOwnerOnly,
      setWindowsOwnerOnly,
    });

    expect(setWindowsOwnerOnly).toHaveBeenNthCalledWith(1, join(root, ".arashi-delete-receipts"));
    expect(setWindowsOwnerOnly).toHaveBeenNthCalledWith(2, path);
    expect(assertWindowsOwnerOnly).toHaveBeenCalledWith(join(root, ".arashi-delete-receipts"));
    expect(assertWindowsOwnerOnly).toHaveBeenCalledWith(path);
  });

  test("installs inheritable owner-only Windows ACLs on receipt directories", async () => {
    const source = await readFile(
      new URL("../../src/lib/delete-transaction.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("ContainerInherit,ObjectInherit");
    expect(source).toContain("PropagationFlags]::None");
  });

  test("keeps the accepted batch plan digest independent of per-target config bytes", () => {
    const acceptedDigest = "a".repeat(64);
    expect(receiptPlanConfigDigest(acceptedDigest, Buffer.from("later target bytes"))).toBe(
      acceptedDigest,
    );
  });

  test("uses the lowercase SHA-256 of the exact UTF-8 key", () => {
    expect(receiptPathForRepositoryKey("/common", "Api/β")).toBe(
      join(
        "/common",
        ".arashi-delete-receipts",
        "8b636bae5f9b6ba49556f6e66db09042fcc83217834c930ff1941b9aad9db7d0.json",
      ),
    );
  });

  test("creates an owner-only receipt exclusively and refuses replacement", async () => {
    const root = await createTempDir("delete-receipt-");
    const path = receiptPathForRepositoryKey(root, "api");
    const created = await createDeleteResumeReceipt(
      path,
      receipt("api", path),
      provenReceiptSafety,
    );

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt("api", path));
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      createDeleteResumeReceipt(path, receipt("api", path), provenReceiptSafety),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(Buffer.from(created).equals(await readFile(path))).toBe(true);
  });

  test("removes the exact partial receipt when its initial write fails", async () => {
    const root = await createTempDir("delete-receipt-partial-");
    const path = receiptPathForRepositoryKey(root, "api");

    await expect(
      createDeleteResumeReceipt(path, receipt("api", path), {
        openExclusive: async (target, flags, mode) => {
          const handle = await open(target, flags, mode);
          return {
            chmod: handle.chmod.bind(handle),
            close: handle.close.bind(handle),
            stat: handle.stat.bind(handle),
            sync: handle.sync.bind(handle),
            writeFile: async () => {
              throw new Error("injected initial write failure");
            },
          };
        },
      }),
    ).rejects.toThrow("injected initial write failure");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves a replacement installed while Windows ACL setup fails", async () => {
    const root = await createTempDir("delete-receipt-windows-acl-race-");
    const path = receiptPathForRepositoryKey(root, "api");
    const moved = `${path}.moved`;
    const replacement = "replacement receipt\n";

    await expect(
      createDeleteResumeReceipt(path, receipt("api", path), {
        platform: "win32",
        assertWindowsOwnerOnly: async () => true,
        setWindowsOwnerOnly: async (target) => {
          if (target !== path) return;
          await rename(path, moved);
          await writeFile(path, replacement, { mode: 0o600 });
          throw new Error("injected Windows ACL failure after replacement");
        },
      }),
    ).rejects.toThrow("injected Windows ACL failure after replacement");

    await expect(readFile(path, "utf8")).resolves.toBe(replacement);
    await expect(stat(moved)).resolves.toBeDefined();
  });

  test("updates only the exact expected bytes and rejects unsafe permissions", async () => {
    const root = await createTempDir("delete-receipt-update-");
    const path = receiptPathForRepositoryKey(root, "api");
    const initial = await createDeleteResumeReceipt(
      path,
      receipt("api", path),
      provenReceiptSafety,
    );
    const next = {
      ...receipt("api", path),
      completedItemIds: ["receipt"],
      completedPhases: ["provenance"],
      remainingPhases: [
        "worktrees",
        "metadata",
        "canonical-clone",
        "workspace-hooks",
        "configuration",
        "verification",
      ],
    } satisfies DeleteResumeReceipt;

    const updated = await updateDeleteResumeReceipt(path, initial, next, provenReceiptSafety);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(next);
    await expect(
      updateDeleteResumeReceipt(path, initial, receipt("api", path), provenReceiptSafety),
    ).rejects.toThrow(/changed concurrently/u);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(
        updateDeleteResumeReceipt(path, updated, receipt("api", path), provenReceiptSafety),
      ).rejects.toThrow(/owner-only/u);
    }
  });

  test("sets and verifies the staged Windows receipt ACL before atomic replacement", async () => {
    const root = await createTempDir("delete-receipt-windows-update-acl-");
    const path = receiptPathForRepositoryKey(root, "api");
    const initial = await createDeleteResumeReceipt(
      path,
      receipt("api", path),
      provenReceiptSafety,
    );
    const events: string[] = [];
    const setWindowsOwnerOnly = vi.fn(async (target: string) => {
      events.push(`set:${target}`);
    });
    const assertWindowsOwnerOnly = vi.fn(async (target: string) => {
      events.push(`assert:${target}`);
      return true;
    });

    await updateDeleteResumeReceipt(path, initial, receipt("api", path), {
      platform: "win32",
      assertWindowsOwnerOnly,
      setWindowsOwnerOnly,
    });

    const stagedSet = events.findIndex(
      (event) => event.startsWith("set:") && event !== `set:${path}`,
    );
    expect(stagedSet).toBeGreaterThanOrEqual(0);
    const stagedPath = events[stagedSet]!.slice("set:".length);
    const stagedAssert = events.indexOf(`assert:${stagedPath}`, stagedSet + 1);
    const liveAssert = events.lastIndexOf(`assert:${path}`);
    expect(stagedAssert).toBeGreaterThan(stagedSet);
    expect(liveAssert).toBeGreaterThan(stagedAssert);
  });

  test.skipIf(process.platform !== "win32")(
    "creates, updates, and reads a receipt with native owner-only Windows ACLs",
    async () => {
      const root = await createTempDir("delete-receipt-native-windows-acl-");
      const path = receiptPathForRepositoryKey(root, "api");
      const initial = await createDeleteResumeReceipt(path, receipt("api", path));
      const next = {
        ...receipt("api", path),
        completedItemIds: ["receipt"],
        completedPhases: ["provenance"],
        remainingPhases: [
          "worktrees",
          "metadata",
          "canonical-clone",
          "workspace-hooks",
          "configuration",
          "verification",
        ],
      };

      await updateDeleteResumeReceipt(path, initial, next);
      await expect(
        readValidatedDeleteReceipt(path, {
          parentIdentity: "d".repeat(64),
          repositoryKey: "api",
        }),
      ).resolves.toMatchObject({ receipt: next });
    },
  );

  test("removes only the exact expected receipt bytes", async () => {
    const root = await createTempDir("delete-receipt-remove-");
    const path = receiptPathForRepositoryKey(root, "api");
    const initial = await createDeleteResumeReceipt(
      path,
      receipt("api", path),
      provenReceiptSafety,
    );
    const changed = Buffer.from(initial);
    changed[changed.length - 2] = 32;

    await expect(
      removeDeleteResumeReceipt(path, changed, undefined, provenReceiptSafety),
    ).rejects.toThrow(/changed concurrently/u);
    expect(await readFile(path)).toEqual(Buffer.from(initial));
    await removeDeleteResumeReceipt(path, initial, undefined, provenReceiptSafety);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("receipt cleanup also requires the captured file identity", async () => {
    const root = await createTempDir("delete-receipt-remove-identity-");
    const path = receiptPathForRepositoryKey(root, "api");
    const initial = await createDeleteResumeReceipt(
      path,
      receipt("api", path),
      provenReceiptSafety,
    );

    await expect(
      removeDeleteResumeReceipt(path, initial, "wrong:identity", provenReceiptSafety),
    ).rejects.toThrow(/identity changed/u);
    expect(await readFile(path)).toEqual(Buffer.from(initial));
  });

  test("reads without following links and validates a closed receipt schema and provenance", async () => {
    const root = await createTempDir("delete-receipt-validate-");
    const path = receiptPathForRepositoryKey(root, "api");
    await createDeleteResumeReceipt(path, receipt("api", path), provenReceiptSafety);

    const loaded = await readValidatedDeleteReceipt(
      path,
      { parentIdentity: "d".repeat(64), repositoryKey: "api" },
      provenReceiptSafety,
    );
    expect(loaded.receipt).toEqual(receipt("api", path));
    expect(loaded.bytes).toEqual(await readFile(path));

    await writeFile(path, `${JSON.stringify({ ...receipt("api", path), surprise: true })}\n`, {
      mode: 0o600,
    });
    await expect(
      readValidatedDeleteReceipt(
        path,
        { parentIdentity: "parent", repositoryKey: "api" },
        provenReceiptSafety,
      ),
    ).rejects.toMatchObject({ code: "DELETE_RECEIPT_INVALID" });
  });

  test.each(["identity", "runtime", "topology", "path-identity"])(
    "rejects controlled extra fields in nested %s records",
    async (target) => {
      const root = await createTempDir(`delete-receipt-extra-${target}-`);
      const path = receiptPathForRepositoryKey(root, "api");
      const malformed = receipt("api", path) as DeleteResumeReceipt & Record<string, unknown>;
      if (target === "identity") Object.assign(malformed.identities[0]!, { surprise: true });
      else if (target === "runtime") Object.assign(malformed.runtime, { surprise: true });
      else if (target === "topology") Object.assign(malformed.runtime.topology, { surprise: true });
      else Object.assign(malformed.runtime.identities.clone.leaf!, { surprise: true });
      await createDeleteResumeReceipt(path, malformed, provenReceiptSafety);

      await expect(
        readValidatedDeleteReceipt(
          path,
          { parentIdentity: "d".repeat(64), repositoryKey: "api" },
          provenReceiptSafety,
        ),
      ).rejects.toMatchObject({ code: "DELETE_RECEIPT_INVALID" });
    },
  );

  test("fails closed when the injected Windows owner-only ACL check cannot prove safety", async () => {
    const root = await createTempDir("delete-receipt-acl-");
    const path = receiptPathForRepositoryKey(root, "api");
    await createDeleteResumeReceipt(path, receipt("api", path), provenReceiptSafety);

    await expect(
      readValidatedDeleteReceipt(
        path,
        { parentIdentity: "d".repeat(64), repositoryKey: "api" },
        { platform: "win32", assertWindowsOwnerOnly: async () => false },
      ),
    ).rejects.toMatchObject({ code: "DELETE_RECEIPT_UNSAFE" });
  });

  test("rejects stale provenance before trusting completed work", async () => {
    const root = await createTempDir("delete-receipt-stale-");
    const path = receiptPathForRepositoryKey(root, "api");
    await createDeleteResumeReceipt(path, receipt("api", path), provenReceiptSafety);

    await expect(
      readValidatedDeleteReceipt(
        path,
        { parentIdentity: "different-parent", repositoryKey: "api" },
        provenReceiptSafety,
      ),
    ).rejects.toMatchObject({ code: "DELETE_RECEIPT_STALE" });
  });

  test("does not follow a receipt symbolic link", async () => {
    const root = await createTempDir("delete-receipt-link-");
    const target = join(root, "target.json");
    const path = receiptPathForRepositoryKey(root, "api");
    await createDeleteResumeReceipt(target, receipt("api", target), provenReceiptSafety);
    await mkdir(join(root, ".arashi-delete-receipts"), { mode: 0o700 });
    await symlink(target, path);

    await expect(
      readValidatedDeleteReceipt(
        path,
        { parentIdentity: "d".repeat(64), repositoryKey: "api" },
        provenReceiptSafety,
      ),
    ).rejects.toMatchObject({ code: "DELETE_RECEIPT_UNSAFE" });
  });

  test("rejects completed items outside the completed-phase prefix", async () => {
    const root = await createTempDir("delete-receipt-ledger-");
    const path = receiptPathForRepositoryKey(root, "api");
    const malformed = receipt("api", path);
    malformed.completedItemIds = ["item"];
    await createDeleteResumeReceipt(path, malformed, provenReceiptSafety);

    await expect(
      readValidatedDeleteReceipt(
        path,
        { parentIdentity: "d".repeat(64), repositoryKey: "api" },
        provenReceiptSafety,
      ),
    ).rejects.toMatchObject({ code: "DELETE_RECEIPT_INVALID" });
  });

  test("rejects a non-prefix item ledger within the active phase", async () => {
    const root = await createTempDir("delete-receipt-item-prefix-");
    const path = receiptPathForRepositoryKey(root, "api");
    const malformed = receipt("api", path);
    malformed.identities.push(
      { id: "hook-a", kind: "workspace-hook", path: "/hooks/a", ref: null, oid: null },
      { id: "hook-b", kind: "workspace-hook", path: "/hooks/b", ref: null, oid: null },
    );
    malformed.completedPhases = ["provenance", "worktrees", "metadata", "canonical-clone"];
    malformed.remainingPhases = ["workspace-hooks", "configuration", "verification"];
    malformed.completedItemIds = ["receipt", "item", "hook-b"];
    await createDeleteResumeReceipt(path, malformed, provenReceiptSafety);

    await expect(
      readValidatedDeleteReceipt(
        path,
        { parentIdentity: "d".repeat(64), repositoryKey: "api" },
        provenReceiptSafety,
      ),
    ).rejects.toMatchObject({ code: "DELETE_RECEIPT_INVALID" });
  });

  test("rejects runtime identities that do not match receipt item provenance", async () => {
    const root = await createTempDir("delete-receipt-identity-provenance-");
    const path = receiptPathForRepositoryKey(root, "api");
    const malformed = receipt("api", path);
    malformed.runtime.identities.clone.path = "/replacement";
    malformed.runtime.identities.clone.leaf.path = "/replacement";
    await createDeleteResumeReceipt(path, malformed, provenReceiptSafety);

    await expect(
      readValidatedDeleteReceipt(
        path,
        { parentIdentity: "d".repeat(64), repositoryKey: "api" },
        provenReceiptSafety,
      ),
    ).rejects.toMatchObject({ code: "DELETE_RECEIPT_INVALID" });
  });

  test("reads expected receipt bytes through the no-follow owner-only path", async () => {
    const root = await createTempDir("delete-receipt-bytes-");
    const path = receiptPathForRepositoryKey(root, "api");
    const initial = await createDeleteResumeReceipt(
      path,
      receipt("api", path),
      provenReceiptSafety,
    );

    expect(Buffer.from(await readValidatedDeleteReceiptBytes(path, provenReceiptSafety))).toEqual(
      Buffer.from(initial),
    );
  });
});

describe("delete batch transaction", () => {
  test("takes one lock, revalidates every plan before the first target, and stops on failure", async () => {
    const events: string[] = [];
    const targets = ["alpha", "beta", "zeta"].map((repositoryKey) => ({ repositoryKey }));
    const result = await runDeleteBatchTransaction(targets, {
      withLock: async (operation) => {
        events.push("lock:start");
        const value = await operation();
        events.push("lock:end");
        return value;
      },
      revalidateAll: async (accepted) => {
        events.push(`revalidate:${accepted.map(({ repositoryKey }) => repositoryKey).join(",")}`);
      },
      executeTarget: async ({ repositoryKey }) => {
        events.push(`execute:${repositoryKey}`);
        if (repositoryKey === "beta") throw new Error("injected failure");
        return { repositoryKey, marker: "completed" };
      },
      failedTarget: ({ repositoryKey }, error) => ({
        repositoryKey,
        marker: "failed",
        message: (error as Error).message,
      }),
      notStartedTarget: ({ repositoryKey }) => ({ repositoryKey, marker: "not-started" }),
    });

    expect(events).toEqual([
      "lock:start",
      "revalidate:alpha,beta,zeta",
      "execute:alpha",
      "execute:beta",
      "lock:end",
    ]);
    expect(result).toEqual([
      { repositoryKey: "alpha", marker: "completed" },
      { repositoryKey: "beta", marker: "failed", message: "injected failure" },
      { repositoryKey: "zeta", marker: "not-started" },
    ]);
  });

  test("creates no target state when locked revalidation fails", async () => {
    const executeTarget = vi.fn();
    await expect(
      runDeleteBatchTransaction([{ repositoryKey: "api" }], {
        withLock: async (operation) => operation(),
        revalidateAll: async () => {
          throw new Error("plan changed");
        },
        executeTarget,
        failedTarget: () => ({ marker: "failed" }),
        notStartedTarget: () => ({ marker: "not-started" }),
      }),
    ).rejects.toThrow(/plan changed/u);
    expect(executeTarget).not.toHaveBeenCalled();
  });

  test("revalidates the surviving plan immediately before every target", async () => {
    const events: string[] = [];
    await runDeleteBatchTransaction([{ repositoryKey: "alpha" }, { repositoryKey: "beta" }], {
      withLock: async (operation) => operation(),
      revalidateAll: async () => {
        events.push("all");
      },
      revalidateTarget: async ({ repositoryKey }) => {
        events.push(`target:${repositoryKey}`);
      },
      executeTarget: async ({ repositoryKey }) => {
        events.push(`execute:${repositoryKey}`);
        return repositoryKey;
      },
      failedTarget: ({ repositoryKey }) => repositoryKey,
      notStartedTarget: ({ repositoryKey }) => repositoryKey,
    });
    expect(events).toEqual(["all", "target:alpha", "execute:alpha", "target:beta", "execute:beta"]);
  });
});
