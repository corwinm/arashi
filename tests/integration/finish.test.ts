import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile, realpath, symlink } from "fs/promises";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  assessFinish,
  runFinishRemoval,
  previewFinishPlan,
  confirmUnknownCompletion,
  correlateGithub,
  discoverFinishRoot,
  finishHookPath,
  contextualFinishCandidates,
  validManualRemote,
  projectFinishReport,
} from "../../src/commands/finish.ts";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
async function fixture(base = true, childName = "child") {
  const root = await mkdtemp(join(tmpdir(), "arashi-finish-"));
  roots.push(root);
  const main = join(root, "main");
  const child = join(main, "repos", childName);
  await mkdir(child, { recursive: true });
  for (const path of [main, child]) {
    git(path, "init", "-b", "main");
    git(path, "config", "user.name", "Test");
    git(path, "config", "user.email", "test@example.com");
    git(path, "config", "commit.gpgSign", "false");
    await writeFile(join(path, "README.md"), "initial\n");
    git(path, "add", ".");
    git(path, "commit", "-m", "initial");
    git(path, "remote", "add", "origin", path);
  }
  await mkdir(join(main, ".arashi"));
  await writeFile(
    join(main, ".arashi", "config.json"),
    JSON.stringify({
      version: "1.0.0",
      reposDir: "repos",
      ...(base ? { baseBranch: "main" } : {}),
      repos: { [childName]: { path: `repos/${childName}` } },
    }),
  );
  const parent = join(root, "workspace");
  git(main, "worktree", "add", "-b", "feature", parent);
  const nested = join(parent, "repos", childName);
  await mkdir(join(parent, "repos"), { recursive: true });
  git(child, "worktree", "add", "-b", "other", nested);
  return { root, main, child, parent, nested };
}
async function nestedFixture() {
  const f = await fixture();
  const inner = join(f.child, "repos", "inner");
  await mkdir(inner, { recursive: true });
  git(inner, "init", "-b", "main");
  git(inner, "config", "user.name", "Test");
  git(inner, "config", "user.email", "test@example.com");
  await writeFile(join(inner, "README.md"), "initial\n");
  git(inner, "add", ".");
  git(inner, "commit", "-m", "initial");
  git(inner, "remote", "add", "origin", inner);
  const configPath = join(f.main, ".arashi", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.repos.inner = { path: "repos/child/repos/inner" };
  await writeFile(configPath, JSON.stringify(config));
  const deepest = join(f.nested, "repos", "inner");
  await mkdir(join(f.nested, "repos"), { recursive: true });
  git(inner, "worktree", "add", "-b", "deep", deepest);
  return { ...f, inner, deepest };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("finish assessment with real Git repositories", () => {
  it("renders a screened human dry-run assessment and ordered cleanup plan", async () => {
    const f = await fixture();
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--dry-run"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Finish assessment: workspace");
    expect(proc.stdout).toContain("Readiness: ready");
    expect(proc.stdout).toContain("Repositories:");
    expect(proc.stdout).toContain("Cleanup plan:");
    expect(proc.stdout.indexOf("child: worktree_remove")).toBeLessThan(
      proc.stdout.indexOf("main: worktree_remove"),
    );
    expect(() => JSON.parse(proc.stdout)).toThrow();
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });

  it.skipIf(process.platform === "win32")(
    "shows the full screened plan before manual completion consent and retains files on decline",
    async () => {
      const f = await fixture();
      const configPath = join(f.main, ".arashi", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.baseBranch = "missing";
      await writeFile(configPath, JSON.stringify(config));
      const proc = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "../helpers/pty-command.mjs"),
          f.main,
          "Manually confirm completion for ALL",
          "n",
          "20",
          JSON.stringify([
            "bun",
            join(import.meta.dirname, "../../src/index.ts"),
            "finish",
            f.parent,
            "--force",
          ]),
        ],
        { encoding: "utf8", timeout: 25_000 },
      );
      expect(proc.status, proc.stderr).toBe(2);
      expect(proc.stdout.indexOf("Finish assessment: workspace")).toBeGreaterThanOrEqual(0);
      expect(proc.stdout.indexOf("Cleanup plan:")).toBeLessThan(
        proc.stdout.indexOf("Manually confirm completion for ALL"),
      );
      expect(proc.stdout).toContain("FRESH_EVIDENCE_UNAVAILABLE");
      expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
      expect(git(f.child, "worktree", "list", "--porcelain")).toContain(f.nested);
    },
  );

  it("renders a human success without changing JSON envelope behavior", async () => {
    const f = await fixture();
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Cleanup result:");
    expect(proc.stdout).toContain("worktree_remove success");
    expect(() => JSON.parse(proc.stdout)).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "shows assessment and exact plan before discard consent and retains files on decline",
    async () => {
      const f = await fixture();
      const proc = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "../helpers/pty-command.mjs"),
          f.main,
          "Discard dirty or unpublished changes",
          "n",
          "20",
          JSON.stringify([
            "bun",
            join(import.meta.dirname, "../../src/index.ts"),
            "finish",
            f.parent,
          ]),
        ],
        { encoding: "utf8", timeout: 25_000 },
      );
      expect(proc.status, proc.stderr).toBe(2);
      expect(proc.stdout.indexOf("Cleanup plan:")).toBeLessThan(
        proc.stdout.indexOf("Discard dirty or unpublished changes"),
      );
      expect(proc.stdout).toContain("child: worktree_remove repos/child other");
      expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
      expect(git(f.child, "worktree", "list", "--porcelain")).toContain(f.nested);
    },
  );
  it("selects a registered parent from its child, inventories a differently named child and never writes the managed index or refs", async () => {
    const f = await fixture();
    const beforeIndex = await readFile(join(f.parent, ".git"));
    const beforeRef = git(f.main, "rev-parse", "feature");
    const report = await assessFinish(f.parent, f.nested);
    expect(report.repositories.map((r) => r.repository)).toEqual(["main", "child"]);
    expect(report.repositories[1].branch).toBe("other");
    expect(report.repositories[0].dirtyDetails).toEqual({
      staged: false,
      unstaged: false,
      untracked: true,
    });
    expect(report.repositories[0].integration).toBe("proven");
    expect(report.repositories[0].integrationEvidence).toEqual({
      source: "git-ancestry",
      fresh: true,
      correlation: "not-attempted",
    });
    expect(
      report.cleanupPlan?.operations
        .filter((o) => o.type === "worktree_remove")
        .map((o) => o.repository),
    ).toEqual(["child", "main"]);
    expect(await readFile(join(f.parent, ".git"))).toEqual(beforeIndex);
    expect(git(f.main, "rev-parse", "feature")).toBe(beforeRef);
  });
  it("does not infer a default target or treat force as integration proof", async () => {
    const f = await fixture(false);
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[0].base.source).toBe("omitted");
    expect(report.repositories[0].integration).toBe("unknown");
    expect(report.readiness).toBe("unknown");
  });
  it("refuses an unregistered present descendant rather than projecting parent removal", async () => {
    const f = await fixture();
    git(f.child, "worktree", "remove", f.nested);
    await mkdir(f.nested, { recursive: true });
    const report = await assessFinish(f.parent, f.main);
    expect(report.readiness).toBe("blocked");
    expect(report.cleanupPlan).toBeNull();
  });
  it("never migrates configuration during preview", async () => {
    const f = await fixture();
    const path = join(f.main, ".arashi", "config.json");
    const legacy = (await readFile(path, "utf8")).replace('"1.0.0"', '"1"');
    await writeFile(path, legacy);
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--dry-run", "--json"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(legacy);
  });
  it("reports upstream OID and divergence from fresh remote rather than a stale tracking ref", async () => {
    const f = await fixture();
    git(f.main, "fetch", "origin", "main");
    git(f.main, "branch", "--set-upstream-to=origin/main", "feature");
    git(f.main, "commit", "--allow-empty", "-m", "base advanced");
    const fresh = git(f.main, "rev-parse", "main");
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[0].upstream).toEqual({ oid: fresh, ahead: 0, behind: 1 });
  });
  it("does not use a stale tracking ref as integration proof when fresh base fetch fails", async () => {
    const f = await fixture();
    git(f.main, "fetch", "origin", "main");
    git(f.main, "remote", "set-url", "origin", join(f.root, "unreachable"));
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[0].integration).toBe("unknown");
    expect(report.repositories[0].base.oid).toBeNull();
    expect(report.repositories[0].reasons).toContain("FRESH_EVIDENCE_UNAVAILABLE");
  });
  it("uses repository base policy over workspace policy without claiming historical creation intent", async () => {
    const f = await fixture();
    git(f.child, "branch", "release");
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.repos.child.baseBranch = "release";
    await writeFile(configPath, JSON.stringify(config));
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories.map((entry) => entry.base)).toMatchObject([
      { source: "workspace-config", ref: "refs/heads/main" },
      { source: "repository-config", ref: "refs/heads/release" },
    ]);
    expect(report.repositories[1].integration).toBe("proven");
  });
  it("keeps a locally ahead non-ancestor HEAD unknown while reporting fresh upstream counts", async () => {
    const f = await fixture();
    git(f.main, "fetch", "origin", "main");
    git(f.main, "branch", "--set-upstream-to=origin/main", "feature");
    git(f.parent, "commit", "--allow-empty", "-m", "feature ahead");
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[0].integration).toBe("unknown");
    expect(report.repositories[0].upstream).toMatchObject({ ahead: 1, behind: 0 });
    expect(report.repositories[0].reasons).toContain("DISCARD_REQUIRED");
  });
  it("cleans private fetch repositories after a failed remote refresh", async () => {
    const f = await fixture();
    const temporary = join(f.root, "temporary");
    await mkdir(temporary);
    git(f.main, "remote", "set-url", "origin", join(f.root, "missing-remote"));
    const result = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--dry-run", "--json"],
      { cwd: f.main, encoding: "utf8", env: { ...process.env, TMPDIR: temporary } },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.repositories[0].integration).toBe("unknown");
    expect(
      (await readdir(temporary)).filter((entry) => entry.startsWith("arashi-finish-")),
    ).toEqual([]);
  });
  it("aborts when a successful pre-remove hook changes configuration and retains hook outcomes", async () => {
    const f = await fixture();
    const configuration = join(f.main, ".arashi", "config.json");
    const data = JSON.parse(await readFile(configuration, "utf8"));
    data.hooks = {
      scripts: {
        "pre-remove": `node -e 'const fs=require("fs"); const p=${JSON.stringify(configuration)}; const c=JSON.parse(fs.readFileSync(p,"utf8")); c.baseBranch="other"; fs.writeFileSync(p,JSON.stringify(c))'`,
      },
    };
    await writeFile(configuration, JSON.stringify(data));
    const report = await assessFinish(f.parent, f.main);
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 1, invalidated: true });
    expect(
      outcome.result?.hookOutcomes.some(
        (h) => h.hookName === "pre-remove" && h.hookStatus === "success",
      ),
    ).toBe(true);
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("rejects hook configuration changes after assessment before running any hook", async () => {
    const f = await fixture();
    const report = await assessFinish(f.parent, f.main);
    const path = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.hooks = { scripts: { "pre-remove": `touch '${join(f.root, "hook-ran")}'` } };
    await writeFile(path, JSON.stringify(config));
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 1, invalidated: true });
    await expect(readFile(join(f.root, "hook-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("invalidates a HEAD change after assessment before worktree removal", async () => {
    const f = await fixture();
    const report = await assessFinish(f.parent, f.main);
    git(f.parent, "commit", "--allow-empty", "-m", "changed after assessment");
    const result = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(result).toMatchObject({ code: 1, invalidated: true });
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("hands the exact descendant-first plan to ordinary remove", async () => {
    const f = await fixture();
    const report = await assessFinish(f.parent, f.main);
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 0, invalidated: false });
    expect(
      outcome.result?.operations
        .filter((o) => o.type === "worktree_remove")
        .map((o) => o.repository),
    ).toEqual(["child", "main"]);
  });
  it("keeps sibling order identical to remove in preview and execution", async () => {
    const f = await fixture();
    const sibling = join(f.main, "repos", "sibling");
    await mkdir(sibling);
    git(sibling, "init", "-b", "main");
    git(sibling, "config", "user.name", "Test");
    git(sibling, "config", "user.email", "test@example.com");
    git(sibling, "config", "commit.gpgSign", "false");
    await writeFile(join(sibling, "README.md"), "initial\n");
    git(sibling, "add", ".");
    git(sibling, "commit", "-m", "initial");
    git(sibling, "remote", "add", "origin", sibling);
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.repos.sibling = { path: "repos/sibling" };
    await writeFile(configPath, JSON.stringify(config));
    const nested = join(f.parent, "repos", "sibling");
    git(sibling, "worktree", "add", "-b", "other-sibling", nested);
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    expect(
      report.cleanupPlan?.operations
        .filter((o) => o.type === "worktree_remove")
        .map((o) => o.repository),
    ).toEqual(["child", "sibling", "main"]);
    await previewFinishPlan(report, f.parent, {});
    expect(report.readiness).toBe("ready");
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 0, invalidated: false });
    expect(
      outcome.result?.operations
        .filter((o) => o.type === "worktree_remove")
        .map((o) => o.repository),
    ).toEqual(["child", "sibling", "main"]);
  });
  it("matches remove's exact nested worktree and distinct branch order", async () => {
    const f = await nestedFixture();
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    await previewFinishPlan(report, f.parent, {});
    expect(report.readiness).toBe("ready");
    expect(
      report.cleanupPlan?.operations.map(
        (operation) => `${operation.type}:${operation.repository}`,
      ),
    ).toEqual([
      "worktree_remove:inner",
      "worktree_remove:child",
      "worktree_remove:main",
      "branch_delete:main",
      "branch_delete:inner",
      "branch_delete:child",
    ]);
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 0, invalidated: false });
    expect(
      outcome.result?.operations.map((operation) => `${operation.type}:${operation.repository}`),
    ).toEqual(
      report.cleanupPlan?.operations.map(
        (operation) => `${operation.type}:${operation.repository}`,
      ),
    );
  });
  it("reports an absent configured child without adding it to cleanup", async () => {
    const f = await fixture();
    git(f.child, "worktree", "remove", f.nested);
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    expect(report.nonparticipants).toEqual(["child"]);
    expect(report.repositories.map((entry) => entry.repository)).toEqual(["main"]);
    await previewFinishPlan(report, f.parent, {});
    expect(report.cleanupPlan?.operations.map((entry) => entry.repository)).toEqual([
      "main",
      "main",
    ]);
  });
  it("rejects detached and main targets without deleting worktrees", async () => {
    const f = await fixture();
    git(f.parent, "checkout", "--detach");
    await expect(assessFinish(f.parent, f.main)).rejects.toThrow("TARGET_NOT_REGISTERED");
    const cli = join(import.meta.dirname, "../../src/index.ts");
    const mainTarget = spawnSync("bun", [cli, "finish", f.main, "--json", "--force"], {
      cwd: f.main,
      encoding: "utf8",
    });
    expect(mainTarget.status).toBe(2);
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it.skipIf(process.platform === "win32")(
    "selects one target through a real PTY picker for preview",
    async () => {
      const f = await fixture();
      const helper = join(import.meta.dirname, "../helpers/pty-command.mjs");
      const cli = join(import.meta.dirname, "../../src/index.ts");
      const chosen = spawnSync(
        process.execPath,
        [
          helper,
          f.main,
          "Choose coordinated workspace",
          "",
          "20",
          JSON.stringify(["bun", cli, "finish", "--dry-run"]),
        ],
        { encoding: "utf8", timeout: 25_000 },
      );
      expect(chosen.status, chosen.stderr).toBe(0);
      expect(chosen.stdout).toContain("Finish assessment: workspace");
      expect(chosen.stdout).not.toContain("Manually confirm completion");
      expect(chosen.stdout).not.toContain("Discard dirty");
      expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
    },
  );
  it.skipIf(process.platform === "win32")(
    "leaves branches and worktrees intact when real PTY manual consent is declined",
    async () => {
      const f = await fixture();
      const configPath = join(f.main, ".arashi", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.baseBranch = "missing";
      await writeFile(configPath, JSON.stringify(config));
      const before = [git(f.main, "show-ref"), git(f.child, "show-ref")];
      const helper = join(import.meta.dirname, "../helpers/pty-command.mjs");
      const cli = join(import.meta.dirname, "../../src/index.ts");
      const declined = spawnSync(
        process.execPath,
        [
          helper,
          f.main,
          "Manually confirm completion for ALL",
          "n",
          "20",
          JSON.stringify(["bun", cli, "finish", f.parent, "--force"]),
        ],
        { encoding: "utf8", timeout: 25_000 },
      );
      expect(declined.status, declined.stderr).toBe(2);
      expect(declined.stdout).not.toContain("Cleanup result:");
      expect([git(f.main, "show-ref"), git(f.child, "show-ref")]).toEqual(before);
      expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
      expect(git(f.child, "worktree", "list", "--porcelain")).toContain(f.nested);
    },
  );
  it("blocks a configured clean filter before status can execute it during preview", async () => {
    const f = await fixture();
    const marker = join(f.root, "filter-ran");
    git(f.child, "config", "filter.canary.clean", `sh -c 'touch "${marker}"; cat'`);
    await writeFile(join(f.nested, ".gitattributes"), "README.md filter=canary\n");
    await writeFile(join(f.nested, "README.md"), "modified\n");
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    await previewFinishPlan(report, f.parent, {});
    expect(report.readiness).toBe("blocked");
    expect(report.cleanupPlan).toBeNull();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("allows unrelated global filters without running them or changing managed state", async () => {
    const f = await fixture();
    const marker = join(f.root, "filter-ran");
    const globalConfig = join(f.root, "global-gitconfig");
    await writeFile(globalConfig, `[filter "canary"]\n\tclean = sh -c 'touch "${marker}"; cat'\n`);
    const index = join(git(f.nested, "rev-parse", "--absolute-git-dir"), "index");
    const beforeIndex = await readFile(index);
    const beforeRef = git(f.child, "rev-parse", "other");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      const report = await assessFinish(f.parent, f.main, { dryRun: true });
      await previewFinishPlan(report, f.parent, {});
      expect(report.readiness).toBe("ready");
      expect(report.cleanupPlan).not.toBeNull();
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(index)).toEqual(beforeIndex);
      expect(git(f.child, "rev-parse", "other")).toBe(beforeRef);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
  it("rejects applicable global process filters before preview without executing them", async () => {
    const f = await fixture();
    const marker = join(f.root, "filter-ran");
    const globalConfig = join(f.root, "global-gitconfig");
    await writeFile(join(f.nested, ".gitattributes"), "README.md filter=canary\n");
    await writeFile(join(f.nested, "README.md"), "modified\n");
    await writeFile(
      globalConfig,
      `[filter "canary"]\n\tprocess = sh -c 'touch "${marker}"; cat'\n`,
    );
    const previous = process.env.GIT_CONFIG_GLOBAL;
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      const report = await assessFinish(f.parent, f.main, { dryRun: true });
      expect(report.readiness).toBe("blocked");
      expect(report.blockers).toContain("EXECUTABLE_FILTER_UNSAFE");
      await previewFinishPlan(report, f.parent, {});
      expect(report.cleanupPlan).toBeNull();
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
  it("blocks a global attribute applying an executable filter to a tracked path", async () => {
    const f = await fixture();
    const marker = join(f.root, "filter-ran");
    const attributes = join(f.root, "global-attributes");
    await writeFile(attributes, "README.md filter=canary\n");
    git(f.nested, "config", "core.attributesFile", attributes);
    git(f.nested, "config", "filter.canary.clean", `sh -c 'touch "${marker}"; cat'`);
    await writeFile(join(f.nested, "README.md"), "modified\n");
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    expect(report.blockers).toContain("EXECUTABLE_FILTER_UNSAFE");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("blocks an executable filter on a relevant untracked path", async () => {
    const f = await fixture();
    const marker = join(f.root, "filter-ran");
    git(f.nested, "config", "filter.canary.clean", `sh -c 'touch "${marker}"; cat'`);
    await writeFile(join(f.nested, ".gitattributes"), "new.txt filter=canary\n");
    await writeFile(join(f.nested, "new.txt"), "new\n");
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    expect(report.blockers).toContain("EXECUTABLE_FILTER_UNSAFE");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects filters added after assessment before the remove preview", async () => {
    const f = await fixture();
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    git(f.child, "config", "extensions.worktreeConfig", "true");
    git(f.nested, "config", "--worktree", "filter.canary.clean", "cat");
    await writeFile(join(f.nested, ".gitattributes"), "README.md filter=canary\n");
    await previewFinishPlan(report, f.parent, {});
    expect(report.readiness).toBe("blocked");
    expect(report.cleanupPlan).toBeNull();
    expect(git(f.child, "worktree", "list", "--porcelain")).toContain(f.nested);
  });
  it("retains branches when keep-branches is requested without weakening exact scope", async () => {
    const f = await fixture();
    const report = await assessFinish(f.parent, f.main, { keepBranches: true });
    const outcome = await runFinishRemoval(
      report,
      f.parent,
      { force: true, keepBranches: true },
      f.main,
    );
    expect(outcome).toMatchObject({ code: 0, invalidated: false });
    expect(git(f.main, "branch", "--list", "feature")).toContain("feature");
  });
  it("rejects a successful pre-remove hook that changes HEAD before any detach", async () => {
    const f = await fixture();
    const configuration = join(f.main, ".arashi", "config.json");
    const data = JSON.parse(await readFile(configuration, "utf8"));
    data.hooks = {
      scripts: { "pre-remove": `git -C '${f.parent}' commit --allow-empty -m changed` },
    };
    await writeFile(configuration, JSON.stringify(data));
    const report = await assessFinish(f.parent, f.main);
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 1, invalidated: true });
    expect(
      outcome.result?.hookOutcomes.some(
        (hook) => hook.hookName === "pre-remove" && hook.hookStatus === "success",
      ),
    ).toBe(true);
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
    expect(git(f.child, "worktree", "list", "--porcelain")).toContain(f.nested);
  });
  it("executes a proven, force-authorized JSON finish with a single safe envelope", async () => {
    const f = await fixture();
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    const envelope = JSON.parse(proc.stdout);
    expect(envelope).toMatchObject({ ok: true, command: "finish", schemaVersion: 1 });
    expect(
      envelope.data.cleanupResult.operations
        .filter((o: { type: string }) => o.type === "worktree_remove")
        .map((o: { repository: string }) => o.repository),
    ).toEqual(["child", "main"]);
    expect(git(f.main, "branch", "--list", "feature")).toBe("");
  });
  it("finishes from the selected parent without failing after its directory is removed", async () => {
    const f = await fixture();
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
      { cwd: f.parent, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout)).toMatchObject({ ok: true, command: "finish" });
  });
  it("requires an explicit target in JSON mode without selecting a parent implicitly", async () => {
    const f = await fixture();
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", "--json", "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(2);
    expect(JSON.parse(proc.stdout).error.code).toBe("TARGET_REQUIRED");
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("rejects an ambiguous branch fragment across siblings", async () => {
    const f = await fixture();
    const second = join(f.root, "workspace2");
    git(f.main, "worktree", "add", "-b", "feature-two", second);
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", "feat", "--dry-run", "--json"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(2);
    expect(JSON.parse(proc.stdout).error.code).toBe("TARGET_AMBIGUOUS");
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(second);
  });
  it("never treats force as proof when current configured base is omitted", async () => {
    const f = await fixture(false);
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(2);
    const envelope = JSON.parse(proc.stdout);
    expect(envelope.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("preserves leading porcelain columns for unstaged changes", async () => {
    const f = await fixture();
    await writeFile(join(f.nested, "README.md"), "modified\n");
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[1].dirtyDetails).toEqual({
      staged: false,
      unstaged: true,
      untracked: false,
    });
  });
  it("retains configured repository keys internally but redacts unsafe keys in JSON", async () => {
    const f = await fixture();
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.repos["child+api"] = config.repos.child;
    delete config.repos.child;
    await writeFile(configPath, JSON.stringify(config));
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[1].repository).toBe("child+api");
    await previewFinishPlan(report, f.parent, {});
    expect(report.readiness).toBe("ready");
    expect(report.cleanupPlan?.operations[0].repository).toBe("child+api");
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).not.toContain("child+api");
    expect(JSON.parse(proc.stdout).data.repositories[1].repository).toBe("[redacted]");
  });
  it("requires discard consent for ignored local data and detects it as dirty", async () => {
    const f = await fixture();
    await writeFile(join(f.nested, ".gitignore"), ".env\n");
    git(f.nested, "add", ".gitignore");
    git(f.nested, "commit", "-m", "ignore env");
    git(f.child, "merge", "other");
    await writeFile(join(f.nested, ".env"), "SECRET_FINISH_CANARY\n");
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[1].dirty).toBe(true);
    expect(report.repositories[1].dirtyDetails?.untracked).toBe(true);
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(2);
    expect(JSON.parse(proc.stdout).error.code).toBe("DISCARD_CONFIRMATION_REQUIRED");
    expect(await readFile(join(f.nested, ".env"), "utf8")).toContain("SECRET_FINISH_CANARY");
  });
  it.skipIf(process.platform !== "win32")(
    "accepts mixed-case physical registrations on Windows",
    async () => {
      const f = await fixture();
      const report = await assessFinish(f.parent.toUpperCase(), f.parent.toUpperCase());
      expect(report.readiness).toBe("ready");
      expect(report.repositories.map((r) => r.repository)).toEqual(["main", "child"]);
      const proc = spawnSync(
        "bun",
        [
          join(import.meta.dirname, "../../src/index.ts"),
          "finish",
          f.parent,
          "--dry-run",
          "--json",
        ],
        { cwd: f.main, encoding: "utf8" },
      );
      expect(proc.status).toBe(0);
      expect(JSON.parse(proc.stdout).data.target).toBe("workspace");
    },
  );
  it("preserves interactive hook stdin while keeping the delegated remove quiet", async () => {
    const f = await fixture();
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.hooks = {
      scripts: {
        "pre-remove": `node -e 'const fs=require("fs");fs.writeFileSync(${JSON.stringify(join(f.root, "hook-input"))}, process.env.ARASHI_HOOK_INPUT)'`,
      },
    };
    await writeFile(configPath, JSON.stringify(config));
    const script = `process.stdin.isTTY = true; const { assessFinish, runFinishRemoval } = await import(${JSON.stringify(join(import.meta.dirname, "../../src/commands/finish.ts"))}); const r = await assessFinish(${JSON.stringify(f.parent)}, ${JSON.stringify(f.main)}); console.log(JSON.stringify(await runFinishRemoval(r, ${JSON.stringify(f.parent)}, { force: true }, ${JSON.stringify(f.main)})));`;
    const proc = spawnSync("bun", ["-e", script], { cwd: f.main, encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout)).toMatchObject({ code: 0, invalidated: false });
    expect(await readFile(join(f.root, "hook-input"), "utf8")).toBe("tty");
  });
  it("keeps valid plus-sign branch names for the remove plan but redacts output", async () => {
    const f = await fixture();
    git(f.main, "branch", "-m", "feature", "feature+api");
    git(f.child, "branch", "-m", "other", "other+api");
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories.map((r) => r.branch)).toEqual(["feature+api", "other+api"]);
    await previewFinishPlan(report, f.parent, {});
    expect(report.readiness).toBe("ready");
    const proc = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).not.toContain("feature+api");
    expect(proc.stdout).not.toContain("other+api");
  });
  it("screens base refs and worktree paths in preview, confirmation, and success output", async () => {
    const f = await fixture(true, "child+PATH_CANARY");
    for (const source of [f.main, f.child]) git(source, "branch", "main+BASE_CANARY");
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.baseBranch = "main+BASE_CANARY";
    await writeFile(configPath, JSON.stringify(config));
    const cli = join(import.meta.dirname, "../../src/index.ts");
    const human = spawnSync("bun", [cli, "finish", f.parent, "--dry-run"], {
      cwd: f.main,
      encoding: "utf8",
    });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("Cleanup plan:");
    expect(human.stdout).not.toContain("BASE_CANARY");
    expect(human.stdout).not.toContain("PATH_CANARY");
    const preview = spawnSync("bun", [cli, "finish", f.parent, "--dry-run", "--json"], {
      cwd: f.main,
      encoding: "utf8",
    });
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).data.repositories[0].integration).toBe("proven");
    expect(preview.stdout).not.toContain("BASE_CANARY");
    expect(preview.stdout).not.toContain("PATH_CANARY");
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[0].base.ref).toBe("refs/heads/main+BASE_CANARY");
    expect(report.repositories[1].path).toBe("repos/child+PATH_CANARY");
    const success = spawnSync("bun", [cli, "finish", f.parent, "--json", "--force"], {
      cwd: f.main,
      encoding: "utf8",
    });
    expect(success.status).toBe(0);
    expect(JSON.parse(success.stdout).data.cleanupResult.operations.length).toBeGreaterThan(0);
    expect(success.stdout).not.toContain("BASE_CANARY");
    expect(success.stdout).not.toContain("PATH_CANARY");
  });
  it("screens a named base ref in manual confirmation and failure output", async () => {
    const f = await fixture(false);
    const report = await assessFinish(f.parent, f.main, {
      manualTargets: { main: { remote: "origin", ref: "refs/heads/missing+BASE_CANARY" } },
    });
    let prompt = "";
    await confirmUnknownCompletion(report, async (message) => {
      prompt = message;
      return { status: "declined" };
    });
    expect(prompt).not.toContain("BASE_CANARY");
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.baseBranch = "missing+BASE_CANARY";
    await writeFile(configPath, JSON.stringify(config));
    const failed = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(failed.status).toBe(2);
    expect(JSON.parse(failed.stdout).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(failed.stdout).not.toContain("BASE_CANARY");
  });
  it("uses EOF for hooks in JSON mode even if the caller has a TTY", async () => {
    const f = await fixture();
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.hooks = {
      scripts: {
        "pre-remove": `node -e 'require("fs").writeFileSync(${JSON.stringify(join(f.root, "json-hook-input"))}, process.env.ARASHI_HOOK_INPUT)'`,
      },
    };
    await writeFile(configPath, JSON.stringify(config));
    const script = `process.stdin.isTTY = true; const { createCommand } = await import(${JSON.stringify(join(import.meta.dirname, "../../src/commands/finish.ts"))}); await createCommand().parseAsync([${JSON.stringify(f.parent)}, '--json', '--force'], {from:'user'});`;
    const proc = spawnSync("bun", ["-e", script], { cwd: f.main, encoding: "utf8" });
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout).ok).toBe(true);
    expect(await readFile(join(f.root, "json-hook-input"), "utf8")).toBe("disabled");
  });
  it("accepts a tilde-prefixed explicit target as a home-relative path", async () => {
    const f = await fixture();
    const proc = spawnSync(
      "bun",
      [
        join(import.meta.dirname, "../../src/index.ts"),
        "finish",
        "~/workspace",
        "--dry-run",
        "--json",
      ],
      { cwd: f.main, encoding: "utf8", env: { ...process.env, HOME: f.root, USERPROFILE: f.root } },
    );
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout).data.target).toBe("workspace");
  });
  it("validates manual base refs with Git branch syntax", async () => {
    const { validManualBaseRef } = await import("../../src/commands/finish.ts");
    expect(validManualBaseRef("refs/heads/release+candidate")).toBe(true);
    expect(validManualBaseRef("refs/heads/feature/next")).toBe(true);
    expect(validManualBaseRef("refs/tags/release+candidate")).toBe(false);
    expect(validManualBaseRef("refs/heads/feature..bad")).toBe(false);
  });
  it("discovers a configured bare common directory from a linked parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-finish-bare-"));
    roots.push(root);
    const bare = join(root, "main.git");
    await mkdir(bare);
    git(bare, "init", "--bare", "-b", "main");
    const seed = join(root, "seed");
    git(root, "clone", bare, seed);
    git(seed, "config", "user.name", "Test");
    git(seed, "config", "user.email", "test@example.com");
    await writeFile(join(seed, "README.md"), "initial\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "initial");
    git(seed, "push", "origin", "main");
    await mkdir(join(bare, ".arashi"));
    await writeFile(
      join(bare, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0", reposDir: "repos", baseBranch: "main", repos: {} }),
    );
    const parent = join(root, "workspace");
    git(bare, "worktree", "add", "-b", "feature", parent, "main");
    expect(await realpath(await discoverFinishRoot(parent))).toBe(await realpath(bare));
    const report = await assessFinish(parent, parent);
    expect(report.repositories[0].branch).toBe("feature");
    await previewFinishPlan(report, parent, {});
    expect(report.readiness).toBe("unknown");
    expect(report.cleanupPlan).not.toBeNull();
  });
  it("compares hook paths with injected Windows separators and drive casing", () => {
    expect(finishHookPath("c:\\Work\\Tree", "win32")).toBe(finishHookPath("C:/Work/Tree", "win32"));
  });
  it("canonicalizes both sides of contextual selection on case-insensitive paths", () => {
    const entries = [{ path: "C:/Work/Feature" }, { path: "C:/Work/Other" }];
    expect(
      contextualFinishCandidates(entries, "C:/Work/Feature/repos/child", (path) =>
        path.toLowerCase(),
      ),
    ).toEqual([entries[0]]);
  });
  it("accepts an existing Git remote with punctuation without using output label rules", async () => {
    const f = await fixture(false);
    git(f.main, "remote", "add", "upstream+mirror/team@host", f.main);
    expect(await validManualRemote(f.main, "upstream+mirror/team@host")).toBe(true);
    expect(await validManualRemote(f.main, "upstream+mirror/team@missing")).toBe(false);
    expect(await validManualRemote(f.main, "-option")).toBe(false);
    const report = await assessFinish(f.parent, f.main, {
      manualTargets: { main: { remote: "upstream+mirror/team@host", ref: "refs/heads/main" } },
    });
    expect(report.repositories[0].base.remote).toBe("upstream+mirror/team@host");
    expect(projectFinishReport(report).repositories[0].base.remote).toBe("[redacted]");
  });
  it("prefers an exact ordinary relative target path before branch matching", async () => {
    const f = await fixture();
    await symlink(f.parent, join(f.main, "workspace"));
    const proc = spawnSync(
      "bun",
      [
        join(import.meta.dirname, "../../src/index.ts"),
        "finish",
        "workspace",
        "--dry-run",
        "--json",
      ],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout).data.target).toBe("workspace");
  });
  it("blocks an escaped missing child and a dangling symlink instead of omitting them", async () => {
    const f = await fixture();
    git(f.child, "worktree", "remove", f.nested);
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.repos.child.path = "../../outside";
    await writeFile(configPath, JSON.stringify(config));
    const escaped = await assessFinish(f.parent, f.main);
    expect(escaped.readiness).toBe("blocked");
    expect(escaped.nonparticipants).not.toContain("child");
    config.repos.child.path = "repos/child";
    await writeFile(configPath, JSON.stringify(config));
    await symlink(join(f.root, "missing"), f.nested);
    const dangling = await assessFinish(f.parent, f.main);
    expect(dangling.readiness).toBe("blocked");
    expect(dangling.nonparticipants).not.toContain("child");
  });
  it("blocks a missing canonical clone even if the child worktree is absent", async () => {
    const f = await fixture();
    git(f.child, "worktree", "remove", f.nested);
    await rm(f.child, { recursive: true, force: true });
    const report = await assessFinish(f.parent, f.main);
    expect(report.readiness).toBe("blocked");
    expect(report.nonparticipants).not.toContain("child");
  });
  it("resolves a slash-containing branch target instead of treating it as a path", async () => {
    const f = await fixture();
    git(f.main, "branch", "-m", "feature", "topic/feature");
    const proc = spawnSync(
      "bun",
      [
        join(import.meta.dirname, "../../src/index.ts"),
        "finish",
        "topic/feature",
        "--dry-run",
        "--json",
      ],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout).data.target).toBe("workspace");
  });
  it("invalidates a post-hook remote change before detach", async () => {
    const f = await fixture();
    const configuration = join(f.main, ".arashi", "config.json");
    const data = JSON.parse(await readFile(configuration, "utf8"));
    data.hooks = {
      scripts: { "pre-remove": `git -C '${f.main}' remote set-url origin '${f.child}'` },
    };
    await writeFile(configuration, JSON.stringify(data));
    const report = await assessFinish(f.parent, f.main);
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 1, invalidated: true });
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("invalidates a post-hook registration change before parent removal", async () => {
    const f = await fixture();
    const configuration = join(f.main, ".arashi", "config.json");
    const data = JSON.parse(await readFile(configuration, "utf8"));
    data.hooks = {
      scripts: {
        "pre-remove": `if [ -e '${join(f.nested, ".git")}' ]; then git -C '${f.child}' worktree remove --force '${f.nested}'; fi`,
      },
    };
    await writeFile(configuration, JSON.stringify(data));
    const report = await assessFinish(f.parent, f.main);
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome, JSON.stringify(outcome.result?.errors)).toMatchObject({
      code: 1,
      invalidated: true,
    });
    expect(
      outcome.result?.hookOutcomes.some(
        (entry) => entry.hookName === "pre-remove" && entry.hookStatus === "success",
      ),
      JSON.stringify(outcome),
    ).toBe(true);
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("projects a post-remove failure after mutation without leaking hook output", async () => {
    const f = await fixture();
    const configuration = join(f.main, ".arashi", "config.json");
    const data = JSON.parse(await readFile(configuration, "utf8"));
    data.hooks = {
      scripts: {
        "post-remove": `node -e 'process.stderr.write("HOOK_SECRET_CANARY"); process.exit(1)'`,
      },
    };
    await writeFile(configuration, JSON.stringify(data));
    const result = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe("REMOVE_FAILED");
    expect(
      envelope.error.details.cleanupResult.operations.some(
        (entry: { status: string }) => entry.status === "success",
      ),
    ).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("HOOK_SECRET_CANARY");
  });
  it.skipIf(process.platform === "win32")(
    "projects a real partial descendant removal without leaking a Git error",
    async () => {
      const f = await nestedFixture();
      const bin = join(f.root, "bin");
      await mkdir(bin);
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = remove ] && [ "$3" = '${f.nested}' ]; then echo GIT_SECRET_CANARY >&2; exit 1; fi\nexec '${realGit}' "$@"\n`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        "bun",
        [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--json", "--force"],
        {
          cwd: f.main,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      expect(result.status).toBe(1);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.code).toBe("REMOVE_FAILED");
      expect(envelope.error.details.cleanupResult.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            repository: "inner",
            type: "worktree_remove",
            status: "success",
          }),
          expect.objectContaining({
            repository: "child",
            type: "worktree_remove",
            status: "failed",
          }),
          expect.objectContaining({
            repository: "main",
            type: "worktree_remove",
            status: "failed",
          }),
        ]),
      );
      expect(result.stdout + result.stderr).not.toContain("GIT_SECRET_CANARY");
      expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
    },
  );
  it("asks once for all unknown repositories and retains each reason", async () => {
    const f = await fixture(false);
    const report = await assessFinish(f.parent, f.main, {
      manualTargets: {
        main: { remote: "origin", ref: "refs/heads/missing" },
        child: { remote: "origin", ref: "refs/heads/missing" },
      },
    });
    const prompts: string[] = [];
    const accepted = await confirmUnknownCompletion(report, async (message) => {
      prompts.push(message);
      return { status: "ok" as const, value: true };
    });
    expect(accepted).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("main");
    expect(prompts[0]).toContain("child");
    expect(report.repositories.map((r) => r.integration)).toEqual([
      "manually-confirmed",
      "manually-confirmed",
    ]);
    expect(report.repositories.every((r) => r.reasons.includes("FRESH_EVIDENCE_UNAVAILABLE"))).toBe(
      true,
    );
  });
  it("redacts a configured repository key before manual completion confirmation", async () => {
    const f = await fixture(false);
    const report = await assessFinish(f.parent, f.main);
    const key = "child\nConfirm ALL: yes";
    report.repositories[1].repository = key;
    let prompt = "";
    expect(
      await confirmUnknownCompletion(report, async (message) => {
        prompt = message;
        return { status: "ok", value: true };
      }),
    ).toBe(true);
    expect(prompt).not.toContain(key);
    expect(prompt).not.toContain("Confirm ALL: yes");
    expect(prompt).toContain("[redacted]");
    expect(report.confirmations).toContain(`MANUAL_COMPLETION:${key}`);
  });
  it("attempts bounded authenticated GitHub pagination only with matching identities", async () => {
    const head = "a".repeat(40),
      base = "b".repeat(40),
      merge = "c".repeat(40);
    const calls: string[][] = [];
    const runner = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "auth") return "";
      const page = Number(args.at(-1)?.match(/[?&]page=(\d+)/)?.[1]);
      return JSON.stringify(
        page === 1
          ? [
              {
                state: "closed",
                merged_at: "2026-01-01",
                head: { sha: head, ref: "feature", repo: { full_name: "owner/repo" } },
                base: { ref: "main", repo: { full_name: "owner/repo" } },
                merge_commit_sha: merge,
              },
              ...Array(99).fill({ state: "closed" }),
            ]
          : [],
      );
    };
    expect(
      await correlateGithub(
        "https://github.com/owner/repo.git",
        "feature",
        head,
        "https://github.com/owner/repo.git",
        "refs/heads/main",
        base,
        async (candidate) => candidate === merge,
        runner,
      ),
    ).toBe("matched");
    expect(calls.map((c) => c[0])).toEqual(["auth", "api", "api"]);
    expect(
      await correlateGithub(
        "https://example.com/repo",
        "feature",
        head,
        "https://github.com/owner/repo.git",
        "refs/heads/main",
        base,
        async () => true,
        runner,
      ),
    ).toBe("not-attempted");
  });
  it("never upgrades ambiguous or incomplete GitHub evidence to completion", async () => {
    const sha = "a".repeat(40);
    const base = "b".repeat(40);
    const identity = "https://github.com/owner/repo.git";
    const pr = {
      merged_at: "2026-01-01",
      head: { sha, ref: "feature", repo: { full_name: "owner/repo" } },
      base: { ref: "main", repo: { full_name: "owner/repo" } },
      merge_commit_sha: "c".repeat(40),
    };
    const runner = async (...args: string[]) =>
      args[0] === "auth" ? "" : JSON.stringify([pr, pr]);
    expect(
      await correlateGithub(
        identity,
        "feature",
        sha,
        identity,
        "refs/heads/main",
        base,
        async () => true,
        runner,
      ),
    ).toBe("unavailable");
    const full = async (...args: string[]) =>
      args[0] === "auth" ? "" : JSON.stringify(Array(100).fill(pr));
    expect(
      await correlateGithub(
        identity,
        "feature",
        sha,
        identity,
        "refs/heads/main",
        base,
        async () => true,
        full,
      ),
    ).toBe("unavailable");
  });
  it("keeps auth failure, fork identity, wrong base, and unreachable merge correlation unavailable", async () => {
    const sha = "a".repeat(40);
    const base = "b".repeat(40);
    const identity = "https://github.com/owner/repo.git";
    const valid = {
      merged_at: "2026-01-01",
      head: { sha, ref: "feature", repo: { full_name: "owner/repo" } },
      base: { ref: "main", repo: { full_name: "owner/repo" } },
      merge_commit_sha: "c".repeat(40),
    };
    const check = (runner: (...args: string[]) => Promise<string>, reachable = async () => true) =>
      correlateGithub(
        identity,
        "feature",
        sha,
        identity,
        "refs/heads/main",
        base,
        reachable,
        runner,
      );
    expect(
      await check(async () => {
        throw new Error("auth failed");
      }),
    ).toBe("unavailable");
    for (const candidate of [
      { ...valid, head: { ...valid.head, repo: { full_name: "fork/repo" } } },
      { ...valid, base: { ...valid.base, ref: "other" } },
      { ...valid, head: { ...valid.head, sha: "d".repeat(40) } },
    ]) {
      expect(
        await check(async (...args) => (args[0] === "auth" ? "" : JSON.stringify([candidate]))),
      ).toBe("unavailable");
    }
    expect(
      await check(
        async (...args) => (args[0] === "auth" ? "" : JSON.stringify([valid])),
        async () => false,
      ),
    ).toBe("unavailable");
  });
  it("defaults to the registered parent from parent and child only on human TTY", async () => {
    const f = await fixture();
    const modulePath = join(import.meta.dirname, "../../src/commands/finish.ts");
    for (const cwd of [f.parent, f.nested]) {
      const script = `process.stdin.isTTY = true; const { createCommand } = await import(${JSON.stringify(modulePath)}); await createCommand().parseAsync(['--dry-run'], { from: 'user' });`;
      const proc = spawnSync("bun", ["-e", script], { cwd, encoding: "utf8" });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("Finish assessment: workspace");
    }
  });
  it("keeps an absent base remote as stable unknown evidence for manual completion", async () => {
    const f = await fixture();
    git(f.main, "remote", "remove", "origin");
    const report = await assessFinish(f.parent, f.main);
    expect(report.repositories[0].integration).toBe("unknown");
    await previewFinishPlan(report, f.parent, {});
    expect(report.readiness).toBe("unknown");
    expect(report.cleanupPlan).not.toBeNull();
  });
  it("invalidates a newly configured base remote after accepting its absence", async () => {
    const f = await fixture();
    git(f.main, "remote", "remove", "origin");
    const report = await assessFinish(f.parent, f.main);
    git(f.main, "remote", "add", "origin", f.main);
    const outcome = await runFinishRemoval(report, f.parent, { force: true }, f.main);
    expect(outcome).toMatchObject({ code: 1, invalidated: true });
    expect(git(f.main, "worktree", "list", "--porcelain")).toContain(f.parent);
  });
  it("does not put a credential-bearing expanded remote URL in fetch argv", async () => {
    const f = await fixture();
    const bin = join(f.root, "bin");
    await mkdir(bin);
    const marker = join(f.root, "leaked-argv");
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *CANARY_FINISH*) printf leaked > '${marker}';; esac\nexec '${realGit}' "$@"\n`,
      { mode: 0o700 },
    );
    git(f.main, "remote", "set-url", "origin", "file://user:CANARY_FINISH@/nonexistent");
    const before = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${before}`;
      await assessFinish(f.parent, f.main);
    } finally {
      process.env.PATH = before;
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("previews without changing managed index, refs or config", async () => {
    const f = await fixture();
    const config = join(f.main, ".arashi", "config.json");
    const index = join(f.main, git(f.main, "rev-parse", "--git-path", "index"));
    const before = [await readFile(index), await readFile(config), git(f.main, "show-ref")];
    const report = await assessFinish(f.parent, f.main, { dryRun: true });
    await previewFinishPlan(report, f.parent, {});
    expect([await readFile(index), await readFile(config), git(f.main, "show-ref")]).toEqual(
      before,
    );
  });
  it("leaves every participant index, refs, config, worktree bytes, and hook effects unchanged in preview", async () => {
    const f = await fixture();
    const marker = join(f.root, "preview-hook-ran");
    const configPath = join(f.main, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.hooks = { scripts: { "pre-remove": `touch '${marker}'` } };
    await writeFile(configPath, JSON.stringify(config));
    const snapshot = async () => ({
      config: await readFile(configPath),
      parentIndex: await readFile(
        resolve(f.parent, git(f.parent, "rev-parse", "--git-path", "index")),
      ),
      childIndex: await readFile(
        resolve(f.nested, git(f.nested, "rev-parse", "--git-path", "index")),
      ),
      parentRefs: git(f.main, "show-ref"),
      childRefs: git(f.child, "show-ref"),
      parentContent: await readFile(join(f.parent, "README.md")),
      childContent: await readFile(join(f.nested, "README.md")),
    });
    const before = await snapshot();
    const preview = spawnSync(
      "bun",
      [join(import.meta.dirname, "../../src/index.ts"), "finish", f.parent, "--dry-run", "--json"],
      { cwd: f.main, encoding: "utf8" },
    );
    expect(preview.status).toBe(0);
    expect(await snapshot()).toEqual(before);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
