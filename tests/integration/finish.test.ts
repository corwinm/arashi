import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { assessFinish, runFinishRemoval } from "../../src/commands/finish.ts";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
async function fixture(base = true) {
  const root = await mkdtemp(join(tmpdir(), "arashi-finish-"));
  roots.push(root);
  const main = join(root, "main");
  const child = join(main, "repos", "child");
  await mkdir(child, { recursive: true });
  for (const path of [main, child]) {
    git(path, "init", "-b", "main");
    git(path, "config", "user.name", "Test");
    git(path, "config", "user.email", "test@example.com");
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
      repos: { child: { path: "repos/child" } },
    }),
  );
  const parent = join(root, "workspace");
  git(main, "worktree", "add", "-b", "feature", parent);
  const nested = join(parent, "repos", "child");
  await mkdir(join(parent, "repos"), { recursive: true });
  git(child, "worktree", "add", "-b", "other", nested);
  return { root, main, child, parent, nested };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("finish assessment with real Git repositories", () => {
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
});
