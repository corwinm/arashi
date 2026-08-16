import { describe, expect, test } from "vitest";

type Action = "copy" | "symlink";
type SourceInspection =
  | { status: "missing" }
  | {
      canonicalPath: string;
      kind: "directory" | "file";
      links?: ReadonlyArray<{
        ancestorCanonicalIdentities?: readonly string[];
        canonicalIdentity: string;
        path: string;
        target: string;
      }>;
      status: "present";
    };
type DestinationInspection =
  | { status: "absent" }
  | { kind: "directory" | "file" | "symlink" | "junction"; status: "present" }
  | { ancestor: string; kind: "file" | "symlink" | "junction"; status: "ancestor-unsafe" };
type TargetTreeInspection =
  | { status: "absent" }
  | { kind: "directory" | "file" | "symlink"; matchedPath: string; status: "present" };

interface PlannerInput {
  copy: readonly string[];
  destinationRoot: string;
  dryRun: boolean;
  platform: NodeJS.Platform;
  repositoryId: string;
  sourceRoot: string;
  symlink: readonly string[];
  targetOid: string;
}

interface PlannerDependencies {
  inspectDestination(path: string): Promise<DestinationInspection>;
  inspectSource(path: string, action: Action): Promise<SourceInspection>;
  inspectTargetTree(targetOid: string, path: string): Promise<TargetTreeInspection>;
  resolveSymlinkCapability(kind: "directory" | "file"): Promise<"supported" | "unsupported">;
}

interface PlannedOutcome {
  action: Action;
  message: string;
  path: string;
  reasonCode:
    | "none"
    | "source_missing"
    | "source_inspection_failed"
    | "source_link_broken"
    | "source_escape"
    | "source_cycle"
    | "destination_exists"
    | "destination_ancestor_unsafe"
    | "destination_inspection_failed"
    | "symlink_unsupported";
  status: "blocked" | "skipped" | "would-copy" | "would-link";
}

interface MaterializationPlan {
  classification: "actionable" | "blocked";
  outcomes: PlannedOutcome[];
  repositoryId: string;
  targetOid: string;
}

type Planner = (
  input: PlannerInput,
  dependencies: PlannerDependencies,
) => Promise<MaterializationPlan>;

async function materializationPlanner(): Promise<Planner> {
  const module = (await import("../../src/core/worktree.ts")) as Record<string, unknown>;
  expect(module.planRepositoryMaterialization).toBeTypeOf("function");
  return module.planRepositoryMaterialization as Planner;
}

const input = (overrides: Partial<PlannerInput> = {}): PlannerInput => ({
  copy: ["present.txt", "missing.txt"],
  destinationRoot: "/workspace/.worktrees/app-feature",
  dryRun: true,
  platform: "linux",
  repositoryId: "app",
  sourceRoot: "/workspace/repos/app",
  symlink: [".cache"],
  targetOid: "0123456789abcdef",
  ...overrides,
});

const dependencies = (overrides: Partial<PlannerDependencies> = {}): PlannerDependencies => ({
  inspectDestination: async () => ({ status: "absent" }),
  inspectSource: async (path) =>
    path.endsWith("missing.txt")
      ? { status: "missing" }
      : {
          canonicalPath: path,
          kind: path.endsWith(".cache") ? "directory" : "file",
          status: "present",
        },
  inspectTargetTree: async () => ({ status: "absent" }),
  resolveSymlinkCapability: async () => "supported",
  ...overrides,
});

