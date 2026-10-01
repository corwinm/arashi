import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
);
const storageModes = ["case-sensitive", "case-insensitive-simulation", "windows-ACL-simulation"];
const literals = [
  "Followup",
  "followup",
  "CON",
  "NUL",
  "CON.txt",
  "NUL.txt",
  "followup.",
  "followup..",
];
test.each(storageModes)("A18 A25 $0 encoded literals remain distinct", async (storage) => {
  const f = await switchFixture(roots);
  if (storage === "windows-ACL-simulation") {
    f.dependencies.platform = "win32";
    f.dependencies.setWindowsOwnerOnly = async () => {};
  }
  const names: string[] = [];
  for (const intentId of literals) {
    f.input.switch!.intentId = intentId;
    const result = await dispatchT3Handoff(f.input);
    const path = await f.path();
    expect(result.receiptPath).toBe(path);
    const filename = path.split("/").at(-1)!;
    expect(filename).toBe("i-" + Buffer.from(intentId, "utf8").toString("hex") + ".json");
    expect(await f.receipt()).toMatchObject({ intentId, version: 3 });
    names.push(filename);
  }
  // Simulate the filesystem name comparison; all actual filenames are portable lowercase hex.
  const compared = names.map((name) =>
    storage === "case-sensitive" ? name : name.toLowerCase().replace(/[. ]+$/, ""),
  );
  expect(new Set(compared).size).toBe(literals.length);
  expect(f.threads).toHaveLength(literals.length);
  expect(f.projects).toHaveLength(1);
  expect(await readdir(dirname(await f.path()))).toHaveLength(literals.length);
});
test.each([
  "literal-mismatch",
  "noncanonical-uppercase",
  "noncanonical-oddhex",
  "noncanonical-empty",
  "noncanonical-prefix",
  "unknown-file",
  "unknown-dir",
  "key-collision",
  "physical-identity",
  "checkout-hash-collision",
  "owner-mode",
  "symlink-file",
  "symlink-dir",
])("A25 $0 namespace corruption zero remote effects", async (kind) => {
  const f = await switchFixture(roots);
  await dispatchT3Handoff(f.input);
  const path = await f.path(),
    dir = dirname(path);
  const receipt = await f.receipt();
  if (kind === "literal-mismatch") {
    receipt.intentId = "other";
  }
  if (kind === "physical-identity") {
    receipt.selectedGitIdentity.inode = "0";
  }
  if (kind === "checkout-hash-collision") {
    receipt.workspacePath = "/unrelated";
  }
  if (["literal-mismatch", "physical-identity", "checkout-hash-collision"].includes(kind)) {
    await f.write(receipt);
  }
  if (kind === "noncanonical-uppercase") {
    await writeFile(join(dir, "i-4A.json"), JSON.stringify({ ...receipt, intentId: "J" }));
  }
  if (kind === "noncanonical-oddhex") {
    await writeFile(join(dir, "i-1.json"), JSON.stringify(receipt));
  }
  if (kind === "noncanonical-empty") {
    await writeFile(join(dir, "i-.json"), JSON.stringify(receipt));
  }
  if (kind === "noncanonical-prefix") {
    // On an insensitive volume an alias overwrite retains the old canonical name.
    // Create a new noncanonical directory entry so the storage oracle is observable.
    await rm(path);
    await writeFile(join(dir, "I-64656661756c74.json"), JSON.stringify(receipt));
  }
  if (kind === "unknown-file") {
    await writeFile(join(dir, "unknown"), "{}");
  }
  if (kind === "unknown-dir") {
    await mkdir(join(dir, "unknown"));
  }
  if (kind === "key-collision") {
    await writeFile(path, JSON.stringify({ ...receipt, intentId: "Followup" }));
  }
  if (kind === "owner-mode") {
    await chmod(path, 0o644);
  }
  if (kind === "symlink-file") {
    await rm(path);
    await symlink(join(f.root, "missing"), path);
  }
  if (kind === "symlink-dir") {
    await rm(dir, { recursive: true });
    await symlink(f.root, dir);
  }
  const before = f.commands.length;
  await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
  expect(f.commands).toHaveLength(before);
});
test.each(
  ["root", "switch"].flatMap((scope) =>
    ["empty", "partial", "complete", "symlink", "directory"].map((kind) => ({ kind, scope })),
  ),
)("A26 $scope orphan $kind byte preservation", async ({ scope, kind }) => {
  const f = await switchFixture(roots);
  const create = await t3ReceiptPath(f.input.workspacePath);
  const dir = scope === "root" ? dirname(create) : dirname(await f.path());
  await mkdir(dir, { mode: 0o700, recursive: true });
  const orphan = join(dir, ".00000000-0000-0000-0000-000000000000.tmp");
  if (kind === "directory") {
    await mkdir(orphan);
  } else if (kind === "symlink") {
    await symlink(f.root, orphan);
  } else {
    await writeFile(orphan, kind === "empty" ? "" : kind === "partial" ? "{" : "{}");
  }
  const metadata = await lstat(orphan);
  const before = metadata.isFile() ? await readFile(orphan) : null;
  await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_RECEIPT_UNSAFE" });
  expect(await readdir(dir)).toContain(orphan.split("/").at(-1));
  if (before) {
    expect(await readFile(orphan)).toEqual(before);
  }
  expect(f.commands).toEqual([]);
});
test.each(["old", "new", "missing"])(
  "A26 surviving $0 receipt after rename never blind resend",
  async (surviving) => {
    const f = await switchFixture(roots);
    f.fail("thread.turn.start", "after");
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    const old = await f.receipt();
    expect(old.native.phase).toBe("submitting");
    const before = f.commands.length;
    if (surviving === "new") {
      const next = {
        ...old,
        dispatch: { status: "succeeded" },
        native: { ...old.native, phase: "accepted" },
        status: "succeeded",
      };
      await f.write(next);
    }
    if (surviving === "missing") {
      await rm(await f.path());
    }
    // Missing protection after a known interrupted rename is represented by the retained lock.
    if (surviving === "missing") {
      const lock = (await t3ReceiptPath(f.input.workspacePath)) + ".lock";
      await writeFile(lock, "crashed-owner");
      await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_HANDOFF_LOCKED" });
    } else {
      await expect(dispatchT3Handoff(f.input)).resolves.toMatchObject({ status: "succeeded" });
    }
    expect(f.commands).toHaveLength(before);
  },
);

