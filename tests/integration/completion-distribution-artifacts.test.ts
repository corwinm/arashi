import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const supported =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" && process.arch === "x64");

let fixtureRoot = "";
let packageRoot = "";
let npmEntrypoint = "";
let npmShim = "";
let standaloneBinary = "";
let installedBinary = "";
let firstUseRunner = "";

const run = (command: string, arguments_: string[], cwd = repositoryRoot) =>
  spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30_000,
  });

beforeAll(() => {
  if (!supported) return;
  fixtureRoot = mkdtempSync(join(tmpdir(), "arashi-completion-distribution-"));

  const build = run("corepack", ["pnpm", "--ignore-workspace", "run", "build"]);
  expect(build.status, build.stderr || build.stdout).toBe(0);
  standaloneBinary = join(repositoryRoot, "bin", "arashi.bin");
  expect(existsSync(standaloneBinary)).toBe(true);

  const pack = run("corepack", [
    "pnpm",
    "--ignore-workspace",
    "pack",
    "--pack-destination",
    fixtureRoot,
  ]);
  expect(pack.status, pack.stderr || pack.stdout).toBe(0);
  const archive = join(
    fixtureRoot,
    readdirSync(fixtureRoot).find((name) => name.endsWith(".tgz")) ?? "missing.tgz",
  );
  expect(existsSync(archive)).toBe(true);

  writeFileSync(join(fixtureRoot, "package.json"), '{"name":"fixture","private":true}');
  const install = run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
    fixtureRoot,
  );
  expect(install.status, install.stderr || install.stdout).toBe(0);

  packageRoot = join(fixtureRoot, "node_modules", "arashi");
  npmEntrypoint = join(packageRoot, "bin", "arashi.js");
  npmShim = join(fixtureRoot, "node_modules", ".bin", "arashi");
  const platformBinaryName =
    process.platform === "darwin" ? "arashi-macos-arm64" : "arashi-linux-x64";
  installedBinary = join(packageRoot, "bin", platformBinaryName);
  expect(existsSync(installedBinary)).toBe(false);

  firstUseRunner = join(fixtureRoot, "first-use.mjs");
  writeFileSync(
    firstUseRunner,
    `import { copyFile } from "node:fs/promises";
import { runEntrypoint } from ${JSON.stringify(pathToFileURL(npmEntrypoint).href)};
import { installBinary } from ${JSON.stringify(
      pathToFileURL(join(packageRoot, "bin", "install-binary.js")).href,
    )};
const fixtureBinary = ${JSON.stringify(standaloneBinary)};
process.exitCode = await runEntrypoint(process.argv.slice(2), {
  installBinaryImpl: (options) => installBinary({
    ...options,
    downloadFileImpl: async (_url, destination) => copyFile(fixtureBinary, destination),
  }),
});
`,
  );
}, 30_000);

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { force: true, recursive: true });
});

describe.skipIf(!supported).sequential("packed npm and standalone completion distributions", () => {
  test("installs a missing binary on first completion use without contaminating stdout", () => {
    const expected = run(standaloneBinary, ["completion", "bash"], fixtureRoot);
    expect(expected.status, expected.stderr).toBe(0);
    expect(expected.stderr).toBe("");

    const firstUse = run(process.execPath, [firstUseRunner, "completion", "bash"], fixtureRoot);
    expect(firstUse.status, firstUse.stderr).toBe(0);
    expect(firstUse.stderr).toBe("");
    expect(firstUse.stdout).toBe(expected.stdout);
    expect(existsSync(installedBinary)).toBe(true);
  }, 30_000);

  test.each(["bash", "zsh", "fish"])(
    "emits identical %s completion from the npm shim and standalone binary",
    (shell) => {
      const standalone = run(standaloneBinary, ["completion", shell], fixtureRoot);
      const npm = run(npmShim, ["completion", shell], fixtureRoot);
      expect(standalone.status, standalone.stderr).toBe(0);
      expect(npm.status, npm.stderr).toBe(0);
      expect(standalone.stderr).toBe("");
      expect(npm.stderr).toBe("");
      expect(npm.stdout).toBe(standalone.stdout);
      expect(npm.stdout.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