describe("shared repository materialization planner RED", () => {
  test("preserves copy-then-symlink declaration order and missing-source skips in a non-mutating dry-run", async () => {
    const planner = await materializationPlanner();
    const plan = await planner(input(), dependencies());

    expect(plan).toEqual({
      classification: "actionable",
      outcomes: [
        {
          action: "copy",
          message: "Would copy 'present.txt'",
          path: "present.txt",
          reasonCode: "none",
          status: "would-copy",
        },
        {
          action: "copy",
          message: "Source is missing; entry is optional",
          path: "missing.txt",
          reasonCode: "source_missing",
          status: "skipped",
        },
        {
          action: "symlink",
          message: "Would symlink '.cache'",
          path: ".cache",
          reasonCode: "none",
          status: "would-link",
        },
      ],
      repositoryId: "app",
      targetOid: "0123456789abcdef",
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.outcomes)).toBe(true);
  });

  test("distinguishes operational source inspection failure from expected absence", async () => {
    const planner = await materializationPlanner();
    const operational = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const plan = await planner(
      input({ copy: ["secret.env"], symlink: [] }),
      dependencies({ inspectSource: async () => Promise.reject(operational) }),
    );

    expect(plan).toMatchObject({
      classification: "blocked",
      outcomes: [
        {
          action: "copy",
          path: "secret.env",
          reasonCode: "source_inspection_failed",
          status: "blocked",
        },
      ],
    });
    expect(JSON.stringify(plan)).not.toContain("permission denied");
  });

  test.each([
    ["tracked destination", "config/local.json", "config/local.json", "file"],
    ["tracked incompatible ancestor", "config/local.json", "config", "file"],
    ["tracked link ancestor", "config/local.json", "config", "symlink"],
  ] as const)("blocks immutable target-tree %s", async (_case, path, matchedPath, kind) => {
    const planner = await materializationPlanner();
    const inspections: Array<{ oid: string; path: string }> = [];
    const plan = await planner(
      input({ copy: [path], symlink: [] }),
      dependencies({
        inspectTargetTree: async (oid, inspectedPath) => {
          inspections.push({ oid, path: inspectedPath });
          return { kind, matchedPath, status: "present" };
        },
      }),
    );

    expect(inspections).toEqual([{ oid: "0123456789abcdef", path }]);
    expect(plan).toMatchObject({
      classification: "blocked",
      outcomes: [{ path, reasonCode: "destination_exists", status: "blocked" }],
      targetOid: "0123456789abcdef",
    });
  });

  test.each([
    [{ kind: "file", status: "present" } as const, "destination_exists"],
    [
      { ancestor: "config", kind: "symlink", status: "ancestor-unsafe" } as const,
      "destination_ancestor_unsafe",
    ],
    [
      { ancestor: "config", kind: "junction", status: "ancestor-unsafe" } as const,
      "destination_ancestor_unsafe",
    ],
  ])("blocks filesystem destination or unsafe ancestor %#", async (inspection, reasonCode) => {
    const planner = await materializationPlanner();
    const plan = await planner(
      input({ copy: ["config/local.json"], symlink: [] }),
      dependencies({ inspectDestination: async () => inspection }),
    );

    expect(plan).toMatchObject({
      classification: "blocked",
      outcomes: [{ reasonCode, status: "blocked" }],
    });
  });

  test("blocks a top-level canonical source escape even without nested link records", async () => {
    const planner = await materializationPlanner();
    const plan = await planner(
      input({ copy: ["assets"], symlink: [] }),
      dependencies({
        inspectSource: async () => ({
          canonicalPath: "/outside/assets",
          kind: "directory",
          status: "present",
        }),
      }),
    );

    expect(plan).toMatchObject({
      classification: "blocked",
      outcomes: [{ path: "assets", reasonCode: "source_escape", status: "blocked" }],
    });
  });

  test("blocks a nested link whose canonical target re-enters active ancestry", async () => {
    const planner = await materializationPlanner();
    const plan = await planner(
      input({ copy: ["assets"], symlink: [] }),
      dependencies({
        inspectSource: async (path) => ({
          canonicalPath: path,
          kind: "directory",
          links: [
            {
              ancestorCanonicalIdentities: [
                "/workspace/repos/app/assets",
                "/workspace/repos/app/assets/a",
                "/workspace/repos/app/assets/a/b",
              ],
              canonicalIdentity: "/workspace/repos/app/assets/a",
              path: "assets/a/b/loop",
              target: "..",
            },
          ],
          status: "present",
        }),
      }),
    );

    expect(plan).toMatchObject({
      classification: "blocked",
      outcomes: [{ path: "assets", reasonCode: "source_cycle", status: "blocked" }],
    });
  });

  test.each([
    [
      "broken source link",
      "source_link_broken",
      [{ canonicalIdentity: "", path: "assets/link", target: "missing" }],
    ],
    [
      "escaping source link",
      "source_escape",
      [{ canonicalIdentity: "/outside", path: "assets/link", target: "/outside" }],
    ],
    [
      "source link cycle",
      "source_cycle",
      [
        {
          canonicalIdentity: "/workspace/repos/app/assets",
          path: "assets/again",
          target: "../assets",
        },
      ],
    ],
  ] as const)("blocks %s with a stable reason", async (_case, reasonCode, links) => {
    const planner = await materializationPlanner();
    const plan = await planner(
      input({ copy: ["assets"], symlink: [] }),
      dependencies({
        inspectSource: async (path) => ({
          canonicalPath: path,
          kind: "directory",
          links,
          status: "present",
        }),
      }),
    );

    expect(plan).toMatchObject({
      classification: "blocked",
      outcomes: [{ path: "assets", reasonCode, status: "blocked" }],
    });
  });

  test("accepts contained non-cyclic source links and repeats a completed target independently", async () => {
    const planner = await materializationPlanner();
    const plan = await planner(
      input({ copy: ["assets/a", "assets/b"], symlink: [] }),
      dependencies({
        inspectSource: async (path) => ({
          canonicalPath: "/workspace/repos/app/shared",
          kind: "directory",
          links: [
            {
              canonicalIdentity: "/workspace/repos/app/shared",
              path,
              target: "/workspace/repos/app/shared",
            },
          ],
          status: "present",
        }),
      }),
    );

    expect(plan.outcomes.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "assets/a", status: "would-copy" },
      { path: "assets/b", status: "would-copy" },
    ]);
  });

  test.each([
    [["Cache/data", "cache/DATA"], []],
    [[String.raw`cache\.\data`, "cache/data"], []],
    [["safe"], ["SAFE"]],
  ] as const)("rejects Windows destination aliases before inspection", async (copy, symlink) => {
    const planner = await materializationPlanner();
    let inspectionReached = false;
    const plan = await planner(
      input({ copy, platform: "win32", symlink }),
      dependencies({
        inspectDestination: async () => {
          inspectionReached = true;
          return { status: "absent" };
        },
      }),
    );

    expect(plan.classification).toBe("blocked");
    expect(plan.outcomes.some(({ status }) => status === "blocked")).toBe(true);
    expect(inspectionReached).toBe(false);
  });

  test("blocks ancestor-descendant declarations across copy and symlink before mutation", async () => {
    const plan = await (
      await materializationPlanner()
    )(input({ copy: ["assets"], symlink: ["assets/local.json"] }), dependencies());

    expect(plan.classification).toBe("blocked");
    expect(plan.outcomes).toEqual([
      expect.objectContaining({
        action: "copy",
        path: "assets",
        reasonCode: "destination_exists",
        status: "blocked",
      }),
      expect.objectContaining({
        action: "symlink",
        path: "assets/local.json",
        reasonCode: "destination_exists",
        status: "blocked",
      }),
    ]);
  });
});
