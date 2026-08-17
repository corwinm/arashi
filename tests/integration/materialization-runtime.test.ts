/* oxlint-disable sort-imports */
import { afterEach, describe, expect, test } from "vitest";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type MaterializationAction = "copy" | "symlink";
type MaterializationReason =
  | "none"
  | "source_missing"
  | "source_link_broken"
  | "source_escape"
  | "source_cycle"
  | "destination_exists"
  | "destination_ancestor_unsafe"
  | "symlink_unsupported"
  | "copy_failed"
  | "symlink_failed"
  | "rolled_back"
  | "rollback_failed";

interface MaterializationOutcome {
  action: MaterializationAction;
  message: string;
  path: string;
  reasonCode: MaterializationReason;
  status: "copied" | "linked" | "skipped" | "failed" | "rolled-back";
}

interface OwnershipEntry {
  kind: "directory" | "file" | "symlink";
  path: string;
}

interface MaterializationResult {
  materializationRollback: {
    attempted: boolean;
    complete: boolean;
    failureCount: number;
    failures: {
      action: MaterializationAction;
      message: string;
      path: string;
      reasonCode: "rollback_failed";
      repositoryId: string;
    }[];
  };
  outcomes: MaterializationOutcome[];
  ownershipLedger: OwnershipEntry[];
  repositoryId: string;
}

interface MaterializationInput {
  copy: string[];
  destinationRoot: string;
  repositoryId: string;
  sourceRoot: string;
  symlink: string[];
}

interface MaterializationDependencies {
  createSymlink?: (target: string, path: string, kind: "dir" | "file") => Promise<void>;
  removeOwnedObject?: (entry: OwnershipEntry) => Promise<void>;
}

type MaterializeRepository = (
  input: MaterializationInput,
  dependencies?: MaterializationDependencies,
) => Promise<MaterializationResult>;

interface DoctorFinding {
  category: "configuration" | "repository" | "worktree";
  code: string;
  details: Record<string, unknown>;
  message: string;
  scope: string;
  severity: "error" | "info" | "warning";
  suggestedCommands: string[];
}

type DiagnoseMaterialization = (input: {
  action: MaterializationAction | null;
  actualKind?: "directory" | "file" | "junction" | "symlink";
  ancestorKind?: "directory" | "file" | "junction" | "symlink";
  capability?: "available" | "unavailable" | "unknown";
  destinationStatus?:
    | "ancestor-unsafe"
    | "broken"
    | "kind-mismatch"
    | "missing"
    | "misdirected"
    | "present";
  expectedKind?: "directory" | "file";
  normalizedWorktreePath?: string | null;
  path: string | null;
  repositoryId: string;
  sourceStatus?: "missing" | "present" | "unavailable";
  worktreePath?: string | null;
}) => DoctorFinding[];

const roots: string[] = [];

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "arashi-materialization-runtime-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(destinationRoot, { recursive: true });
  return { destinationRoot, root, sourceRoot };
};

const loadMaterializer = async (): Promise<MaterializeRepository> => {
  const module = (await import("../../src/core/worktree.ts")) as Record<string, unknown>;
  expect(module.materializeRepository).toBeTypeOf("function");
  return module.materializeRepository as MaterializeRepository;
};

const loadDoctor = async (): Promise<DiagnoseMaterialization> => {
  const module = (await import("../../src/lib/doctor.ts")) as Record<string, unknown>;
  expect(module.materializationToDoctorFindings).toBeTypeOf("function");
  return module.materializationToDoctorFindings as DiagnoseMaterialization;
};

const input = (
  sourceRoot: string,
  destinationRoot: string,
  overrides: Partial<MaterializationInput> = {},
): MaterializationInput => ({
  copy: [],
  destinationRoot,
  repositoryId: "app",
  sourceRoot,
  symlink: [],
  ...overrides,
});

const absent = async (path: string) => {
  await expect(access(path)).rejects.toThrow();
};

const portableSymlinkTest = process.platform === "win32" ? test : test;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("runtime materialization containment", () => {
  test("rejects an absolute relative-path result from a different Windows volume", async () => {
    const { isContainedMaterializationRelativePath } =
      await import("../../src/lib/materializer.ts");
    expect(isContainedMaterializationRelativePath(String.raw`D:\outside`)).toBe(false);
    expect(isContainedMaterializationRelativePath(String.raw`child\file`)).toBe(true);
  });
});

