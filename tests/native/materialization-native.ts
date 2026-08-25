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
import { dirname, join, resolve } from "node:path";
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
  worktreeNaming?: {
    branchSlashes?: "flatten" | "preserve";
    maxPathLength?: number;
    style?: "branch" | "default" | "repo-branch";
  },
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
        ...(worktreeNaming ? { worktreeNaming } : {}),
        worktreesDir: "native-worktrees",
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

type NativeNamingPolicy = {
  branchSlashes: "flatten" | "preserve";
  style: "branch" | "default" | "repo-branch";
};

const nativeNamingCases: { id: string; policy?: NativeNamingPolicy }[] = [
  { id: "omitted" },
  { id: "default-preserve", policy: { branchSlashes: "preserve", style: "default" } },
  { id: "default-flatten", policy: { branchSlashes: "flatten", style: "default" } },
  { id: "branch-preserve", policy: { branchSlashes: "preserve", style: "branch" } },
  { id: "branch-flatten", policy: { branchSlashes: "flatten", style: "branch" } },
  {
    id: "repo-branch-preserve",
    policy: { branchSlashes: "preserve", style: "repo-branch" },
  },
  {
    id: "repo-branch-flatten",
    policy: { branchSlashes: "flatten", style: "repo-branch" },
  },
];

const expectedNamingRelativePath = (
  bare: boolean,
  repositoryComponent: string,
  branch: string,
  policy?: NativeNamingPolicy,
): string => {
  const style = policy?.style ?? "default";
  const branchSlashes = policy?.branchSlashes ?? "preserve";
  const branchComponents =
    branchSlashes === "flatten" ? [branch.replaceAll("/", "-")] : branch.split("/");
  if (style === "repo-branch") {
    return join(`${repositoryComponent}-${branchComponents[0]}`, ...branchComponents.slice(1));
  }
  if (style === "default" && bare) {
    return join(repositoryComponent, ...branchComponents);
  }
  return join(...branchComponents);
};

