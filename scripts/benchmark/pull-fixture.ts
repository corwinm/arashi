import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBenchmarkFixture, type BenchmarkFixture, type FixtureId } from "./fixtures.ts";
import { invoke } from "./invoke.ts";

export interface PullBenchmarkFixture extends BenchmarkFixture {
  pullPaths: string[];
  prepare(): Promise<void>;
  verifyPending(): Promise<void>;
  verifyUpdated(): Promise<void>;
  fixtureFingerprint: string;
}

async function git(
  path: string,
  environment: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<string> {
  const result = await invoke({ command: "git", args: [] }, args, path, environment);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export async function createPullBenchmarkFixture(id: FixtureId): Promise<PullBenchmarkFixture> {
  const fixture = await createBenchmarkFixture(id, { deterministicCommits: true });
  const pullPaths = fixture.repositoryPaths;
  try {
    const originalHeads: string[] = [];
    const updatedHeads: string[] = [];
    for (const [index, path] of pullPaths.entries()) {
      const original = await git(path, fixture.environment, "rev-parse", "HEAD");
      const remoteBefore = (
        await git(path, fixture.environment, "ls-remote", "origin", "refs/heads/main")
      ).split("\t")[0];
      if (original !== remoteBefore) {
        const log = await git(path, fixture.environment, "log", "--oneline", "--all", "-5");
        throw new Error(
          `Fixture starts diverged at ${path}: ${original} / ${remoteBefore}; ${log}`,
        );
      }
      const marker = join(path, `pull-update-${String(index).padStart(2, "0")}.txt`);
      await writeFile(marker, `pull fixture update ${id} ${index}\n`, "utf8");
      await git(path, fixture.environment, "add", marker);
      await git(
        path,
        fixture.environment,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "pull benchmark update",
      );
      const updated = await git(path, fixture.environment, "rev-parse", "HEAD");
      await git(path, fixture.environment, "push", "origin", "main");
      await git(path, fixture.environment, "reset", "--hard", original);
      originalHeads.push(original);
      updatedHeads.push(updated);
    }
    const verify = async (updated: boolean) => {
      for (const [index, path] of pullPaths.entries()) {
        const head = await git(path, fixture.environment, "rev-parse", "HEAD");
        const remote = (
          await git(path, fixture.environment, "ls-remote", "origin", "refs/heads/main")
        ).split("\t")[0];
        if (
          head !== (updated ? updatedHeads[index] : originalHeads[index]) ||
          remote !== updatedHeads[index]
        ) {
          throw new Error(`Pull fixture ${id} ${index} has unexpected local/remote HEAD`);
        }
        const marker = join(path, `pull-update-${String(index).padStart(2, "0")}.txt`);
        if (
          updated &&
          (await readFile(marker, "utf8")) !== `pull fixture update ${id} ${index}\n`
        ) {
          throw new Error(`Pull fixture marker mismatch in ${path}`);
        }
      }
    };
    return {
      ...fixture,
      pullPaths,
      fixtureFingerprint: createHash("sha256")
        .update(JSON.stringify({ id, originalHeads, updatedHeads, version: 1 }))
        .digest("hex"),
      prepare: async () => {
        for (const [index, path] of pullPaths.entries()) {
          await git(path, fixture.environment, "reset", "--hard", originalHeads[index]!);
        }
        await verify(false);
      },
      verifyPending: () => verify(false),
      verifyUpdated: () => verify(true),
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}