describe("native filesystem materializer and ownership ledger RED", () => {
  test("copies files and deterministic directory trees with spaces/metacharacters into nested parents", async () => {
    const { destinationRoot, sourceRoot } = await fixture();
    await writeFile(join(sourceRoot, "plain.env"), "source-secret\n");
    await mkdir(join(sourceRoot, "assets with spaces", "z nested"), { recursive: true });
    await writeFile(join(sourceRoot, "assets with spaces", "a$.txt"), "alpha\n");
    await writeFile(join(sourceRoot, "assets with spaces", "z nested", "b!.txt"), "beta\n");

    const result = await (
      await loadMaterializer()
    )(
      input(sourceRoot, destinationRoot, {
        copy: ["plain.env", "assets with spaces"],
      }),
    );

    expect(result.outcomes).toEqual([
      {
        action: "copy",
        message: "Copied 'plain.env'",
        path: "plain.env",
        reasonCode: "none",
        status: "copied",
      },
      {
        action: "copy",
        message: "Copied 'assets with spaces'",
        path: "assets with spaces",
        reasonCode: "none",
        status: "copied",
      },
    ]);
    expect(await readFile(join(destinationRoot, "plain.env"), "utf8")).toBe("source-secret\n");
    expect(await readFile(join(destinationRoot, "assets with spaces", "a$.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(
      await readFile(join(destinationRoot, "assets with spaces", "z nested", "b!.txt"), "utf8"),
    ).toBe("beta\n");
    await writeFile(join(destinationRoot, "plain.env"), "destination-only\n");
    expect(await readFile(join(sourceRoot, "plain.env"), "utf8")).toBe("source-secret\n");
    expect(JSON.stringify(result)).not.toContain("source-secret");
    expect(result.ownershipLedger.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["directory", "file"]),
    );
  });

  test.skipIf(process.platform === "win32")(
    "preserves copied directory and derived parent permissions",
    async () => {
      const { destinationRoot, sourceRoot } = await fixture();
      await mkdir(join(sourceRoot, "credentials", "nested"), { recursive: true });
      await writeFile(join(sourceRoot, "credentials", "nested", "secret.txt"), "secret\n");
      await chmod(join(sourceRoot, "credentials"), 0o500);
      await chmod(join(sourceRoot, "credentials", "nested"), 0o500);

      const result = await (
        await loadMaterializer()
      )(input(sourceRoot, destinationRoot, { copy: ["credentials/nested"] }));

      expect(result.outcomes[0]).toMatchObject({ reasonCode: "none", status: "copied" });
      expect((await stat(join(destinationRoot, "credentials"))).mode & 0o777).toBe(0o500);
      expect((await stat(join(destinationRoot, "credentials", "nested"))).mode & 0o777).toBe(0o500);
      const { rollbackMaterializationOwnership } = await import("../../src/lib/materializer.ts");
      await expect(
        rollbackMaterializationOwnership(
          "app",
          "copy",
          "credentials/nested",
          result.ownershipLedger,
        ),
      ).resolves.toMatchObject({ complete: true, failureCount: 0 });
      await absent(join(destinationRoot, "credentials"));
      await Promise.all([
        chmod(join(sourceRoot, "credentials"), 0o700),
        chmod(join(sourceRoot, "credentials", "nested"), 0o700),
      ]);
    },
  );

  test("reports retained ownership when an injected rollback remover is a no-op", async () => {
    const { destinationRoot } = await fixture();
    const retained = join(destinationRoot, "retained.txt");
    await writeFile(retained, "retained\n");
    const { rollbackMaterializationOwnership } = await import("../../src/lib/materializer.ts");

    await expect(
      rollbackMaterializationOwnership(
        "app",
        "copy",
        "retained.txt",
        [{ kind: "file", path: retained }],
        async () => undefined,
      ),
    ).resolves.toMatchObject({
      complete: false,
      failureCount: 1,
      failures: [expect.objectContaining({ reasonCode: "rollback_failed" })],
    });
    expect(await readFile(retained, "utf8")).toBe("retained\n");
  });

  test.skipIf(process.platform === "win32")(
    "rolls back copied restrictive directories after a later entry fails",
    async () => {
      const { destinationRoot, sourceRoot } = await fixture();
      await mkdir(join(sourceRoot, "private"), { recursive: true });
      await writeFile(join(sourceRoot, "private", "secret.txt"), "secret\n");
      await chmod(join(sourceRoot, "private"), 0o500);
      await writeFile(join(sourceRoot, "conflict.txt"), "source\n");
      await writeFile(join(destinationRoot, "conflict.txt"), "existing\n");

      const result = await (
        await loadMaterializer()
      )(input(sourceRoot, destinationRoot, { copy: ["private", "conflict.txt"] }));

      expect(result.outcomes).toEqual([
        expect.objectContaining({
          path: "private",
          reasonCode: "rolled_back",
          status: "rolled-back",
        }),
        expect.objectContaining({
          path: "conflict.txt",
          reasonCode: "destination_exists",
          status: "failed",
        }),
      ]);
      await absent(join(destinationRoot, "private"));
      expect(await readFile(join(destinationRoot, "conflict.txt"), "utf8")).toBe("existing\n");
      await chmod(join(sourceRoot, "private"), 0o700);
    },
  );

  portableSymlinkTest(
    "dereferences contained source links and copies a repeated completed target independently",
    async () => {
      const { destinationRoot, sourceRoot } = await fixture();
      await mkdir(join(sourceRoot, "shared"), { recursive: true });
      await writeFile(join(sourceRoot, "shared", "payload.txt"), "shared\n");
      await mkdir(join(sourceRoot, "branches"), { recursive: true });
      await symlink(join(sourceRoot, "shared"), join(sourceRoot, "branches", "first"), "dir");
      await symlink(join(sourceRoot, "shared"), join(sourceRoot, "branches", "second"), "dir");

      const result = await (
        await loadMaterializer()
      )(input(sourceRoot, destinationRoot, { copy: ["branches"] }));

      expect(result.outcomes[0]).toMatchObject({ reasonCode: "none", status: "copied" });
      for (const name of ["first", "second"]) {
        const path = join(destinationRoot, "branches", name);
        expect((await lstat(path)).isDirectory()).toBe(true);
        expect((await lstat(path)).isSymbolicLink()).toBe(false);
        expect(await readFile(join(path, "payload.txt"), "utf8")).toBe("shared\n");
      }
      await writeFile(join(destinationRoot, "branches", "first", "payload.txt"), "first-only\n");
      expect(
        await readFile(join(destinationRoot, "branches", "second", "payload.txt"), "utf8"),
      ).toBe("shared\n");
    },
  );

  test.each([
    ["broken", "source_link_broken"],
    ["escape", "source_escape"],
    ["self-cycle", "source_cycle"],
    ["ancestor-cycle", "source_cycle"],
    ["multi-link-cycle", "source_cycle"],
  ] as const)(
    "rejects %s source links and removes only partial owned objects",
    async (variant, reasonCode) => {
      const { destinationRoot, root, sourceRoot } = await fixture();
      const tree = join(sourceRoot, "tree");
      await mkdir(join(tree, "a", "b"), { recursive: true });
      await writeFile(join(tree, "00-created-first.txt"), "owned\n");
      if (variant === "broken") {
        await symlink(join(tree, "missing"), join(tree, "zz-link"));
      } else if (variant === "escape") {
        const outside = join(root, "outside.txt");
        await writeFile(outside, "must-not-copy\n");
        await symlink(outside, join(tree, "zz-link"));
      } else if (variant === "self-cycle") {
        await symlink(tree, join(tree, "zz-link"), "dir");
      } else if (variant === "ancestor-cycle") {
        await symlink(tree, join(tree, "a", "b", "zz-link"), "dir");
      } else {
        await symlink(join(tree, "a", "b"), join(tree, "a", "next"), "dir");
        await symlink(join(tree, "a"), join(tree, "a", "b", "zz-link"), "dir");
      }
      await writeFile(join(destinationRoot, "pre-existing.txt"), "preserve\n");

      const result = await (
        await loadMaterializer()
      )(input(sourceRoot, destinationRoot, { copy: ["tree"] }));

      expect(result.outcomes).toEqual([
        expect.objectContaining({
          action: "copy",
          path: "tree",
          reasonCode,
          status: "failed",
        }),
      ]);
      expect(result.materializationRollback).toMatchObject({
        attempted: true,
        complete: true,
        failureCount: 0,
        failures: [],
      });
      await absent(join(destinationRoot, "tree"));
      expect(await readFile(join(destinationRoot, "pre-existing.txt"), "utf8")).toBe("preserve\n");
      expect(await readFile(join(tree, "00-created-first.txt"), "utf8")).toBe("owned\n");
    },
  );

  test("does not overwrite an existing object or remove pre-existing parents", async () => {
    const { destinationRoot, sourceRoot } = await fixture();
    await mkdir(join(sourceRoot, "nested"), { recursive: true });
    await writeFile(join(sourceRoot, "nested", "value.txt"), "new\n");
    await mkdir(join(destinationRoot, "nested"), { recursive: true });
    await writeFile(join(destinationRoot, "nested", "value.txt"), "old\n");

    const result = await (
      await loadMaterializer()
    )(input(sourceRoot, destinationRoot, { copy: ["nested/value.txt"] }));

    expect(result.outcomes).toEqual([
      expect.objectContaining({ reasonCode: "destination_exists", status: "failed" }),
    ]);
    expect(await readFile(join(destinationRoot, "nested", "value.txt"), "utf8")).toBe("old\n");
    expect((await lstat(join(destinationRoot, "nested"))).isDirectory()).toBe(true);
  });

  test("reports reverse cleanup failures without hiding the initiating failure", async () => {
    const { destinationRoot, sourceRoot } = await fixture();
    const tree = join(sourceRoot, "tree");
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, "00-owned.txt"), "owned\n");
    await symlink(join(tree, "missing"), join(tree, "zz-broken"));
    const attempted: OwnershipEntry[] = [];

    const result = await (
      await loadMaterializer()
    )(input(sourceRoot, destinationRoot, { copy: ["tree"] }), {
      removeOwnedObject: async (entry) => {
        attempted.push(entry);
        await rm(entry.path);
        if (entry.kind === "file") {
          throw new Error("simulated cleanup refusal with source-secret-that-must-not-leak");
        }
      },
    });

    expect(attempted.length).toBeGreaterThan(0);
    expect(attempted.map(({ path }) => path)).toEqual(
      attempted
        .map(({ path }) => path)
        .toReversed()
        .toReversed(),
    );
    expect(result.outcomes[0]).toMatchObject({
      reasonCode: "source_link_broken",
      status: "failed",
    });
    expect(result.materializationRollback).toMatchObject({
      attempted: true,
      complete: true,
      failureCount: 0,
      failures: [],
    });
    expect(JSON.stringify(result)).not.toContain("source-secret-that-must-not-leak");
  });

  test("retains ownership and successful status when cleanup cannot confirm removal", async () => {
    const { destinationRoot, sourceRoot } = await fixture();
    await writeFile(join(sourceRoot, "first.txt"), "owned\n");
    await symlink(join(sourceRoot, "missing"), join(sourceRoot, "broken"));

    const result = await (
      await loadMaterializer()
    )(input(sourceRoot, destinationRoot, { copy: ["first.txt", "broken"] }), {
      removeOwnedObject: async () => {
        throw new Error("simulated refusal");
      },
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ path: "first.txt", status: "copied" }),
      expect.objectContaining({ path: "broken", status: "failed" }),
    ]);
    expect(result.materializationRollback).toMatchObject({ complete: false, failureCount: 1 });
    expect(result.ownershipLedger).toEqual([
      expect.objectContaining({ kind: "file", path: join(destinationRoot, "first.txt") }),
    ]);
    expect(await readFile(join(destinationRoot, "first.txt"), "utf8")).toBe("owned\n");
  });

  test("creates exact native file and directory symlinks and never follows link objects during cleanup", async () => {
    const { destinationRoot, sourceRoot } = await fixture();
    await writeFile(join(sourceRoot, "file.txt"), "target-file\n");
    await mkdir(join(sourceRoot, "directory"), { recursive: true });
    await writeFile(join(sourceRoot, "directory", "target.txt"), "target-directory\n");

    const result = await (
      await loadMaterializer()
    )(input(sourceRoot, destinationRoot, { symlink: ["file.txt", "directory"] }));

    expect(result.outcomes.map(({ action, path, status }) => ({ action, path, status }))).toEqual([
      { action: "symlink", path: "file.txt", status: "linked" },
      { action: "symlink", path: "directory", status: "linked" },
    ]);
    expect((await lstat(join(destinationRoot, "file.txt"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(destinationRoot, "directory"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(destinationRoot, "file.txt"))).toBe(
      await realpath(join(sourceRoot, "file.txt")),
    );
    expect(await readlink(join(destinationRoot, "directory"))).toBe(
      await realpath(join(sourceRoot, "directory")),
    );
    await rm(join(destinationRoot, "directory"));
    expect(await readFile(join(sourceRoot, "directory", "target.txt"), "utf8")).toBe(
      "target-directory\n",
    );
  });

  test("uses native file/directory link kinds, has no junction/copy fallback, and skips a disappeared source", async () => {
    const { destinationRoot, sourceRoot } = await fixture();
    await writeFile(join(sourceRoot, "file.txt"), "must-not-copy\n");
    await mkdir(join(sourceRoot, "directory"), { recursive: true });
    const calls: { kind: "dir" | "file"; path: string; target: string }[] = [];
    const materialize = await loadMaterializer();

    const unavailable = await materialize(
      input(sourceRoot, destinationRoot, { symlink: ["file.txt"] }),
      {
        createSymlink: async (target, path, kind) => {
          calls.push({ kind, path, target });
          throw Object.assign(new Error("privilege unavailable"), { code: "EPERM" });
        },
      },
    );
    expect(calls).toEqual([
      {
        kind: "file",
        path: join(destinationRoot, "file.txt"),
        target: await realpath(join(sourceRoot, "file.txt")),
      },
    ]);
    expect(unavailable.outcomes[0]).toMatchObject({
      reasonCode: "symlink_unsupported",
      status: "failed",
    });
    await absent(join(destinationRoot, "file.txt"));

    await rm(join(sourceRoot, "file.txt"));
    const disappeared = await materialize(
      input(sourceRoot, destinationRoot, { symlink: ["file.txt", "directory"] }),
      {
        createSymlink: async (target, path, kind) => {
          calls.push({ kind, path, target });
          await symlink(target, path, kind);
        },
      },
    );
    expect(disappeared.outcomes).toEqual([
      expect.objectContaining({
        path: "file.txt",
        reasonCode: "source_missing",
        status: "skipped",
      }),
      expect.objectContaining({ path: "directory", reasonCode: "none", status: "linked" }),
    ]);
    expect(calls.at(-1)?.kind).toBe("dir");
  });

  test("rejects destination symlink ancestors without writing through them", async () => {
    const { destinationRoot, root, sourceRoot } = await fixture();
    await mkdir(join(sourceRoot, "nested"), { recursive: true });
    await writeFile(join(sourceRoot, "nested", "value.txt"), "contained\n");
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(destinationRoot, "nested"), "dir");

    const result = await (
      await loadMaterializer()
    )(input(sourceRoot, destinationRoot, { copy: ["nested/value.txt"] }));

    expect(result.outcomes[0]).toMatchObject({
      reasonCode: "destination_ancestor_unsafe",
      status: "failed",
    });
    await absent(join(outside, "value.txt"));
  });
});

