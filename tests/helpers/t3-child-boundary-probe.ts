import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  nativeChildEnvironment,
  readT3CliVersion,
  withOwnedT3Session,
  withT3Session,
} from "../../src/lib/t3-native.ts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

// Application and owned fixture both run under Bun; no real T3 installation is used.
if (!process.versions.bun) {
  throw new Error("Bun application boundary required");
}
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "arashi-child-boundary-"));
const cwd = join(root, "checkout 'quoted' \"double\" space");
const baseDir = join(root, "profile 'quoted' \"double\" $(touch shell-marker)");
const cli = join(root, "t3 'quoted' \"double\" executable");
const ledgerPath = join(root, "ledger.jsonl");
const directive = join(root, "directive");
const parentCwd = process.cwd();
const oldDirective = process.env.ARASHI_DIRECTIVE_FILE;
const oldProfile = process.env.T3CODE_HOME;
try {
  await mkdir(cwd);
  await mkdir(baseDir);
  await writeFile(directive, "unchanged directory directive\n");
  const issue = [
    "auth",
    "session",
    "issue",
    "--base-dir",
    baseDir,
    "--ttl",
    "5m",
    "--label",
    "Arashi readiness",
    "--json",
  ];
  const legacyIssue = issue.map((arg) => (arg === "Arashi readiness" ? "Arashi handoff" : arg));
  const revoke = ["auth", "session", "revoke", "fixture-session", "--base-dir", baseDir];
  const list = ["auth", "session", "list", "--base-dir", baseDir, "--json"];
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const allowed = ${JSON.stringify([["--version"], issue, legacyIssue, revoke, list])};
const match = allowed.findIndex((value) => JSON.stringify(value) === JSON.stringify(argv));
const cliExact = process.argv[1] === ${JSON.stringify(cli)};
const cwdExact = process.cwd() === ${JSON.stringify(cwd)};
const profileExact = process.env.T3CODE_HOME === ${JSON.stringify(baseDir)};
const isolated = !Object.keys(process.env).includes('ARASHI_DIRECTIVE_FILE');
if (match < 0 || !cliExact || !cwdExact || !profileExact || !isolated) {
  appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({ denied: true }) + '\\n');
  process.exit(73);
}
const operation = match === 0 ? 'version' : match < 3 ? 'issue' : match === 3 ? 'revoke' : 'list';
// Allowlisted argv/CWD and environment KEYS only; never output credentials or bodies.
appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({ operation, argv: [process.argv[1], ...argv], cliExact, cwd: process.cwd(), cwdExact, profileExact, envKeys: Object.keys(process.env).sort() }) + '\\n');
if (operation === 'version') console.log('t3 v0.0.43');
else if (operation === 'issue') console.log(JSON.stringify({ sessionId: 'fixture-session', token: 'fixture-only-token' }));
else if (operation === 'list') console.log('[]');
else console.log('revoked');
`,
  );
  await chmod(cli, 0o700);
  // Calibrate the marker with an explicitly shell-interpreted, owned command.
  await run("/bin/sh", ["-c", ': "$(touch shell-marker)"'], { cwd });
  const shellCalibrated = (await readFile(join(cwd, "shell-marker"))).length === 0;
  await rm(join(cwd, "shell-marker"));
  process.env.ARASHI_DIRECTIVE_FILE = directive;
  process.env.T3CODE_HOME = baseDir;
  const environment = { baseDir, cli, origin: "http://127.0.0.1:3773" };
  try {
    await run(cli, ["--version"], { cwd, env: nativeChildEnvironment({ T3CODE_HOME: baseDir }) });
  } catch {
    throw new Error("fixture startup calibration failed");
  }
  await writeFile(ledgerPath, "");
  if ((await readT3CliVersion(cli, cwd)) !== "0.0.43") {
    throw new Error("ordinary version failed");
  }
  if (
    (await readT3CliVersion(
      cli,
      cwd,
      { readiness: { deadline: performance.now() + 15_000 } },
      { T3CODE_HOME: baseDir },
    )) !== "0.0.43"
  ) {
    throw new Error("bounded version failed");
  }
  const owned = await withOwnedT3Session(environment, cwd, {}, async () => "used");
  if (owned.use.status !== "succeeded" || owned.cleanup.status !== "verified") {
    throw new Error("owned lifecycle failed");
  }
  if ((await withT3Session(environment, cwd, {}, async () => "used")) !== "used") {
    throw new Error("legacy lifecycle failed");
  }
  const env = nativeChildEnvironment({ T3CODE_HOME: baseDir });
  for (const options of [
    { argv: ["--help"], cwd, env },
    { argv: ["--version"], cwd: root, env },
    { argv: ["--version"], cwd, env: { ...env, T3CODE_HOME: root } },
    { argv: ["--version"], cwd, env: { ...env, ARASHI_DIRECTIVE_FILE: directive } },
  ]) {
    let denied = false;
    try {
      await run(cli, options.argv, { cwd: options.cwd, env: options.env });
    } catch (error) {
      denied = (error as { code?: number }).code === 73;
    }
    if (!denied) {
      throw new Error("strict fixture did not deny boundary violation");
    }
  }
  const rows = (await readFile(ledgerPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const ledger = rows.filter((row) => !row.denied);
  let shellMarkerAbsent = false;
  try {
    await readFile(join(cwd, "shell-marker"));
  } catch (error) {
    shellMarkerAbsent = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  console.log(
    JSON.stringify({
      denied: rows.filter((row) => row.denied).length,
      directiveUnchanged: (await readFile(directive, "utf8")) === "unchanged directory directive\n",
      executableHash: createHash("sha256")
        .update(await readFile(cli))
        .digest("hex"),
      ledger,
      operations: ledger.map((row) => row.operation),
      parentCwdUnchanged: process.cwd() === parentCwd,
      runtime: "bun",
      runtimeVersion: process.versions.bun,
      shellCalibrated,
      shellMarkerAbsent,
    }),
  );
} finally {
  if (oldDirective === undefined) {
    delete process.env.ARASHI_DIRECTIVE_FILE;
  } else {
    process.env.ARASHI_DIRECTIVE_FILE = oldDirective;
  }
  if (oldProfile === undefined) {
    delete process.env.T3CODE_HOME;
  } else {
    process.env.T3CODE_HOME = oldProfile;
  }
  await rm(root, { force: true, recursive: true });
}
