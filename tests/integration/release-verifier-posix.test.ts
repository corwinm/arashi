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
if [ "$ARASHI_TEST_FIRST_USE_NOISE" = 1 ]; then
  mv "$package_bin/arashi.bin" "$package_bin/arashi.real"
  cat > "$package_bin/arashi.bin" <<'PROXY'
#!/bin/bash
state="\${0}.first-use-complete"
if [ ! -e "$state" ]; then
  : > "$state"
  printf 'downloading exact public binary from /%s/ before first use\n' "$ARASHI_TEST_VERSION"
  if [ "$ARASHI_TEST_FIRST_USE_SKIP_DISPATCH" = 1 ]; then
    exit 0
  fi
fi
exec "$(dirname "$0")/arashi.real" "$@"
PROXY
  chmod +x "$package_bin/arashi.bin"
fi
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
cp "$ARASHI_TEST_ROOT/scripts/uninstall.sh" "$ARASHI_INSTALL_DIR/uninstall.sh"
chmod +x "$ARASHI_INSTALL_DIR/arashi.bin" "$ARASHI_INSTALL_DIR/arashi" "$ARASHI_INSTALL_DIR/aw" "$ARASHI_INSTALL_DIR/uninstall.sh"
digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}
printf '{"schemaVersion":2,"installationChannel":"official-direct","platform":"posix","installDirectory":"%s","files":[{"relativePath":"arashi.bin","role":"native-executable","digest":"%s"},{"relativePath":"arashi","role":"canonical-wrapper","digest":"%s"},{"relativePath":"aw","role":"alias-wrapper","digest":"%s"},{"relativePath":"uninstall.sh","role":"uninstall-helper","digest":"%s"}]}\\n' \
  "$ARASHI_INSTALL_DIR" \
  "$(digest "$ARASHI_INSTALL_DIR/arashi.bin")" \
  "$(digest "$ARASHI_INSTALL_DIR/arashi")" \
  "$(digest "$ARASHI_INSTALL_DIR/aw")" \
  "$(digest "$ARASHI_INSTALL_DIR/uninstall.sh")" \
  > "$ARASHI_INSTALL_DIR/.arashi-managed-entrypoints.json"
if [ "$ARASHI_TEST_CORRUPT_DIRECT_MANIFEST" = 1 ]; then
  printf '# changed after manifest generation\\n' >> "$ARASHI_INSTALL_DIR/uninstall.sh"
fi
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
    ARASHI_TEST_FIRST_USE_NOISE: "1",
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
      `npm first-use entrypoint does not report exact requested release ${version}`,
    );
  }, 30_000);

  test("accepts the current versionless ownership ledger and verifies installed POSIX behavior", () => {
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

  test("rejects a current ownership manifest whose payload digest is stale", () => {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/release/verify-aw.ts"), version],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...environment, ARASHI_TEST_CORRUPT_DIRECT_MANIFEST: "1" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uninstall.sh has a digest mismatch");
  }, 30_000);

  test("accepts pnpm's forwarded argument separator before the exact version", () => {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/release/verify-aw.ts"), "--", version],
      {
        cwd: root,
        encoding: "utf8",
        env: environment,
      },
    );
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  test("rejects first-use installer output that never dispatches the version command", () => {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/release/verify-aw.ts"), version],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...environment, ARASHI_TEST_FIRST_USE_SKIP_DISPATCH: "1" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `npm first-use entrypoint does not report exact requested release ${version}`,
    );
  }, 30_000);
});
