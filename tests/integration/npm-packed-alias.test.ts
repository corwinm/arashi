import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const fixtures: string[] = [];
let prefix = "";
let binDirectory = "";
let packageBin = "";

beforeAll(() => {
  const packDir = mkdtempSync(join(tmpdir(), "arashi-aw-pack-"));
  prefix = mkdtempSync(join(tmpdir(), "arashi-aw-prefix-"));
  fixtures.push(packDir, prefix);
  execFileSync(
    "npm",
    ["pack", "--cache", join(packDir, "npm-cache"), "--pack-destination", packDir],
    { cwd: root, encoding: "utf8" },
  );
  const filename = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (!filename) throw new Error("npm pack did not create an archive");
  execFileSync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--cache",
      join(prefix, "npm-cache"),
      join(packDir, filename),
    ],
    { encoding: "utf8" },
  );
  binDirectory = process.platform === "win32" ? prefix : join(prefix, "bin");
  packageBin = join(
    prefix,
    process.platform === "win32" ? "node_modules/arashi/bin" : "lib/node_modules/arashi/bin",
  );
});

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { force: true, recursive: true });
});

function shim(name: "arashi" | "aw"): string {
  return join(binDirectory, process.platform === "win32" ? `${name}.cmd` : name);
}

function runName(name: "arashi" | "aw", args: string[], env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", name, ...args], {
      encoding: "utf8",
      env,
    });
  }
  return spawnSync(name, args, { encoding: "utf8", env });
}

