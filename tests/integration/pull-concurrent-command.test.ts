import { afterEach, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { createPullBenchmarkFixture } from "../../scripts/benchmark/pull-fixture.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const root = join(import.meta.dirname, "../..");
async function events(log: string) {
  try {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "));
  } catch {
    return [] as string[][];
  }
}
async function until(log: string, count: number) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const seen = await events(log);
    if (seen.filter(([kind]) => kind === "start").length >= count) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20)); // wait only; event log/barrier is evidence
  }
  throw new Error(`Waiting for ${count} pulls: ${JSON.stringify(await events(log))}`);
}
async function setup() {
  const fixture = await createPullBenchmarkFixture("large");
  const dir = await mkdtemp(join(tmpdir(), "arashi-pull-barrier-"));
  dirs.push(dir);
  const log = join(dir, "events");
  const bin = join(dir, "git");
  await writeFile(
    bin,
    `#!/bin/sh
if [ "$1" = pull ]; then
  name=$(basename "$PWD")
  printf 'start %s\\n' "$name" >> "$PULL_LOG"
  IFS= read -r signal < "$PULL_BARRIERS/$name"
  if [ "$signal" = fail ]; then
    printf 'end %s\\n' "$name" >> "$PULL_LOG"
    exit 1
  fi
  if [ "$signal" = timeout ]; then
    printf 'end %s\\n' "$name" >> "$PULL_LOG"
    exit 1
  fi
  /usr/bin/git "$@"
  result=$?
  printf 'end %s\\n' "$name" >> "$PULL_LOG"
  exit "$result"
fi
if [ "$1" = reset ] && [ "$(basename "$PWD")" = repo-02 ]; then
  printf 'rollback repo-02\\n' >> "$PULL_LOG"
fi
exec /usr/bin/git "$@"
`,
  );
  await chmod(bin, 0o755);
  for (const path of fixture.pullPaths) {
    const name = path.split("/").at(-1)!;
    const fifo = join(dir, name);
    const result = spawn("mkfifo", [fifo]);
    if ((await new Promise<number>((resolve) => result.on("close", resolve))) !== 0)
      throw new Error("mkfifo failed");
  }
  const invoke = (args: string[]) => {
    const child = spawn(process.execPath, [join(root, "src/index.ts"), "pull", ...args], {
      cwd: fixture.refreshedRoot,
      env: {
        ...fixture.environment,
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        PULL_LOG: log,
        PULL_BARRIERS: dir,
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    return {
      child,
      done: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
        child.on("close", (code) => resolve({ code, stdout, stderr })),
      ),
    };
  };
  const release = async (name: string, signal = "go") => {
    await writeFile(join(dir, name), `${signal}\n`);
  };
  return { fixture, log, invoke, release };
}

test("real CLI bounds overlapping Git pulls and buffers JSON results in configured order", async () => {
  const h = await setup();
  try {
    const run = h.invoke(["--jobs", "2", "--json"]);
    await until(h.log, 1);
    await h.release("workspace");
    const two = await until(h.log, 3);
    expect(
      two
        .filter(([kind]) => kind === "start")
        .map(([, name]) => name)
        .toSorted(),
    ).toEqual(["repo-01", "repo-02", "workspace"]);
    expect(two.filter(([kind]) => kind === "end").map(([, name]) => name)).toEqual(["workspace"]);
    await h.release("repo-02");
    await until(h.log, 4);
    for (let i = 3; i <= 8; i++) {
      await h.release(`repo-${String(i).padStart(2, "0")}`);
      if (i < 8) await until(h.log, i + 2);
    }
    await h.release("repo-01");
    const result = await run.done;
    expect(result.code, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.data.results.map((r: { repositoryId: string }) => r.repositoryId)).toEqual(
      h.fixture.pullPaths.map((path) => path.split("/").at(-1)),
    );
    const seen = await events(h.log);
    let active = 0,
      max = 0;
    for (const [kind, name] of seen) {
      if (name === "workspace") continue;
      active += kind === "start" ? 1 : -1;
      max = Math.max(max, active);
      expect(active).toBeGreaterThanOrEqual(0);
    }
    expect(active).toBe(0);
    expect(max).toBe(2);
    await h.fixture.verifyUpdated();
  } finally {
    await h.fixture.cleanup();
  }
}, 120000);

test("first failed real pull stops queued work, drains active and preserves rollback", async () => {
  const h = await setup();
  try {
    const run = h.invoke(["--jobs", "2", "--json"]);
    await until(h.log, 1);
    await h.release("workspace");
    await until(h.log, 3);
    await h.release("repo-02", "fail");
    // Wait for failure to be observed before draining the other active pull.
    const deadline = Date.now() + 20000;
    while (
      !(await events(h.log)).some(([kind, name]) => kind === "rollback" && name === "repo-02")
    ) {
      if (Date.now() > deadline) throw new Error("rollback did not settle");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await h.release("repo-01");
    const result = await run.done;
    expect(result.code).toBe(1);
    const names = (await events(h.log))
      .filter(([kind]) => kind === "start")
      .map(([, name]) => name);
    expect(names.toSorted()).toEqual(["repo-01", "repo-02", "workspace"]);
    const results = JSON.parse(result.stdout).data.results;
    expect(results.map((r: { repositoryId: string }) => r.repositoryId)).toEqual([
      "workspace",
      "repo-01",
      "repo-02",
    ]);
    expect(results[2].status).toBe("manual-update");
    expect((await events(h.log)).filter(([kind]) => kind === "end")).toHaveLength(3);
    await expect(
      readFile(join(h.fixture.pullPaths[2]!, "pull-update-02.txt"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(h.fixture.pullPaths[1]!, "pull-update-01.txt"), "utf8")).toContain(
      "pull fixture update",
    );
  } finally {
    await h.fixture.cleanup();
  }
}, 120000);

test("timed-out real child pulls stop queued claims and return only after both active failures", async () => {
  const h = await setup();
  try {
    const configPath = join(h.fixture.refreshedRoot, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.hooks = { timeout: 1500 };
    await writeFile(configPath, JSON.stringify(config));
    const selected = Array.from({ length: 8 }, (_, index) => [
      "--only",
      `repo-${String(index + 1).padStart(2, "0")}`,
    ]).flat();
    const run = h.invoke(["--jobs", "2", "--json", ...selected]);
    await until(h.log, 2);
    const result = await run.done;
    expect(result.code, result.stderr).toBe(1);
    const started = (await events(h.log))
      .filter(([kind]) => kind === "start")
      .map(([, name]) => name);
    expect(started.toSorted()).toEqual(["repo-01", "repo-02"]);
    const outcomes = JSON.parse(result.stdout).data.results;
    expect(outcomes.map((entry: { repositoryId: string }) => entry.repositoryId)).toEqual([
      "repo-01",
      "repo-02",
    ]);
    expect(
      outcomes.every(
        (entry: { status: string; errorMessage: string }) =>
          entry.status === "failed" && entry.errorMessage.includes("Timed out"),
      ),
    ).toBe(true);
    await expect(
      readFile(join(h.fixture.pullPaths[1]!, "pull-update-01.txt"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(h.fixture.pullPaths[2]!, "pull-update-02.txt"), "utf8"),
    ).rejects.toThrow();
  } finally {
    await h.fixture.cleanup();
  }
}, 120000);

test("real CLI buffers human progress and verbose Git output after out-of-order completion", async () => {
  const h = await setup();
  try {
    const run = h.invoke(["--jobs", "2", "--verbose"]);
    await until(h.log, 1);
    await h.release("workspace");
    await until(h.log, 3);
    await h.release("repo-02");
    await until(h.log, 4);
    for (let i = 3; i <= 8; i++) {
      await h.release(`repo-${String(i).padStart(2, "0")}`);
      if (i < 8) await until(h.log, i + 2);
    }
    await h.release("repo-01");
    const result = await run.done;
    expect(result.code, result.stderr).toBe(0);
    for (let i = 1; i <= 8; i++) {
      const current = `repo-${String(i).padStart(2, "0")}: updated`;
      expect(result.stdout).toContain(current);
      if (i > 1)
        expect(
          result.stdout.indexOf(`repo-${String(i - 1).padStart(2, "0")}: updated`),
        ).toBeLessThan(result.stdout.indexOf(current));
    }
    expect(result.stdout).toContain("Fast-forward");
    expect(result.stdout).toContain("overall: success");
  } finally {
    await h.fixture.cleanup();
  }
}, 120000);
