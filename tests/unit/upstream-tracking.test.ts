import { describe, expect, test } from "vitest";

type GitResult = { stdout: string };
type RunGit = (args: string[], cwd: string) => Promise<GitResult>;
type Inspection =
  | {
      kind: "missing-fetch-mapping";
      localBranch: string;
      mergeRef: string;
      remote: string;
      remoteBranch: string;
      expectedRemoteTrackingRef: string;
    }
  | { kind: "not-applicable" };

const loadInspector = async (): Promise<
  (repoPath: string, runGit?: RunGit) => Promise<Inspection>
> => {
  const module = await import("../../src/lib/git-remote.ts");
  const candidate = Reflect.get(module, "inspectUpstreamTrackingConfiguration");
  expect(candidate).toBeTypeOf("function");
  return candidate as (repoPath: string, runGit?: RunGit) => Promise<Inspection>;
};

interface FakeGitState {
  branch?: string;
  remote?: string;
  mergeRef?: string;
  trackingRefExists?: boolean;
  fetchRefspecs?: string[];
  upstream?: string;
}

const createFakeGit = (state: FakeGitState): { calls: string[][]; runGit: RunGit } => {
  const calls: string[][] = [];
  const runGit: RunGit = async (args) => {
    calls.push(args);
    const command = args.join(" ");

    if (command === "symbolic-ref --quiet --short HEAD") {
      if (!state.branch) throw new Error("detached");
      return { stdout: `${state.branch}\n` };
    }
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
      if (!state.upstream) throw new Error("no strict upstream");
      return { stdout: `${state.upstream}\n` };
    }
    if (command === `config --get branch.${state.branch}.remote`) {
      if (state.remote === undefined) throw new Error("unset remote");
      return { stdout: `${state.remote}\n` };
    }
    if (command === `config --get branch.${state.branch}.merge`) {
      if (state.mergeRef === undefined) throw new Error("unset merge ref");
      return { stdout: `${state.mergeRef}\n` };
    }
    if (command.startsWith("show-ref --verify refs/remotes/")) {
      if (!state.trackingRefExists) throw new Error("missing tracking ref");
      return { stdout: "0123456789abcdef refs/remotes/origin/main\n" };
    }
    if (command === `config --get-all remote.${state.remote}.fetch`) {
      if (!state.fetchRefspecs || state.fetchRefspecs.length === 0) {
        throw new Error("unset fetch mapping");
      }
      return { stdout: `${state.fetchRefspecs.join("\n")}\n` };
    }

    throw new Error(`Unexpected or mutating Git command: ${command}`);
  };

  return { calls, runGit };
};

const configuredState = (overrides: FakeGitState = {}): FakeGitState => ({
  branch: "main",
  mergeRef: "refs/heads/main",
  remote: "origin",
  trackingRefExists: true,
  ...overrides,
});

describe("inspectUpstreamTrackingConfiguration", () => {
  test.each([
    ["absent branch remote", configuredState({ remote: undefined })],
    ["local-dot remote", configuredState({ remote: "." })],
    ["malformed merge ref", configuredState({ mergeRef: "main" })],
    ["missing expected tracking ref", configuredState({ trackingRefExists: false })],
    [
      "exact covering fetch mapping",
      configuredState({
        fetchRefspecs: ["+refs/heads/main:refs/remotes/origin/main"],
      }),
    ],
    [
      "wildcard covering fetch mapping",
      configuredState({
        fetchRefspecs: ["+refs/heads/*:refs/remotes/origin/*"],
      }),
    ],
    ["already resolvable strict upstream", configuredState({ upstream: "origin/main" })],
  ])("returns not-applicable for %s", async (_name, state) => {
    const inspect = await loadInspector();
    const { calls, runGit } = createFakeGit(state);

    await expect(inspect("/workspace", runGit)).resolves.toEqual({ kind: "not-applicable" });
    expect(calls.some((args) => args[0] === "fetch")).toBe(false);
  });

  test.each([
    ["missing fetch mapping", configuredState(), []],
    [
      "incompatible fetch mapping",
      configuredState({
        fetchRefspecs: ["+refs/heads/release:refs/remotes/origin/release"],
      }),
      [],
    ],
    [
      "conflicting exact fetch mapping destination",
      configuredState({
        fetchRefspecs: ["+refs/heads/trunk:refs/remotes/origin/main"],
      }),
      ["+refs/heads/trunk:refs/remotes/origin/main"],
    ],
    [
      "conflicting wildcard fetch mapping destination",
      configuredState({
        fetchRefspecs: ["+refs/heads/release/*:refs/remotes/origin/*"],
      }),
      ["+refs/heads/release/*:refs/remotes/origin/*"],
    ],
  ])(
    "diagnoses %s without invoking a mutating Git command",
    async (_name, state, conflictingFetchRefspecs) => {
      const inspect = await loadInspector();
      const { calls, runGit } = createFakeGit(state);

      await expect(inspect("/workspace", runGit)).resolves.toEqual({
        conflictingFetchRefspecs,
        expectedRemoteTrackingRef: "refs/remotes/origin/main",
        kind: "missing-fetch-mapping",
        localBranch: "main",
        mergeRef: "refs/heads/main",
        remote: "origin",
        remoteBranch: "main",
      });
      expect(calls.some((args) => args[0] === "fetch")).toBe(false);
      expect(calls.every((args) => args[0] !== "config" || args[1]?.startsWith("--get"))).toBe(
        true,
      );
    },
  );
});
