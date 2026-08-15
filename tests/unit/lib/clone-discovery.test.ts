import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyCloneProtocol,
  discoverCloneRepositories,
  inferCloneProtocolPreference,
} from "../../../src/lib/clone-discovery.ts";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import type { Config } from "../../../src/lib/config.ts";
import { join } from "path";
import { tmpdir } from "os";

describe("clone-discovery", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "arashi-clone-discovery-"));
    await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { force: true, recursive: true });
  });

  test("classifies configured present and missing repositories", async () => {
    await mkdir(join(workspaceRoot, "repos", "repo-a"), { recursive: true });

    const config: Config = {
      repos: {
        "repo-a": { gitUrl: "git@github.com:team/repo-a.git", path: "./repos/repo-a" },
        "repo-b": { gitUrl: "git@github.com:team/repo-b.git", path: "./repos/repo-b" },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const result = await discoverCloneRepositories(workspaceRoot, config);

    expect(result.configuredPresent.map((repo) => repo.name)).toEqual(["repo-a"]);
    expect(result.configuredMissing.map((repo) => repo.name)).toEqual(["repo-b"]);
  });

  test("detects unmanaged local repositories under reposDir", async () => {
    const unmanagedPath = join(workspaceRoot, "repos", "extra-repo");
    await mkdir(unmanagedPath, { recursive: true });
    await writeFile(join(unmanagedPath, ".git"), "gitdir: ./.git/worktrees/main\n");

    const config: Config = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };

    const result = await discoverCloneRepositories(workspaceRoot, config);
    expect(result.unmanagedLocal.map((repo) => repo.name)).toEqual(["extra-repo"]);
  });
});

describe("inferCloneProtocolPreference", () => {
  test("infers ssh from omitted-user SCP aliases", () => {
    expect(
      inferCloneProtocolPreference([
        "work-github:repo-a.git",
        "work-github:team/repo-b.git",
        "ssh://work-github/team/repo-c.git",
      ]),
    ).toEqual({ protocol: "ssh", reason: "inferred-ssh" });
  });

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

  test("ignores file and git URI schemes when inferring an HTTPS preference", () => {
    expect(
      inferCloneProtocolPreference([
        "https://github.com/team/repo-a.git",
        "file:///tmp/repo-b.git",
        "git://example.com/team/repo-c.git",
      ]),
    ).toEqual({ protocol: "https", reason: "inferred-https" });
  });

  test("reports no preference for only non-convertible URI schemes", () => {
    expect(
      inferCloneProtocolPreference(["file:///tmp/repo-a.git", "git://example.com/team/repo-b.git"]),
    ).toEqual({ protocol: null, reason: "none" });
  });
});

describe("applyCloneProtocol", () => {
  test.each([
    "git@work-github:team/repo-a.git",
    "work-github:team/repo-a.git",
    "ssh://deploy@work-github/team/repo-a.git",
  ])("never converts SSH source %s to HTTPS", (url) => {
    expect(applyCloneProtocol(url, "https")).toBe(url);
  });

  test("preserves already-selected SSH bytes exactly", () => {
    const url = "  ssh://deploy@work-github/team/repo-a.git  ";
    expect(applyCloneProtocol(url, "ssh")).toBe(url);
  });

  test("preserves already-selected HTTPS bytes exactly", () => {
    const url = "  https://github.com/team/repo-a.git  ";
    expect(applyCloneProtocol(url, "https")).toBe(url);
  });

  test("converts https URL to ssh", () => {
    expect(applyCloneProtocol("https://github.com/team/repo-a.git", "ssh")).toBe(
      "git@github.com:team/repo-a.git",
    );
  });
});
