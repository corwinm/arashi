import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  assessFinish,
  runFinishRemoval,
  previewFinishPlan,
  confirmUnknownCompletion,
  correlateGithub,
} from "../../src/commands/finish.ts";

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
      const report = await assessFinish(f.parent.toUpperCase(), f.main);
      expect(report.readiness).toBe("ready");
      expect(report.repositories.map((r) => r.repository)).toEqual(["main", "child"]);
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
  it("documents bounded GitHub correlation without promising integration proof", async () => {
    const readme = await readFile(join(import.meta.dirname, "../../README.md"), "utf8");
    expect(readme).toContain("GitHub PR correlation");
    expect(readme).toContain("up to three");
    expect(readme).not.toContain("GitHub PR correlation is not attempted in v1");
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
  it("defaults to the registered parent from parent and child only on human TTY", async () => {
    const f = await fixture();
    const modulePath = join(import.meta.dirname, "../../src/commands/finish.ts");
    for (const cwd of [f.parent, f.nested]) {
      const script = `process.stdin.isTTY = true; const { createCommand } = await import(${JSON.stringify(modulePath)}); await createCommand().parseAsync(['--dry-run'], { from: 'user' });`;
      const proc = spawnSync("bun", ["-e", script], { cwd, encoding: "utf8" });
      expect(proc.status).toBe(0);
      expect(JSON.parse(proc.stdout).target).toBe("workspace");
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
});