function evidence(result: ReturnType<typeof spawnSync>) {
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function writeNativeFixture(): string {
  const source = join(prefix, "native-fixture.ts");
  const binary = join(packageBin, process.platform === "win32" ? "arashi.bin.exe" : "arashi.bin");
  writeFileSync(
    source,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
switch (args[0]) {
  case "--version": console.log("1.30.0"); break;
  case "--help": console.log("Usage: arashi"); break;
  case "human": console.log("human success"); break;
  case "json": console.log(JSON.stringify({ command: "fixture", ok: true })); break;
  case "fail": console.error("human failure"); process.exitCode = 17; break;
  case "fail-json": console.log(JSON.stringify({ command: "fixture", error: { code: "FIXTURE_FAILURE" }, ok: false })); process.exitCode = 17; break;
  case "mutate": appendFileSync(process.env.ARASHI_MUTATION_FILE, "x"); console.log("mutated"); break;
  default: console.log("native:" + args.join(" "));
}
`,
  );
  execFileSync("bun", ["build", source, "--compile", "--outfile", binary], { encoding: "utf8" });
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  return binary;
}

describe.sequential("packed npm canonical and alias shims", () => {
  test("global installation generates ordinary platform shims to one JavaScript entrypoint", () => {
    expect(existsSync(shim("arashi"))).toBe(true);
    expect(existsSync(shim("aw"))).toBe(true);
    if (process.platform === "win32") {
      expect(shim("arashi")).not.toBe(shim("aw"));
      for (const name of ["arashi", "aw"] as const) {
        expect(readFileSync(shim(name), "utf8").replaceAll("\\", "/")).toContain(
          "node_modules/arashi/bin/arashi.js",
        );
      }
    } else {
      expect(readlinkSync(shim("arashi"))).toBe(readlinkSync(shim("aw")));
      expect(readlinkSync(shim("aw"))).toMatch(/bin\/arashi\.js$/);
    }
  });

  test("real generated shims preserve version, help, human/JSON success and failure, and mutation parity", () => {
    writeNativeFixture();
    const mutation = join(prefix, "mutation");
    const env = {
      ...process.env,
      ARASHI_MUTATION_FILE: mutation,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
    };
    for (const args of [["--version"], ["--help"], ["human"], ["json"], ["fail"], ["fail-json"]]) {
      expect(evidence(runName("aw", args, env))).toEqual(evidence(runName("arashi", args, env)));
    }
    expect(JSON.parse(runName("aw", ["json"], env).stdout as string)).toEqual({
      command: "fixture",
      ok: true,
    });
    expect(runName("aw", ["fail"], env).status).toBe(17);
    for (const name of ["arashi", "aw"] as const) {
      expect(runName(name, ["mutate"], env).status).toBe(0);
    }
    expect(readFileSync(mutation, "utf8")).toBe("xx");
  });

  test("both real shims share first-use, explicit install, and human/JSON update boundaries", () => {
    const compiledFixture = writeNativeFixture();
    const nativeFixture = join(prefix, process.platform === "win32" ? "native.exe" : "native");
    copyFileSync(compiledFixture, nativeFixture);
    const installModule = join(packageBin, "install-binary.js");
    const updateModule = join(packageBin, "update.js");
    const originalInstall = readFileSync(installModule, "utf8");
    const originalUpdate = readFileSync(updateModule, "utf8");
    const record = join(prefix, "wrapper-record");
    const updateMutation = join(prefix, "update-mutation");
    const defaultBinary = join(
      packageBin,
      process.platform === "win32" ? "arashi.bin.exe" : "arashi.bin",
    );
    const platformBinary = join(
      packageBin,
      process.platform === "win32"
        ? "arashi-windows-x64.exe"
        : process.platform === "darwin"
          ? "arashi-macos-arm64"
          : "arashi-linux-x64",
    );
    try {
      writeFileSync(
        installModule,
        `import { appendFileSync, chmodSync, copyFileSync } from "node:fs"; import { join } from "node:path";
export function getPlatformInfo(){ const isWindows=process.platform === "win32"; const binaryName=isWindows ? "arashi-windows-x64.exe" : process.platform === "darwin" ? "arashi-macos-arm64" : "arashi-linux-x64"; return { binaryName, isWindows }; }
export function formatInstallError(error){ return String(error); }
export async function installBinary(options={}) { const info=getPlatformInfo(); appendFileSync(process.env.ARASHI_RECORD, "install\\n"); const path=join(options.binDir,info.binaryName); copyFileSync(process.env.ARASHI_NATIVE_FIXTURE,path); if(!info.isWindows) chmodSync(path,0o755); return { status:"installed", version:"1.30.0" }; }
`,
      );
      writeFileSync(
        updateModule,
        `import { appendFileSync } from "node:fs";
export async function runNpmManagedUpdate(argv){ appendFileSync(process.env.ARASHI_RECORD, "update:"+argv.join(" ")+"\\n"); const json=argv.includes("--json"); if(argv.includes("--conflict")){ if(json) console.log(JSON.stringify({command:"update",error:{code:"OPTION_CONFLICT"},ok:false})); else console.error("conflict"); return 2; } if(argv.includes("--apply")) appendFileSync(process.env.ARASHI_UPDATE_MUTATION,"x"); if(json) console.log(JSON.stringify({command:"update",ok:true,plan:["npm"],applied:argv.includes("--apply")})); else console.log(argv.includes("--apply") ? "applied npm update" : "planned npm update"); return 0; }
`,
      );
      const env = {
        ...process.env,
        ARASHI_NATIVE_FIXTURE: nativeFixture,
        ARASHI_RECORD: record,
        ARASHI_UPDATE_MUTATION: updateMutation,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      };

      for (const name of ["arashi", "aw"] as const) {
        rmSync(defaultBinary, { force: true });
        rmSync(platformBinary, { force: true });
        const firstUse = runName(name, ["human"], env);
        expect(firstUse.status, firstUse.stderr as string).toBe(0);
        expect(firstUse.stdout).toContain("human success");

        const install = runName(name, ["install", "--json"], env);
        expect(install.status, install.stderr as string).toBe(0);
        expect(JSON.parse(install.stdout as string)).toMatchObject({
          command: "install",
          ok: true,
        });
      }

      for (const args of [
        ["update", "--check"],
        ["update", "--check", "--json"],
        ["update", "--conflict"],
        ["update", "--conflict", "--json"],
        ["update", "--apply"],
        ["update", "--apply", "--json"],
      ]) {
        expect(evidence(runName("aw", args, env))).toEqual(evidence(runName("arashi", args, env)));
      }
      expect(runName("aw", ["update", "--conflict"], env).status).toBe(2);
      expect(readFileSync(updateMutation, "utf8")).toBe("xxxx");
      expect(readFileSync(record, "utf8").match(/^install$/gm)).toHaveLength(4);
    } finally {
      writeFileSync(installModule, originalInstall);
      writeFileSync(updateModule, originalUpdate);
    }
  });
});