test.each(["linux", "darwin", "win32"] as const)(
  "A25 injected $0 owner-only protection before remote requests",
  async (platform) => {
    const f = await switchFixture(roots);
    f.dependencies.platform = platform;
    const acl: string[] = [];
    f.dependencies.setWindowsOwnerOnly = async (path) => {
      acl.push(path);
    };
    const transport = f.dependencies.fetch!;
    f.dependencies.fetch = (async (url, init) => {
      if (init?.body) {
        const receipt = await f.path();
        const lock = (await t3ReceiptPath(f.input.workspacePath)) + ".lock";
        if (platform === "win32") {
          expect(acl).toContain(lock);
          expect(acl).toContain(dirname(receipt));
          expect(acl.some((path) => path.endsWith(".tmp"))).toBe(true);
        } else {
          expect((await lstat(receipt)).mode & 0o777).toBe(0o600);
          expect((await lstat(lock)).mode & 0o777).toBe(0o600);
          expect((await lstat(dirname(receipt))).mode & 0o777).toBe(0o700);
        }
      }
      return transport(url, init);
    }) as typeof fetch;
    await dispatchT3Handoff(f.input);
    expect(f.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
  },
);
test.each(["root", "switch-directory", "lock", "temporary"])(
  "A25 injected Windows ACL failure $0 blocks initial mutation",
  async (kind) => {
    const f = await switchFixture(roots);
    f.dependencies.platform = "win32";
    let hit = false;
    f.dependencies.setWindowsOwnerOnly = async (path) => {
      const matches =
        kind === "root"
          ? path.endsWith(".arashi-t3-handoffs")
          : kind === "switch-directory"
            ? path.endsWith(".switch")
            : kind === "lock"
              ? path.endsWith(".lock")
              : path.endsWith(".tmp");
      if (matches) {
        hit = true;
        throw new Error("ACL-SECRET-CANARY");
      }
    };
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    expect(hit).toBe(true);
    expect(f.commands).toEqual([]);
  },
);

test.each(["unknown-file", "unknown-directory", "noncanonical-receipt", "symlink-root"])(
  "A25 receipt root $0 fails closed",
  async (kind) => {
    const f = await switchFixture(roots);
    const root = dirname(await t3ReceiptPath(f.input.workspacePath));
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (kind === "unknown-file") await writeFile(join(root, "unknown"), "unowned");
    if (kind === "unknown-directory") await mkdir(join(root, "unknown"));
    if (kind === "noncanonical-receipt") await writeFile(join(root, "not-a-checkout.json"), "{}");
    if (kind === "symlink-root") {
      await rm(root, { recursive: true });
      await symlink(f.root, root);
    }
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    expect(f.commands).toEqual([]);
  },
);

test.each([
  "corrupt-json",
  "invalid-schema",
  "wrong-command",
  "common-directory",
  "git-directory",
  "device",
])("A25 $0 receipt validation fails closed", async (kind) => {
  const f = await switchFixture(roots);
  await dispatchT3Handoff(f.input);
  const receipt = await f.receipt();
  if (kind === "corrupt-json") await writeFile(await f.path(), "{");
  else if (kind === "invalid-schema") await writeFile(await f.path(), "{}");
  else {
    if (kind === "wrong-command") receipt.command = "create";
    if (kind === "common-directory") receipt.selectedGitIdentity.commonDirectory = "/other";
    if (kind === "git-directory") receipt.selectedGitIdentity.gitDirectory = "/other";
    if (kind === "device") receipt.selectedGitIdentity.device = "other";
    await f.write(receipt);
  }
  const before = f.commands.length;
  await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
  expect(f.commands).toHaveLength(before);
});
