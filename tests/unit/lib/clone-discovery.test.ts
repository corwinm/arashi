import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Config } from "../../../src/lib/config.ts";
import {
  applyCloneProtocol,
  discoverCloneRepositories,
  inferCloneProtocolPreference,
} from "../../../src/lib/clone-discovery.ts";

describe("clone-discovery", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "arashi-clone-discovery-"));
    await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("classifies configured present and missing repositories", async () => {
    await mkdir(join(workspaceRoot, "repos", "repo-a"), { recursive: true });

    const config: Config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "repo-a": { path: "./repos/repo-a", git_url: "git@github.com:team/repo-a.git" },
        "repo-b": { path: "./repos/repo-b", git_url: "git@github.com:team/repo-b.git" },
      },
    };

    const result = await discoverCloneRepositories(workspaceRoot, config);

    expect(result.configuredPresent.map((repo) => repo.name)).toEqual(["repo-a"]);
    expect(result.configuredMissing.map((repo) => repo.name)).toEqual(["repo-b"]);
  });

  test("detects unmanaged local repositories under repos_dir", async () => {
    const unmanagedPath = join(workspaceRoot, "repos", "extra-repo");
    await mkdir(unmanagedPath, { recursive: true });
    await writeFile(join(unmanagedPath, ".git"), "gitdir: ./.git/worktrees/main\n");

    const config: Config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {},
    };

    const result = await discoverCloneRepositories(workspaceRoot, config);
    expect(result.unmanagedLocal.map((repo) => repo.name)).toEqual(["extra-repo"]);
  });
});

describe("inferCloneProtocolPreference", () => {
  test("infers ssh when all URLs are ssh", () => {
    const result = inferCloneProtocolPreference([
      "git@github.com:team/repo-a.git",
      "ssh://git@github.com/team/repo-b.git",
    ]);
    expect(result.protocol).toBe("ssh");
    expect(result.reason).toBe("inferred-ssh");
  });

  test("infers https when all URLs are https", () => {
    const result = inferCloneProtocolPreference([
      "https://github.com/team/repo-a.git",
      "https://github.com/team/repo-b.git",
    ]);
    expect(result.protocol).toBe("https");
    expect(result.reason).toBe("inferred-https");
  });

  test("reports mixed when protocols are mixed", () => {
    const result = inferCloneProtocolPreference([
      "https://github.com/team/repo-a.git",
      "git@github.com:team/repo-b.git",
    ]);
    expect(result.protocol).toBeNull();
    expect(result.reason).toBe("mixed");
  });
});

describe("applyCloneProtocol", () => {
  test("converts ssh URL to https", () => {
    expect(applyCloneProtocol("git@github.com:team/repo-a.git", "https")).toBe(
      "https://github.com/team/repo-a.git",
    );
  });

  test("converts https URL to ssh", () => {
    expect(applyCloneProtocol("https://github.com/team/repo-a.git", "ssh")).toBe(
      "git@github.com:team/repo-a.git",
    );
  });
});
