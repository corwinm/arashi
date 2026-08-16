import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
let fixture = "";
let environment: NodeJS.ProcessEnv;

beforeAll(() => {
  if (process.platform === "win32") {
    return;
  }
  fixture = mkdtempSync(join(tmpdir(), "arashi-release-verifier-"));
  const native = join(fixture, "arashi.bin");
  execFileSync("bun", ["build", "src/index.ts", "--compile", "--outfile", native], {
    cwd: root,
    encoding: "utf8",
  });
  chmodSync(native, 0o755);

  execFileSync(
    "npm",
    ["pack", "--cache", join(fixture, "npm-cache"), "--pack-destination", fixture],
    { cwd: root, encoding: "utf8" },
  );
  const archive = join(
    fixture,
    readdirSync(fixture).find((name) => name.endsWith(".tgz")) ?? "missing.tgz",
  );
  const stubBin = join(fixture, "bin");
  execFileSync("mkdir", ["-p", stubBin]);
  const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(stubBin, "npm"),
    `#!/bin/bash
set -e
if [ "$1" = view ]; then
  printf '"%s"\\n' "$ARASHI_TEST_VERSION"
  exit 0
fi
args=()
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix="$2"; args+=("$1" "$2"); shift 2; continue; fi
  case "$1" in arashi@*) args+=("$ARASHI_TEST_ARCHIVE") ;; *) args+=("$1") ;; esac
  shift
done
"$ARASHI_TEST_REAL_NPM" "\${args[@]}"
package_bin="$prefix/lib/node_modules/arashi/bin"
cp "$ARASHI_TEST_NATIVE" "$package_bin/arashi.bin"
chmod +x "$package_bin/arashi.bin"
`,
  );
  chmodSync(join(stubBin, "npm"), 0o755);

  const installer = join(fixture, "install.sh");
  writeFileSync(
    installer,
    `#!/bin/bash
set -e
mkdir -p "$ARASHI_INSTALL_DIR"
cp "$ARASHI_TEST_NATIVE" "$ARASHI_INSTALL_DIR/arashi.bin"
cp "$ARASHI_TEST_ROOT/bin/arashi" "$ARASHI_INSTALL_DIR/arashi"
cp "$ARASHI_TEST_ROOT/bin/aw" "$ARASHI_INSTALL_DIR/aw"
chmod +x "$ARASHI_INSTALL_DIR/arashi.bin" "$ARASHI_INSTALL_DIR/arashi" "$ARASHI_INSTALL_DIR/aw"
printf '{"releaseVersion":"%s"}\\n' "$ARASHI_TEST_VERSION" > "$ARASHI_INSTALL_DIR/.arashi-managed-entrypoints.json"
`,
  );
  chmodSync(installer, 0o755);
  writeFileSync(
    join(stubBin, "curl"),
    `#!/bin/bash
set -e
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output="$2"; shift 2; continue; fi
  shift
done
cp "$ARASHI_TEST_INSTALLER" "$output"
`,
  );
  chmodSync(join(stubBin, "curl"), 0o755);
  environment = {
    ...process.env,
    ARASHI_TEST_ARCHIVE: archive,
    ARASHI_TEST_INSTALLER: installer,
    ARASHI_TEST_NATIVE: native,
    ARASHI_TEST_REAL_NPM: realNpm,
    ARASHI_TEST_ROOT: root,
    ARASHI_TEST_VERSION: version,
    PATH: `${stubBin}${delimiter}${process.env.PATH ?? ""}`,
  };
});

afterAll(() => {
  if (fixture) rmSync(fixture, { force: true, recursive: true });
});

describe.skipIf(process.platform === "win32")("exact-version published release verifier", () => {
  test("rejects an npm entrypoint whose parsed version only contains the requested version as a substring", () => {
    const mismatchedNative = join(fixture, "arashi-mismatched.bin");
    writeFileSync(mismatchedNative, `#!/bin/sh\nprintf '1${version}\\n'\n`);
    chmodSync(mismatchedNative, 0o755);
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/release/verify-aw.ts"), version],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...environment, ARASHI_TEST_NATIVE: mismatchedNative },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `npm entrypoint version does not exactly match requested release ${version}`,
    );
  }, 30_000);

  test("sources installed integration and executes real switch --cd and completion in every POSIX shell", () => {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/release/verify-aw.ts"), version],
      {
        cwd: root,
        encoding: "utf8",
        env: environment,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.shellBehavior).toEqual({
      direct: ["bash", "zsh", "fish"],
      npm: ["bash", "zsh", "fish"],
    });
  }, 30_000);
});
