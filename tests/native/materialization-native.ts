/* oxlint-disable sort-imports */
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};

const run = async (
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> => {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (status) => accept(status ?? 1));
  });
  return { code, stderr, stdout };
};

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await run("git", args, { cwd });
  if (result.code !== 0) {
    fail(`git ${args.join(" ")} failed (${result.code})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
};

const parseJson = (result: CommandResult): Record<string, unknown> => {
  assert(result.stdout.endsWith("\n"), `JSON stdout has no trailing newline:\n${result.stdout}`);
  let parsed!: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    fail(
      `stdout is not one JSON document: ${String(error)}\n${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  assert(
    result.stdout === `${JSON.stringify(parsed, null, 2)}\n`,
    `stdout is not the canonical isolated document:\n${result.stdout}`,
  );
  return parsed;
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const writeConfig = async (
  workspace: string,
  repoPath: string,
  policy: { copy: string[]; symlink: string[] },
) => {
  await mkdir(join(workspace, ".arashi", "hooks"), { recursive: true });
  await writeFile(
    join(workspace, ".arashi", "config.json"),
    `${JSON.stringify(
      {
        repos: {
          app: {
            defaultBranch: "main",
            isBare: false,
            path: repoPath,
            ...policy,
          },
        },
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir: ".arashi/worktrees",
      },
      null,
      2,
    )}\n`,
  );
};

const initRepository = async (path: string, title: string) => {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "Native Materialization Acceptance");
  await git(path, "config", "user.email", "native-materialization@example.invalid");
  await git(path, "config", "commit.gpgSign", "false");
  await writeFile(join(path, "README.md"), `# ${title}\n`);
  await git(path, "add", "README.md");
  await git(path, "commit", "-m", "Initial fixture");
};

const writeHooks = async (workspace: string, orderPath: string) => {
  const hooks = join(workspace, ".arashi", "hooks");
  if (process.platform === "win32") {
    await writeFile(
      join(hooks, "pre-create.app.ps1"),
      [
        'if (Test-Path -LiteralPath (Join-Path $env:ARASHI_WORKTREE_PATH ".env.local")) { exit 71 }',
        `Add-Content -LiteralPath '${orderPath.replaceAll("'", "''")}' -Value 'pre'`,
        "exit 0",
        "",
      ].join("\r\n"),
    );
    await writeFile(
      join(hooks, "post-create.app.ps1"),
      [
        'if (-not (Test-Path -LiteralPath (Join-Path $env:ARASHI_WORKTREE_PATH ".env.local"))) { exit 72 }',
        String.raw`if (-not (Test-Path -LiteralPath (Join-Path $env:ARASHI_WORKTREE_PATH "assets with spaces\nested\value$.txt"))) { exit 73 }`,
        `Add-Content -LiteralPath '${orderPath.replaceAll("'", "''")}' -Value 'post'`,
        "exit 0",
        "",
      ].join("\r\n"),
    );
    return;
  }

  const pre = join(hooks, "pre-create.app.sh");
  const post = join(hooks, "post-create.app.sh");
  await writeFile(
    pre,
    `#!/bin/sh\nset -eu\ntest ! -e "$ARASHI_WORKTREE_PATH/.env.local"\nprintf 'pre\\n' >> '${orderPath}'\n`,
  );
  await writeFile(
    post,
    `#!/bin/sh\nset -eu\ntest -f "$ARASHI_WORKTREE_PATH/.env.local"\ntest -f "$ARASHI_WORKTREE_PATH/assets with spaces/nested/value$.txt"\nprintf 'post\\n' >> '${orderPath}'\n`,
  );
  await chmod(pre, 0o755);
  await chmod(post, 0o755);
};

const expectOutcomeStatuses = (
  envelope: Record<string, unknown>,
  expected: { action: string; path: string; status: string }[],
) => {
  const data = envelope.data as {
    repositoryResults: {
      materializationOutcomes: { action: string; path: string; status: string }[];
    }[];
  };
  assert(data.repositoryResults.length === 1, "expected one repository result");
  const projected = data.repositoryResults[0]!.materializationOutcomes.map(
    ({ action, path, status }) => ({
      action,
      path,
      status,
    }),
  );
  assert(
    JSON.stringify(projected) === JSON.stringify(expected),
    `unexpected materialization outcomes: ${JSON.stringify(projected)}`,
  );
};

const main = async () => {
  const [, , binaryArgument] = process.argv;
  assert(
    binaryArgument,
    "usage: node --experimental-strip-types tests/native/materialization-native.ts <binary>",
  );
  const binary = resolve(binaryArgument);
  assert(await exists(binary), `built CLI does not exist: ${binary}`);

  const root = await mkdtemp(join(tmpdir(), "arashi-materialization-native-"));
  const workspace = join(root, "workspace");
  const app = join(workspace, "repos", "app");
  const environment = { ...process.env, HOME: join(root, "home"), NO_COLOR: "1" };
  await mkdir(environment.HOME, { recursive: true });

  try {
    await initRepository(workspace, "workspace");
    await initRepository(app, "app");
    await writeFile(join(app, ".env.local"), "NATIVE-SECRET-CONTENT\n");
    await mkdir(join(app, "assets with spaces", "nested"), { recursive: true });
    await writeFile(join(app, "assets with spaces", "nested", "value$.txt"), "asset\n");
    await mkdir(join(app, ".shared-cache"), { recursive: true });
    await writeFile(join(app, ".shared-cache", "cache.txt"), "cache-target\n");
    await writeConfig(workspace, "./repos/app", {
      copy: [".env.local", "assets with spaces", "optional-missing.txt"],
      symlink: [".shared-cache"],
    });
    const orderPath = join(workspace, ".arashi", "native-order.log");
    await writeHooks(workspace, orderPath);

    const previewBranch = "native-materialization-preview";
    const preview = await run(
      binary,
      ["create", previewBranch, "--only", "app", "--dry-run", "--json"],
      { cwd: workspace, env: environment },
    );
    assert(preview.code === 0, `actionable dry-run failed:\n${preview.stdout}\n${preview.stderr}`);
    const previewEnvelope = parseJson(preview);
    const previewData = previewEnvelope.data as {
      dryRunOutcome: {
        materializationPlans: {
          outcomes: { path: string; status: string }[];
          repositoryId: string;
        }[];
      };
      repositoryResults: unknown[];
    };
    assert(
      previewData.repositoryResults.length === 0,
      "dry-run populated executed repository results",
    );
    assert(
      JSON.stringify(
        previewData.dryRunOutcome.materializationPlans[0]?.outcomes.map(({ path, status }) => ({
          path,
          status,
        })),
      ) ===
        JSON.stringify([
          { path: ".env.local", status: "would-copy" },
          { path: "assets with spaces", status: "would-copy" },
          { path: "optional-missing.txt", status: "skipped" },
          { path: ".shared-cache", status: "would-link" },
        ]),
      `unexpected dry-run plan: ${JSON.stringify(previewData.dryRunOutcome.materializationPlans)}`,
    );
    const previewPath = join(
      workspace,
      ".arashi",
      "worktrees",
      `${basename(workspace)}-${previewBranch}`,
    );
    assert(!(await exists(previewPath)), "dry-run created a worktree");

    const branch = "native-materialization-create";
    const created = await run(
      binary,
      ["create", branch, "--only", "app", "--no-progress", "--json"],
      { cwd: workspace, env: environment },
    );
    assert(created.code === 0, `configured create failed:\n${created.stdout}\n${created.stderr}`);
    const envelope = parseJson(created);
    assert(
      envelope.ok === true && envelope.command === "create",
      "unexpected create envelope identity",
    );
    expectOutcomeStatuses(envelope, [
      { action: "copy", path: ".env.local", status: "copied" },
      { action: "copy", path: "assets with spaces", status: "copied" },
      { action: "copy", path: "optional-missing.txt", status: "skipped" },
      { action: "symlink", path: ".shared-cache", status: "linked" },
    ]);
    assert(!created.stdout.includes("NATIVE-SECRET-CONTENT"), "JSON leaked copied file contents");
    assert(created.stderr === "", `JSON leaked human stderr: ${created.stderr}`);

    const destination = join(
      workspace,
      ".arashi",
      "worktrees",
      `${basename(workspace)}-${branch}`,
      "repos",
      "app",
    );
    assert(
      (await readFile(join(destination, ".env.local"), "utf8")) === "NATIVE-SECRET-CONTENT\n",
      "copy missing",
    );
    assert(
      (await readFile(join(destination, "assets with spaces", "nested", "value$.txt"), "utf8")) ===
        "asset\n",
      "nested copy missing",
    );
    assert(
      (await lstat(join(destination, ".shared-cache"))).isSymbolicLink(),
      "native symlink was replaced by fallback",
    );
    assert(
      resolve(
        dirname(join(destination, ".shared-cache")),
        await readlink(join(destination, ".shared-cache")),
      ) === (await realpath(join(app, ".shared-cache"))),
      "native link target is not the exact canonical source",
    );
    const order = (await readFile(orderPath, "utf8")).replaceAll("\r\n", "\n");
    assert(order === "pre\npost\n", `wrong lifecycle order: ${JSON.stringify(order)}`);

    const doctor = await run(binary, ["doctor", "--json"], { cwd: workspace, env: environment });
    const doctorEnvelope = parseJson(doctor);
    const doctorData = (
      doctorEnvelope.ok === true
        ? doctorEnvelope.data
        : (doctorEnvelope.error as { details: unknown }).details
    ) as {
      findings: { code: string }[];
    };
    assert(
      !doctorData.findings.some(({ code }) => code === "MATERIALIZATION_SYMLINK_BROKEN"),
      `doctor called the exact native link broken: ${JSON.stringify(doctorData.findings)}`,
    );

    const removed = await run(binary, ["remove", branch, "--force", "--keep-branches", "--json"], {
      cwd: workspace,
      env: environment,
    });
    assert(removed.code === 0, `coordinated remove failed:\n${removed.stdout}\n${removed.stderr}`);
    assert(!(await exists(destination)), "remove preserved the materialized worktree");
    assert(
      (await readFile(join(app, ".env.local"), "utf8")) === "NATIVE-SECRET-CONTENT\n",
      "remove deleted copy source",
    );
    assert(
      (await readFile(join(app, ".shared-cache", "cache.txt"), "utf8")) === "cache-target\n",
      "remove followed and deleted symlink target",
    );

    await writeConfig(workspace, "./repos/app", {
      copy: ["Cache/value", "cache/VALUE"],
      symlink: [],
    });
    const alias = await run(
      binary,
      ["create", "native-materialization-alias", "--only", "app", "--dry-run", "--json"],
      { cwd: workspace, env: environment },
    );
    assert(alias.code !== 0, "portable case alias unexpectedly succeeded");
    const aliasEnvelope = parseJson(alias);
    assert(aliasEnvelope.ok === false, "portable alias did not return a structured failure");
    assert(
      !(await exists(
        join(
          workspace,
          ".arashi",
          "worktrees",
          `${basename(workspace)}-native-materialization-alias`,
        ),
      )),
      "alias failure mutated Git/filesystem",
    );

    process.stdout.write(`native materialization RED acceptance passed on ${process.platform}\n`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

await main();
