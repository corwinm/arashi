import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { releaseNpmCommand, spawnReleaseCommand } from "./release-command.ts";

const versionArgument = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
const version = versionArgument?.trim().replace(/^v/, "");
if (
  !version ||
  version === "latest" ||
  version === "stable" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
) {
  console.error(
    "An exact published version is required (for example: pnpm release:verify-aw -- 1.31.0).",
  );
  process.exit(2);
}

function reportedVersion(output: string): string | undefined {
  return output.match(
    /(?:^|[^0-9A-Za-z.-])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.-])/u,
  )?.[1];
}

function reportedFinalVersion(output: string): string | undefined {
  const finalLine = output.trim().split(/\r?\n/u).at(-1)?.trim();
  return finalLine?.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u)?.[1];
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnReleaseCommand(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function runResult(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnReleaseCommand(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertParity({
  alias,
  args,
  canonical,
  options = {},
}: {
  alias: string;
  args: string[];
  canonical: string;
  options?: { cwd?: string; env?: NodeJS.ProcessEnv };
}) {
  const canonicalResult = runResult(canonical, args, options);
  const aliasResult = runResult(alias, args, options);
  const canonicalEvidence = {
    status: canonicalResult.status,
    stderr: canonicalResult.stderr,
    stdout: canonicalResult.stdout,
  };
  const aliasEvidence = {
    status: aliasResult.status,
    stderr: aliasResult.stderr,
    stdout: aliasResult.stdout,
  };
  if (JSON.stringify(canonicalEvidence) !== JSON.stringify(aliasEvidence)) {
    throw new Error(
      `entrypoint parity failed for ${args.join(" ")}: ${JSON.stringify({ alias: aliasEvidence, arashi: canonicalEvidence })}`,
    );
  }
  return canonicalEvidence;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

function verifyInstalledPosixShellBehavior({
  alias,
  canonical,
  env,
  label,
  root,
}: {
  alias: string;
  canonical: string;
  env: NodeJS.ProcessEnv;
  label: string;
  root: string;
}): string[] {
  const workspace = join(root, `${label}-shell-workspace`);
  const repository = join(workspace, "repos", "fixture");
  const target = join(workspace, ".arashi", "worktrees", "fixture", "verify-shell");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, ".arashi"), { recursive: true });
  mkdirSync(repository, { recursive: true });
  writeFileSync(
    join(workspace, ".arashi", "config.json"),
    JSON.stringify({
      repos: { fixture: { path: "repos/fixture" } },
      reposDir: "repos",
      version: "1.0.0",
      worktreesDir: "./.arashi/worktrees",
    }),
  );
  run("git", ["init", "-b", "main"], { cwd: repository, env });
  run("git", ["config", "user.email", "release-verifier@example.com"], {
    cwd: repository,
    env,
  });
  run("git", ["config", "user.name", "Release Verifier"], { cwd: repository, env });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: repository, env });
  writeFileSync(join(repository, "README.md"), "release verifier fixture\n");
  run("git", ["add", "."], { cwd: repository, env });
  run("git", ["commit", "-m", "release verifier fixture"], { cwd: repository, env });
  mkdirSync(dirname(target), { recursive: true });
  run("git", ["worktree", "add", "-b", "verify-shell", target], { cwd: repository, env });
  const exactTarget = realpathSync(target);

  const shellEnvironment = {
    ...env,
    NO_COLOR: "1",
    PATH: `${dirname(canonical)}${delimiter}${env.PATH ?? ""}`,
  };
  const verified: string[] = [];
  for (const shell of ["bash", "zsh", "fish"] as const) {
    const available = runResult(shell, ["--version"], { env: shellEnvironment });
    if (available.status !== 0) {
      throw new Error(`${label} shell verification requires supported shell ${shell}`);
    }
    const initFile = join(root, `${label}-${shell}-init`);
    const completionFile = join(root, `${label}-${shell}-completion`);
    writeFileSync(initFile, run(canonical, ["shell", "init", shell], { env: shellEnvironment }));
    writeFileSync(completionFile, run(canonical, ["completion", shell], { env: shellEnvironment }));
    const quotedInit = shellQuote(initFile);
    const quotedCompletion = shellQuote(completionFile);
    const quotedTarget = shellQuote(exactTarget);
    let args: string[] = [];
    if (shell === "bash") {
      args = [
        "--noprofile",
        "--norc",
        "-c",
        `source ${quotedInit}; source ${quotedCompletion}; aw switch --all --path ${quotedTarget} --cd >/dev/null; [ "$PWD" = ${quotedTarget} ] || exit 31; COMP_WORDS=(aw cr); COMP_CWORD=1; COMPREPLY=(); _arashi; printf '%s\\n' "\${COMPREPLY[@]}" | grep -Fx create >/dev/null`,
      ];
    } else if (shell === "zsh") {
      args = [
        "-f",
        "-c",
        `source ${quotedInit}; source ${quotedCompletion}; aw switch --all --path ${quotedTarget} --cd >/dev/null; [[ "$PWD" == ${quotedTarget} ]] || exit 31; compadd(){ local emit=0 argument; for argument in "$@"; do (( emit )) && print -r -- "$argument"; [[ "$argument" == -- ]] && emit=1; done; }; words=(aw cr); CURRENT=2; _arashi | grep -Fx create >/dev/null`,
      ];
    } else {
      args = [
        "--no-config",
        "-c",
        `source ${quotedInit}; source ${quotedCompletion}; aw switch --all --path ${quotedTarget} --cd >/dev/null; test "$PWD" = ${quotedTarget}; or exit 31; complete -C 'aw cr' | string match -rq '^create(\\t|$)'`,
      ];
    }
    const result = runResult(shell, args, { cwd: workspace, env: shellEnvironment });
    if (result.status !== 0) {
      throw new Error(
        `${label} ${shell} installed shell behavior failed: ${result.stderr || result.stdout}`,
      );
    }
    const resolvedAlias = runResult(alias, ["--version"], { env: shellEnvironment });
    if (resolvedAlias.status !== 0) {
      throw new Error(`${label} ${shell} alias stopped resolving after shell verification`);
    }
    verified.push(shell);
  }
  return verified;
}