describe("doctor materialization finding contract RED", () => {
  test.each([
    [
      {
        action: null,
        path: null,
        repositoryId: "app",
        sourceStatus: "unavailable",
        worktreePath: null,
      },
      {
        category: "repository",
        code: "MATERIALIZATION_SOURCE_CHECKOUT_UNAVAILABLE",
        details: { action: null, path: null, repositoryId: "app", worktreePath: null },
        scope: "materialization:app:source-checkout",
        severity: "error",
      },
    ],
    [
      {
        action: "copy",
        path: ".env",
        repositoryId: "app",
        sourceStatus: "missing",
        worktreePath: null,
      },
      {
        category: "repository",
        code: "MATERIALIZATION_SOURCE_MISSING",
        details: { action: "copy", path: ".env", repositoryId: "app", worktreePath: null },
        scope: "materialization:app:copy:.env",
        severity: "info",
      },
    ],
    [
      {
        action: "copy",
        actualKind: "directory",
        destinationStatus: "kind-mismatch",
        expectedKind: "file",
        normalizedWorktreePath: ".arashi/worktrees/workspace-feature/repos/app",
        path: ".env",
        repositoryId: "app",
        worktreePath: "/workspace/.arashi/worktrees/workspace-feature/repos/app",
      },
      {
        category: "worktree",
        code: "MATERIALIZATION_COPY_DESTINATION_KIND_MISMATCH",
        details: {
          action: "copy",
          actualKind: "directory",
          expectedKind: "file",
          path: ".env",
          repositoryId: "app",
          worktreePath: "/workspace/.arashi/worktrees/workspace-feature/repos/app",
        },
        scope: "materialization:app:.arashi/worktrees/workspace-feature/repos/app:copy:.env",
        severity: "warning",
      },
    ],
    [
      {
        action: "symlink",
        destinationStatus: "misdirected",
        normalizedWorktreePath: "wt/app",
        path: ".cache",
        repositoryId: "app",
        worktreePath: "/workspace/wt/app",
      },
      {
        category: "worktree",
        code: "MATERIALIZATION_SYMLINK_MISDIRECTED",
        details: {
          action: "symlink",
          path: ".cache",
          repositoryId: "app",
          worktreePath: "/workspace/wt/app",
        },
        scope: "materialization:app:wt/app:symlink:.cache",
        severity: "warning",
      },
    ],
    [
      { action: null, capability: "unknown", path: null, repositoryId: "app", worktreePath: null },
      {
        category: "configuration",
        code: "MATERIALIZATION_SYMLINK_CAPABILITY_UNKNOWN",
        details: { action: null, path: null, repositoryId: "app", worktreePath: null },
        scope: "materialization:app:symlink-capability",
        severity: "info",
      },
    ],
  ] as const)("emits the closed finding %#", async (diagnostic, expected) => {
    const findings = await (await loadDoctor())(diagnostic);
    expect(findings).toEqual([
      {
        ...expected,
        message: expect.any(String),
        suggestedCommands: [],
      },
    ]);
  });

  test("emits no copy ownership/freshness claim for a compatible destination", async () => {
    const findings = await (
      await loadDoctor()
    )({
      action: "copy",
      actualKind: "file",
      destinationStatus: "present",
      expectedKind: "file",
      normalizedWorktreePath: "wt/app",
      path: ".env",
      repositoryId: "app",
      sourceStatus: "present",
      worktreePath: "/workspace/wt/app",
    });
    expect(findings).toEqual([]);
  });

  test("doctor reports operational source inspection failures as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-materialization-doctor-unavailable-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    const { exec } = await import("../../src/lib/git.ts");
    await exec(["init"], source);
    await exec(["config", "user.email", "tests@example.com"], source);
    await exec(["config", "user.name", "Arashi Tests"], source);
    await writeFile(join(source, "tracked.txt"), "tracked\n");
    await exec(["add", "tracked.txt"], source);
    await exec(["-c", "commit.gpgSign=false", "commit", "-m", "fixture"], source);
    await symlink("loop", join(source, "loop"));

    const { collectMaterializationDiagnostics } =
      await import("../../src/lib/materialization-doctor.ts");
    await expect(
      collectMaterializationDiagnostics([
        {
          copy: ["loop"],
          defaultBranch: "main",
          name: "app",
          path: source,
          sourcePath: source,
        },
      ] as never),
    ).resolves.toContainEqual(
      expect.objectContaining({
        action: "copy",
        path: "loop",
        repositoryId: "app",
        sourceStatus: "unavailable",
      }),
    );
  });

  test("doctor ignores linked worktrees outside the managed workspace worktree root", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-materialization-doctor-managed-"));
    roots.push(root);
    const source = join(root, "source");
    const workspace = join(root, "workspace");
    const managed = join(workspace, ".arashi", "worktrees", "managed", "repos", "app");
    const unmanaged = join(root, "manual-worktree");
    await mkdir(source, { recursive: true });
    const { exec } = await import("../../src/lib/git.ts");
    await exec(["init"], source);
    await exec(["config", "user.email", "tests@example.com"], source);
    await exec(["config", "user.name", "Arashi Tests"], source);
    await writeFile(join(source, "tracked.txt"), "tracked\n");
    await exec(["add", "tracked.txt"], source);
    await exec(["-c", "commit.gpgSign=false", "commit", "-m", "fixture"], source);
    await writeFile(join(source, ".env.local"), "local\n");
    await mkdir(join(managed, ".."), { recursive: true });
    await exec(["worktree", "add", "-b", "managed", managed], source);
    await exec(["worktree", "add", "-b", "manual", unmanaged], source);

    const { collectMaterializationDiagnostics } =
      await import("../../src/lib/materialization-doctor.ts");
    const diagnostics = await collectMaterializationDiagnostics(
      [
        {
          copy: [".env.local"],
          defaultBranch: "main",
          name: "app",
          path: source,
          sourcePath: source,
        },
      ] as never,
      workspace,
    );

    expect(diagnostics.filter((diagnostic) => diagnostic.destinationStatus === "missing")).toEqual([
      expect.objectContaining({ normalizedWorktreePath: managed, worktreePath: managed }),
    ]);
  });
});
