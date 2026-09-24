import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { invoke } from "../../scripts/benchmark/invoke.ts";
import {
  createPullBenchmarkFixture,
  type PullBenchmarkFixture,
} from "../../scripts/benchmark/pull-fixture.ts";

let fixture: PullBenchmarkFixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

test("small pull fixture resets actual remote updates for parent and every configured child", async () => {
  fixture = await createPullBenchmarkFixture("small");
  expect(fixture.repositoryPaths).toHaveLength(3);
  expect(fixture.pullPaths).toHaveLength(3);
  for (const path of fixture.pullPaths) {
    const remote = await invoke(
      { command: "git", args: [] },
      ["ls-remote", "origin", "refs/heads/main"],
      path,
      fixture.environment,
    );
    const local = await invoke(
      { command: "git", args: [] },
      ["rev-parse", "HEAD"],
      path,
      fixture.environment,
    );
    expect(remote.exitCode).toBe(0);
    expect(remote.stdout.split("\t")[0]).not.toBe(local.stdout.trim());
  }
  expect(await readFile(`${fixture.refreshedRoot}/.arashi/config.json`, "utf8")).toContain(
    "repo-02",
  );
  await fixture.prepare();
  await fixture.verifyPending();
  const fingerprint = fixture.fixtureFingerprint;
  await fixture.cleanup();
  fixture = await createPullBenchmarkFixture("small");
  expect(fixture.fixtureFingerprint).toBe(fingerprint);
});

test("large pull fixture materializes all coordinated child worktrees and remote updates", async () => {
  fixture = await createPullBenchmarkFixture("large");
  expect(fixture.repositoryPaths).toHaveLength(9);
  expect(fixture.coordinatedChildWorktreeCount).toBe(40);
  expect(fixture.pullPaths).toHaveLength(9);
  await fixture.verifyPending();
});
