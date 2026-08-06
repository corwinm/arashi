import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repositoryRoot, "src/index.ts");
const sensitiveRepository = "quote'glob*[x]\\slash\tline\nnext";
const sensitiveRepositoryBase64 = Buffer.from(sensitiveRepository).toString("base64");
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const available = (command: string): boolean =>
  process.platform !== "win32" &&
  spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;

let temporaryRoot = "";
let outsideRoot = "";
let workspaceRoot = "";
let homeRoot = "";
let environment: NodeJS.ProcessEnv;
let initialWorkspaceState = "";
const completionFiles = new Map<string, string>();

const sections = (stdout: string): Map<string, string[]> => {
  const result = new Map<string, string[]>();
  let active: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) {
      active = line.slice(2);
      result.set(active, []);
    } else if (active && line) {
      result.get(active)!.push(line);
    }
  }
  return result;
};

const candidateValues = (lines: string[]): string[] =>
  lines.map((line) => Buffer.from(line.split("\t")[0], "base64").toString());

const workspaceState = (): string => {
  const repositories = [
    workspaceRoot,
    join(workspaceRoot, "repos", "repo one"),
    join(workspaceRoot, "repos", "repo-one"),
  ];
  const git = (cwd: string, arguments_: string[]) =>
    spawnSync("git", arguments_, { cwd, encoding: "utf8" }).stdout;
  return JSON.stringify({
    config: readFileSync(join(workspaceRoot, ".arashi", "config.json"), "utf8"),
    repositories: repositories.map((repository) => ({
      refs: git(repository, ["show-ref"]),
      status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
      worktrees: git(repository, ["worktree", "list", "--porcelain"]),
    })),
    startupFiles: [".bashrc", ".zshrc", ".config/fish/config.fish"].map((path) => {
      const absolute = join(homeRoot, path);
      return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    }),
  });
};

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "arashi-real-shell-completion-"));
  outsideRoot = join(temporaryRoot, "outside");
  workspaceRoot = join(temporaryRoot, "workspace");
  homeRoot = join(temporaryRoot, "home");
  mkdirSync(outsideRoot);
  mkdirSync(homeRoot);
  mkdirSync(join(homeRoot, ".config", "fish"), { recursive: true });
  writeFileSync(join(homeRoot, ".config", "fish", "config.fish"), "");
  mkdirSync(join(workspaceRoot, ".arashi"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, ".arashi", "config.json"),
    JSON.stringify({
      repos: {
        "repo one": { groups: ["docs team"], path: "repos/repo one" },
        "repo-one": { groups: ["docs-team"], path: "repos/repo-one" },
        [sensitiveRepository]: { path: "repos/repo one" },
      },
      reposDir: "repos",
      version: "1.0.0",
    }),
  );
  for (const repository of [
    workspaceRoot,
    join(workspaceRoot, "repos", "repo one"),
    join(workspaceRoot, "repos", "repo-one"),
  ]) {
    mkdirSync(repository, { recursive: true });
    const initialized = spawnSync("git", ["init"], { cwd: repository, encoding: "utf8" });
    expect(initialized.status, initialized.stderr).toBe(0);
  }

  const shimPath = join(temporaryRoot, "arashi");
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
  environment = {
    ...process.env,
    HOME: homeRoot,
    NO_COLOR: "1",
    PATH: `${temporaryRoot}${delimiter}${process.env.PATH ?? ""}`,
    SENSITIVE_REPOSITORY_BASE64: sensitiveRepositoryBase64,
    XDG_CONFIG_HOME: join(homeRoot, ".config"),
  };
  for (const shell of ["bash", "zsh", "fish"]) {
    const generated = spawnSync(process.execPath, [cliPath, "completion", shell], {
      cwd: outsideRoot,
      encoding: "utf8",
      env: environment,
    });
    expect(generated.status).toBe(0);
    expect(generated.stderr).toBe("");
    const path = join(temporaryRoot, `arashi.${shell}`);
    writeFileSync(path, generated.stdout);
    completionFiles.set(shell, path);
  }
  initialWorkspaceState = workspaceState();
});

afterAll(() => {
  if (workspaceRoot) expect(workspaceState()).toBe(initialWorkspaceState);
  if (temporaryRoot) rmSync(temporaryRoot, { force: true, recursive: true });
});