const writeNamingConfig = async (
  path: string,
  worktreesDir: string,
  policy?: NativeNamingPolicy,
) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        repos: {
          app: {
            defaultBranch: "main",
            isBare: false,
            path: "./repos/app",
          },
        },
        reposDir: "./repos",
        version: "1.0.0",
        ...(policy ? { worktreeNaming: policy } : {}),
        worktreesDir,
      },
      null,
      2,
    )}\n`,
  );
};

const runNativeNamingMatrix = async (
  binary: string,
  root: string,
  environment: NodeJS.ProcessEnv,
) => {
  for (const bare of [false, true]) {
    for (const namingCase of nativeNamingCases) {
      const caseRoot = join(root, "naming-matrix", bare ? "bare" : "non-bare", namingCase.id);
      const repositoryComponent = bare ? "example" : "workspace";
      let source: string;

      if (bare) {
        const seed = join(caseRoot, "seed");
        source = join(caseRoot, `${repositoryComponent}.git`);
        await initRepository(seed, `${namingCase.id} bare parent`);
        await writeNamingConfig(join(seed, ".arashi", "config.json"), "..", namingCase.policy);
        await git(seed, "add", ".arashi/config.json");
        await git(seed, "commit", "-m", `Configure ${namingCase.id} naming`);
        await git(caseRoot, "clone", "--bare", seed, source);
        await initRepository(join(source, "repos", "app"), `${namingCase.id} bare child`);
      } else {
        source = join(caseRoot, repositoryComponent);
        await initRepository(source, `${namingCase.id} non-bare parent`);
        await initRepository(join(source, "repos", "app"), `${namingCase.id} non-bare child`);
        await writeNamingConfig(
          join(source, ".arashi", "config.json"),
          "native-worktrees",
          namingCase.policy,
        );
      }

      const branch = `native/matrix/${namingCase.id}`;
      const created = await run(
        binary,
        ["create", branch, "--no-hooks", "--no-progress", "--no-launch", "--no-switch", "--json"],
        { cwd: source, env: environment },
      );
      assert(
        created.code === 0,
        `${bare ? "bare" : "non-bare"} ${namingCase.id} naming create failed:\n${created.stdout}\n${created.stderr}`,
      );
      const envelope = parseJson(created);
      const data = envelope.data as { repositories: { name: string; worktreePath: string }[] };
      const base = bare ? caseRoot : join(source, "native-worktrees");
      const parentDestination = join(
        base,
        expectedNamingRelativePath(bare, repositoryComponent, branch, namingCase.policy),
      );
      const childDestination = join(parentDestination, "repos", "app");
      assert(
        await exists(childDestination),
        `${bare ? "bare" : "non-bare"} ${namingCase.id} coordinated child destination is missing at ${childDestination}: ${JSON.stringify(data.repositories)}`,
      );
      const canonicalParent = await realpath(parentDestination);
      const canonicalChild = await realpath(childDestination);
      const canonicalReportedPaths = await Promise.all(
        data.repositories.map(({ worktreePath }) => realpath(worktreePath)),
      );
      assert(
        canonicalReportedPaths.includes(canonicalParent),
        `${bare ? "bare" : "non-bare"} ${namingCase.id} JSON omitted parent ${canonicalParent}: ${JSON.stringify(data.repositories)}`,
      );
      assert(
        canonicalReportedPaths.includes(canonicalChild),
        `${bare ? "bare" : "non-bare"} ${namingCase.id} JSON omitted coordinated child ${canonicalChild}: ${JSON.stringify(data.repositories)}`,
      );
      assert(
        canonicalChild === (await realpath(join(canonicalParent, "repos", "app"))),
        `${bare ? "bare" : "non-bare"} ${namingCase.id} child escaped the authoritative parent`,
      );
      assert(
        (await git(source, "show-ref", "--verify", `refs/heads/${branch}`)).length > 0,
        `${bare ? "bare" : "non-bare"} ${namingCase.id} changed the parent Git branch identity`,
      );
      assert(
        (await git(join(source, "repos", "app"), "show-ref", "--verify", `refs/heads/${branch}`))
          .length > 0,
        `${bare ? "bare" : "non-bare"} ${namingCase.id} changed the child Git branch identity`,
      );
    }
  }
};

const runNativePathBudgetAcceptance = async (
  binary: string,
  root: string,
  environment: NodeJS.ProcessEnv,
) => {
  const workspace = join(
    root,
    "path-budget",
    "long-workspace-root-component-for-native-acceptance",
    "workspace",
  );
  const app = join(workspace, "repos", "app");
  await initRepository(workspace, "native path budget parent");
  await initRepository(app, "native path budget child");
  const base = join(workspace, "native-worktrees");
  const childSuffix = join("repos", "app");
  const maxPathLength = base.length + 1 + 24 + 1 + childSuffix.length;
  await writeConfig(workspace, "./repos/app", { copy: [], symlink: [] }, { maxPathLength });
  const branch = `native/path-budget/${"long-segment-".repeat(8)}end`;
  const ordinaryParent = join(base, branch);

  const created = await run(
    binary,
    ["create", branch, "--no-hooks", "--no-progress", "--no-launch", "--no-switch", "--json"],
    { cwd: workspace, env: environment },
  );
  assert(
    created.code === 0,
    `native configured path-budget create failed:\n${created.stdout}\n${created.stderr}`,
  );
  const envelope = parseJson(created);
  const data = envelope.data as {
    repositories: { branchName: string; repositoryName: string; worktreePath: string }[];
  };
  assert(data.repositories.length === 2, "native path-budget plan omitted a repository");
  assert(
    data.repositories.every(
      ({ branchName, worktreePath }) =>
        branchName === branch && worktreePath.length <= maxPathLength,
    ),
    `native path-budget paths or branches violate the contract: ${JSON.stringify(data.repositories)}`,
  );
  const parent = data.repositories.find(
    ({ repositoryName }) => repositoryName === "workspace",
  )?.worktreePath;
  const child = data.repositories.find(
    ({ repositoryName }) => repositoryName === "app",
  )?.worktreePath;
  assert(parent && child, "native path-budget JSON omitted parent or child paths");
  assert(parent !== ordinaryParent, "native path-budget parent was not shortened");
  assert(child === join(parent, childSuffix), "native path-budget child did not share one parent");
  assert(await exists(join(parent, "README.md")), "native path-budget parent was not created");
  assert(await exists(join(child, "README.md")), "native path-budget child was not created");
  assert(
    (await git(workspace, "show-ref", "--verify", `refs/heads/${branch}`)).length > 0,
    "native path-budget changed the parent Git branch identity",
  );
  assert(
    (await git(app, "show-ref", "--verify", `refs/heads/${branch}`)).length > 0,
    "native path-budget changed the child Git branch identity",
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

    const previewBranch = "native/materialization-preview";
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
    const previewPath = join(workspace, "native-worktrees", previewBranch);
    assert(!(await exists(previewPath)), "dry-run created a worktree");

    const branch = "native/materialization-create";
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

    const destination = join(workspace, "native-worktrees", branch, "repos", "app");
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

    await writeConfig(
      workspace,
      "./repos/app",
      { copy: [], symlink: [] },
      { branchSlashes: "flatten", style: "repo-branch" },
    );
    const namingBranch = "native/naming-layout";
    const namedCreate = await run(
      binary,
      ["create", namingBranch, "--only", "app", "--no-hooks", "--no-progress", "--json"],
      { cwd: workspace, env: environment },
    );
    assert(
      namedCreate.code === 0,
      `configured naming create failed:\n${namedCreate.stdout}\n${namedCreate.stderr}`,
    );
    const namedEnvelope = parseJson(namedCreate);
    const namedData = namedEnvelope.data as { repositories: { worktreePath: string }[] };
    const namedParent = join(workspace, "native-worktrees", "workspace-native-naming-layout");
    const namedChild = join(namedParent, "repos", "app");
    assert(await exists(namedChild), `configured naming destination is missing: ${namedChild}`);
    const canonicalNamedChild = await realpath(namedChild);
    const canonicalReportedPaths = await Promise.all(
      namedData.repositories.map(({ worktreePath }) => realpath(worktreePath)),
    );
    assert(
      canonicalReportedPaths.includes(canonicalNamedChild),
      `configured naming JSON omitted the canonical child path: ${JSON.stringify(namedData.repositories)}`,
    );
    assert(
      (await git(app, "show-ref", "--verify", `refs/heads/${namingBranch}`)).length > 0,
      "configured naming changed the exact selected-child Git branch",
    );
    const namedRemove = await run(
      binary,
      ["remove", namingBranch, "--force", "--keep-branches", "--json"],
      { cwd: workspace, env: environment },
    );
    assert(
      namedRemove.code === 0,
      `configured naming cleanup failed:\n${namedRemove.stdout}\n${namedRemove.stderr}`,
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
      !(await exists(join(workspace, ".arashi", "worktrees", "native-materialization-alias"))),
      "alias failure mutated Git/filesystem",
    );

    await runNativeNamingMatrix(binary, root, environment);
    await runNativePathBudgetAcceptance(binary, root, environment);

    const bareSeed = join(root, "bare-seed");
    const bareSource = join(root, "example.git");
    await initRepository(bareSeed, "bare source");
    await mkdir(join(bareSeed, ".arashi"), { recursive: true });
    await writeFile(
      join(bareSeed, ".arashi", "config.json"),
      `${JSON.stringify(
        { repos: {}, reposDir: "./repos", version: "1.0.0", worktreesDir: ".." },
        null,
        2,
      )}\n`,
    );
    await git(bareSeed, "add", ".arashi/config.json");
    await git(bareSeed, "commit", "-m", "Configure bare worktree namespace");
    await git(root, "clone", "--bare", bareSeed, bareSource);
    const bareBranch = "native/bare-layout";
    const bareCreate = await run(
      binary,
      ["create", bareBranch, "--no-hooks", "--no-progress", "--no-launch", "--no-switch", "--json"],
      { cwd: bareSource, env: environment },
    );
    assert(
      bareCreate.code === 0,
      `configured bare create failed:\n${bareCreate.stdout}\n${bareCreate.stderr}`,
    );
    const bareEnvelope = parseJson(bareCreate);
    const bareData = bareEnvelope.data as { repositories: { worktreePath: string }[] };
    const bareDestination = join(root, "example", "native", "bare-layout");
    const canonicalBareDestination = await realpath(bareDestination);
    const canonicalReportedBareDestination = await realpath(
      bareData.repositories[0]?.worktreePath ?? "",
    );
    assert(
      canonicalReportedBareDestination === canonicalBareDestination,
      `bare JSON reported the wrong destination: ${JSON.stringify(bareData.repositories)}`,
    );
    assert(await exists(join(bareDestination, "README.md")), "bare namespace checkout missing");
    assert(
      !(await exists(join(bareSource, "native", "bare-layout", "README.md"))),
      "bare checkout was placed inside Git storage",
    );

    process.stdout.write(`native materialization RED acceptance passed on ${process.platform}\n`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

await main();