const root = mkdtempSync(join(tmpdir(), `arashi-aw-release-${version}-`));
try {
  const shellBehavior: Record<string, string[]> = {};
  const npmCommand = releaseNpmCommand();
  const publicVersion = run(npmCommand, [
    "view",
    `arashi@${version}`,
    "version",
    "--json",
    "--cache",
    join(root, "npm-cache"),
  ]);
  if (JSON.parse(publicVersion) !== version) {
    throw new Error(`npm did not return exact version ${version}`);
  }

  const npmPrefix = join(root, "npm-prefix");
  run(npmCommand, [
    "install",
    "--global",
    "--prefix",
    npmPrefix,
    "--cache",
    join(root, "npm-cache"),
    `arashi@${version}`,
  ]);
  const npmBin = process.platform === "win32" ? npmPrefix : join(npmPrefix, "bin");
  const extension = process.platform === "win32" ? ".cmd" : "";
  const canonical = join(npmBin, `arashi${extension}`);
  const alias = join(npmBin, `aw${extension}`);
  if (process.platform !== "win32") {
    chmodSync(canonical, 0o755);
    chmodSync(alias, 0o755);
  }
  const firstUseCanonicalVersion = run(canonical, ["--version"]);
  if (reportedFinalVersion(firstUseCanonicalVersion) !== version) {
    throw new Error(
      `npm first-use entrypoint does not report exact requested release ${version}: arashi=${firstUseCanonicalVersion}`,
    );
  }
  const canonicalVersion = run(canonical, ["--version"]);
  const aliasVersion = run(alias, ["--version"]);
  if (
    canonicalVersion !== aliasVersion ||
    reportedVersion(canonicalVersion) !== version ||
    reportedVersion(aliasVersion) !== version
  ) {
    throw new Error(
      `npm entrypoint version does not exactly match requested release ${version}: arashi=${canonicalVersion}, aw=${aliasVersion}`,
    );
  }
  assertParity({ alias, args: ["--help"], canonical });
  assertParity({ alias, args: ["status", "--json"], canonical, options: { cwd: root } });
  assertParity({ alias, args: ["shell", "init", "bash"], canonical });
  const canonicalCompletion = run(canonical, ["completion", "bash"]);
  const aliasCompletion = run(alias, ["completion", "bash"]);
  if (
    canonicalCompletion !== aliasCompletion ||
    !aliasCompletion.includes("complete -F _arashi arashi") ||
    !aliasCompletion.includes("complete -F _arashi aw") ||
    !aliasCompletion.includes("arashi-managed-shell-wrapper:aw:v1")
  ) {
    throw new Error("npm completion output does not register guarded identical arashi/aw behavior");
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    shellBehavior.npm = verifyInstalledPosixShellBehavior({
      alias,
      canonical,
      env: process.env,
      label: "npm",
      root,
    });
  }

  if (process.platform === "darwin" || process.platform === "linux") {
    const directDir = join(root, "direct");
    const installer = join(root, "install.sh");
    run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "https://arashi.haphazard.dev/install",
      "--output",
      installer,
    ]);
    const env = {
      ...process.env,
      ARASHI_INSTALL_DIR: directDir,
      ARASHI_NO_MODIFY_PATH: "1",
      ARASHI_SHELL_INTEGRATION: "no",
      ARASHI_VERSION: version,
    };
    run("bash", [installer, "--no-modify-path", "--no-shell-integration"], { env });
    const directCanonical = run(join(directDir, "arashi"), ["--version"], { env });
    const directAlias = run(join(directDir, "aw"), ["--version"], { env });
    if (
      directCanonical !== directAlias ||
      reportedVersion(directCanonical) !== version ||
      reportedVersion(directAlias) !== version
    ) {
      throw new Error(
        `direct entrypoint version does not exactly match requested release ${version}: arashi=${directCanonical}, aw=${directAlias}`,
      );
    }
    const ledger = JSON.parse(
      readFileSync(join(directDir, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    if (ledger.releaseVersion !== version) {
      throw new Error("direct ownership ledger is not tied to the exact version");
    }
    const directEntrypoints = {
      alias: join(directDir, "aw"),
      canonical: join(directDir, "arashi"),
    };
    assertParity({ ...directEntrypoints, args: ["--help"], options: { env } });
    assertParity({
      ...directEntrypoints,
      args: ["status", "--json"],
      options: { cwd: root, env },
    });
    assertParity({
      ...directEntrypoints,
      args: ["shell", "init", "bash"],
      options: { env },
    });
    assertParity({ ...directEntrypoints, args: ["completion", "bash"], options: { env } });
    shellBehavior.direct = verifyInstalledPosixShellBehavior({
      ...directEntrypoints,
      env,
      label: "direct",
      root,
    });
  }

  console.log(
    JSON.stringify(
      { npm: canonicalVersion, ok: true, platform: process.platform, shellBehavior, version },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(root, { force: true, recursive: true });
}