describe("generated completion in clean real shell sessions", () => {
  test.skipIf(!available("bash"))(
    "Bash preserves wrapper registration and static, conflict, boundary, and dynamic behavior",
    () => {
      const script = `
source ${shellQuote(completionFiles.get("bash")!)}
complete -p arashi >/dev/null || exit 8
run_completion() {
  local label="$1"
  shift
  printf '@@%s\\n' "$label"
  COMP_WORDS=("$@")
  COMP_CWORD=$(($# - 1))
  COMPREPLY=()
  _arashi
  printf '%s\\n' "\${COMPREPLY[@]}"
}
run_sensitive_completion() {
  local label="$1"
  shift
  printf '@@%s\\n' "$label"
  COMP_WORDS=("$@")
  COMP_CWORD=$(($# - 1))
  COMPREPLY=()
  _arashi
  for candidate in "\${COMPREPLY[@]}"; do
    printf '%s' "$candidate" | base64
    printf '\\n'
  done
}
cd ${shellQuote(outsideRoot)}
run_completion directRoot arashi cr
run_completion nested arashi shell i
run_completion shortOption arashi create topic -
eval "$(command arashi shell init bash)"
declare -F arashi >/dev/null || exit 9
run_completion wrappedRoot arashi cr
run_completion choice arashi completion b
run_completion conflict arashi create topic --tmux ''
run_completion boundary arashi create topic -- ''
run_completion variadic arashi exec printf ''
cd ${shellQuote(workspaceRoot)}
run_completion repository arashi create topic --only repo
run_completion repositoryShort arashi create topic -o repo
run_completion group arashi create topic --group docs
run_completion groupShort arashi create topic -g docs
run_completion inlineAssignmentEmpty arashi create topic --conflict =
run_completion inlineAssignment arashi create topic --conflict = R
run_completion switch arashi switch repo
run_completion switchRepos arashi switch --repos repo
run_completion remove arashi remove repo
run_completion moveFrom arashi move --from repo
run_completion moveTo arashi move --to repo
run_completion path arashi switch --path ''
run_sensitive_completion sensitive arashi create topic --only ''
`;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8",
        env: environment,
      });
      expect(result.status, result.stderr).toBe(0);
      const output = sections(result.stdout);
      const quotedSensitive = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-c", "printf '%q' \"$1\"", "bash", sensitiveRepository],
        { encoding: "utf8" },
      ).stdout;
      const quotedSensitiveBase64 = Buffer.from(quotedSensitive).toString("base64");
      expect(output.get("directRoot")).toContain("create");
      expect(output.get("directRoot")).not.toContain("__query");
      expect(output.get("wrappedRoot")).toContain("create");
      expect(output.get("nested")).toContain("init");
      expect(output.get("shortOption")).toContain("-o");
      expect(output.get("choice")).toEqual(["bash"]);
      expect(output.get("conflict")).toContain("--dry-run");
      expect(output.get("conflict")).not.toEqual(expect.arrayContaining(["--herdr", "--sesh"]));
      expect(output.get("boundary")).toEqual([]);
      expect(output.get("variadic")).toEqual([]);
      for (const label of ["repository", "repositoryShort", "switchRepos"])
        expect(output.get(label)).toContain("repo\\ one");
      expect(output.get("group")).toContain("docs\\ team");
      expect(output.get("groupShort")).toContain("docs\\ team");
      expect(output.get("inlineAssignmentEmpty")).toEqual([
        "--conflict=ABORT",
        "--conflict=REUSE_EXISTING",
      ]);
      expect(output.get("inlineAssignment")).toEqual(["--conflict=REUSE_EXISTING"]);
      expect(output.get("path")?.every((value) => value.startsWith("/"))).toBe(true);
      expect(output.get("sensitive")).toContain(quotedSensitiveBase64);
    },
  );

  test.skipIf(!available("zsh"))(
    "Zsh preserves compsys registration, descriptions, and equivalent completion behavior",
    () => {
      const script = `
source ${shellQuote(completionFiles.get("zsh")!)}
[[ "$_comps[arashi]" == _arashi ]] || exit 9
compadd() {
  local emit=0 argument description
  for description in "\${descriptions[@]}"; do print -r -- "description:$description"; done
  for argument in "$@"; do
    if (( emit )); then
      if (( ENCODE_VALUES )); then
        printf '%s' "$argument" | base64
        printf '\\n'
      else
        print -r -- "$argument"
      fi
    fi
    [[ "$argument" == -- ]] && emit=1
  done
  return 0
}
run_completion() {
  local label="$1"
  shift
  print -r -- "@@$label"
  words=("$@")
  CURRENT=$#
  _arashi
}
run_sensitive_completion() {
  local label="$1"
  shift
  print -r -- "@@$label"
  words=("$@")
  CURRENT=$#
  ENCODE_VALUES=1
  _arashi
  ENCODE_VALUES=0
}
cd ${shellQuote(outsideRoot)}
run_completion directRoot arashi cr
run_completion nested arashi shell i
run_completion shortOption arashi create topic -
eval "$(command arashi shell init zsh)"
(( $+functions[arashi] )) || exit 8
run_completion wrappedRoot arashi cr
run_completion choice arashi completion b
run_completion conflict arashi create topic --tmux ''
run_completion boundary arashi create topic -- ''
run_completion variadic arashi exec printf ''
cd ${shellQuote(workspaceRoot)}
run_completion repository arashi create topic --only repo
run_completion repositoryShort arashi create topic -o repo
run_completion group arashi create topic --group docs
run_completion groupShort arashi create topic -g docs
run_completion switch arashi switch repo
run_completion switchRepos arashi switch --repos repo
run_completion remove arashi remove repo
run_completion moveFrom arashi move --from repo
run_completion moveTo arashi move --to repo
run_completion path arashi switch --path ''
run_sensitive_completion sensitive arashi create topic --only ''
`;
      const result = spawnSync("zsh", ["-f", "-c", script], {
        encoding: "utf8",
        env: environment,
      });
      expect(result.status, result.stderr).toBe(0);
      const output = sections(result.stdout);
      expect(output.get("directRoot")).toContain("create");
      expect(output.get("directRoot")?.some((line) => line.startsWith("description:"))).toBe(true);
      expect(output.get("wrappedRoot")).toContain("create");
      expect(output.get("nested")).toContain("init");
      expect(output.get("shortOption")).toContain("-o");
      expect(output.get("choice")).toContain("bash");
      expect(output.get("conflict")).toContain("--dry-run");
      expect(output.get("conflict")).not.toEqual(expect.arrayContaining(["--herdr", "--sesh"]));
      expect(output.get("boundary")).toEqual([]);
      expect(output.get("variadic")).toEqual([]);
      for (const label of ["repository", "repositoryShort", "switchRepos"])
        expect(output.get(label)).toContain("repo one");
      expect(output.get("group")).toContain("docs team");
      expect(output.get("groupShort")).toContain("docs team");
      expect(
        output
          .get("path")
          ?.filter((value) => !value.startsWith("description:"))
          .every((value) => value.startsWith("/")),
      ).toBe(true);
      expect(output.get("sensitive")).toContain(sensitiveRepositoryBase64);
    },
  );

  test.skipIf(!available("fish"))(
    "Fish preserves wrapper registration, descriptions, and equivalent completion behavior",
    () => {
      const script = `
source ${shellQuote(completionFiles.get("fish")!)}
function run_completion
    set -l label $argv[1]
    set -l command_line $argv[2]
    printf '@@%s\\n' "$label"
    for candidate_record in (complete -C "$command_line")
        set -l fields (string split -m 1 \\t -- "$candidate_record")
        set -l candidate (string unescape -- "$fields[1]" | string collect)
        set -l encoded (node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64"))' -- "$candidate")
        printf '%s\\t%s\\n' "$encoded" "$fields[2]"
    end
end
cd ${shellQuote(outsideRoot)}
run_completion directRoot 'arashi cr'
run_completion nested 'arashi shell i'
run_completion shortOption 'arashi create topic -'
command arashi shell init fish | source
functions -q arashi; or exit 8
run_completion wrappedRoot 'arashi cr'
run_completion choice 'arashi completion b'
run_completion conflict 'arashi create topic --tmux '
run_completion boundary 'arashi create topic -- '
run_completion variadic 'arashi exec printf '
cd ${shellQuote(workspaceRoot)}
run_completion repository 'arashi create topic --only repo'
run_completion repositoryShort 'arashi create topic -o repo'
run_completion group 'arashi create topic --group docs'
run_completion groupShort 'arashi create topic -g docs'
run_completion switch 'arashi switch repo'
run_completion switchRepos 'arashi switch --repos repo'
run_completion remove 'arashi remove repo'
run_completion moveFrom 'arashi move --from repo'
run_completion moveTo 'arashi move --to repo'
run_completion path 'arashi switch --path '
run_completion sensitive 'arashi create topic --only '
`;
      const result = spawnSync("fish", ["--no-config", "-c", script], {
        encoding: "utf8",
        env: environment,
      });
      expect(result.status, result.stderr).toBe(0);
      const output = sections(result.stdout);
      expect(candidateValues(output.get("directRoot") ?? [])).toContain("create");
      expect(output.get("directRoot")?.some((line) => line.includes("\t"))).toBe(true);
      expect(candidateValues(output.get("wrappedRoot") ?? [])).toContain("create");
      expect(candidateValues(output.get("nested") ?? [])).toContain("init");
      expect(candidateValues(output.get("shortOption") ?? [])).toContain("-o");
      expect(candidateValues(output.get("choice") ?? [])).toContain("bash");
      expect(candidateValues(output.get("conflict") ?? [])).toContain("--dry-run");
      expect(candidateValues(output.get("conflict") ?? [])).not.toEqual(
        expect.arrayContaining(["--herdr", "--sesh"]),
      );
      expect(output.get("boundary")).toEqual([]);
      expect(output.get("variadic")).toEqual([]);
      for (const label of ["repository", "repositoryShort", "switchRepos"])
        expect(candidateValues(output.get(label) ?? [])).toContain("repo one");
      expect(candidateValues(output.get("group") ?? [])).toContain("docs team");
      expect(candidateValues(output.get("groupShort") ?? [])).toContain("docs team");
      expect(
        candidateValues(output.get("path") ?? []).every((value) => value.startsWith("/")),
      ).toBe(true);
      expect(candidateValues(output.get("sensitive") ?? [])).toContain(sensitiveRepository);
      expect(output.get("switch")?.every((line) => line.split("\t").length === 2)).toBe(true);
    },
  );
});
