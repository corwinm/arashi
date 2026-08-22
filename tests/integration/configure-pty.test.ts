import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const helper = join(root, "tests/helpers/configure-pty.mjs");
const roots: string[] = [];
const down = "\x1b[B";
const enter = "\r";
type Interaction = { waitFor: string; bytes: string; replaceConfig?: string };

const journey = async (
  interactions: Interaction[],
  config: Record<string, unknown> = {},
  options: { expectedStatus?: number; setup?: (workspace: string) => Promise<void> } = {},
) => {
  const workspace = await mkdtemp(join(tmpdir(), "arashi-configure-pty-"));
  roots.push(workspace);
  const configPath = join(workspace, ".arashi", "config.json");
  await mkdir(join(workspace, ".arashi"), { recursive: true });
  const original = JSON.stringify(
    { version: "1.0.0", reposDir: "repos", repos: { app: { path: "repos/app" } }, ...config },
    null,
    2,
  );
  await writeFile(configPath, original);
  await options.setup?.(workspace);
  const encoded = Buffer.from(JSON.stringify({ configPath, interactions, workspace })).toString(
    "base64",
  );
  const result = spawnSync(process.execPath, [helper, root, encoded], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(options.expectedStatus ?? 0);
  const ansiPattern = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  const transcript = Buffer.from(result.stdout, "base64")
    .toString("utf8")
    .replaceAll("\r", "")
    .replaceAll(ansiPattern, "");
  return {
    bytes: await readFile(configPath, "utf8"),
    config: JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>,
    configPath,
    original,
    transcript,
    workspace,
  };
};

afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe.skipIf(process.platform === "win32")("configure raw PTY journeys", () => {
  const downs = (count: number) => down.repeat(count);

  test.each([
    ["workspace settings", 0, "Choose setting in workspace-settings:"],
    ["workspace hooks", 1, "Choose setting in workspace-hooks:"],
    ["command defaults", 2, "Choose setting in command-defaults:"],
    ["editor defaults", 3, "Choose setting in editor-defaults:"],
    ["meta policy", 4, "Choose setting in meta-policy:"],
    ["repository", 5, "Choose configured repository:"],
  ] as const)("selects the supported %s scope with raw bytes", async (_name, index, nextPrompt) => {
    const result = await journey([
      { waitFor: "Choose configuration scope:", bytes: downs(index) + enter },
      { waitFor: nextPrompt, bytes: "\x03" },
    ]);
    expect(result.bytes).toBe(result.original);
  });

  test("keep-only reports no changes before final confirmation and preserves bytes", async () => {
    const result = await journey([
      { bytes: enter, waitFor: "Choose configuration scope:" },
      { bytes: enter, waitFor: "Choose setting in workspace-settings:" },
      { bytes: enter, waitFor: "Choose action for reposDir:" },
      { bytes: enter, waitFor: "Edit another setting?" },
    ]);
    expect(result.bytes).toBe(result.original);
    expect(result.transcript).toContain("No configuration changes.");
    expect(result.transcript).not.toContain("Apply this workspace configuration?");
  });

  test("final decline preserves the original bytes", async () => {
    const result = await journey([
      { bytes: enter, waitFor: "Choose configuration scope:" },
      { bytes: enter, waitFor: "Choose setting in workspace-settings:" },
      { bytes: down + enter, waitFor: "Choose action for reposDir:" },
      { bytes: "children\r", waitFor: "Enter value for reposDir:" },
      { bytes: enter, waitFor: "Edit another setting?" },
      { bytes: enter, waitFor: "Apply this workspace configuration?" },
    ]);
    expect(result.bytes).toBe(result.original);
  });

  test("edits a workspace setting and confirms the exact JSON preview", async () => {
    const result = await journey([
      { waitFor: "Choose configuration scope:", bytes: enter },
      { waitFor: "Choose setting in workspace-settings:", bytes: enter },
      { waitFor: "Choose action for reposDir:", bytes: down + enter },
      { waitFor: "Enter value for reposDir:", bytes: "children\r" },
      { waitFor: "Edit another setting?", bytes: enter },
      { waitFor: "Apply this workspace configuration?", bytes: "y\r" },
    ]);
    expect(result.config.reposDir).toBe("children");
    expect(result.transcript).toContain('"reposDir": "children"');
    expect(result.transcript).toContain(result.bytes);
    expect(result.transcript).toContain("Configuration updated.");
  });

  test("clears a configured field without restarting scope selection", async () => {
    const result = await journey(
      [
        { waitFor: "Choose configuration scope:", bytes: enter },
        { waitFor: "Choose setting in workspace-settings:", bytes: downs(2) + enter },
        { waitFor: "Choose action for baseBranch:", bytes: downs(2) + enter },
        { waitFor: "Edit another setting?", bytes: enter },
        { waitFor: "Apply this workspace configuration?", bytes: "y\r" },
      ],
      { baseBranch: "main" },
    );
    expect(result.config).not.toHaveProperty("baseBranch");
  });

  test("retries validation at the owning value prompt", async () => {
    const result = await journey([
      { waitFor: "Choose configuration scope:", bytes: enter },
      { waitFor: "Choose setting in workspace-settings:", bytes: downs(3) + enter },
      { waitFor: "Choose action for sync.timeoutSeconds:", bytes: down + enter },
      { waitFor: "Enter value for sync.timeoutSeconds:", bytes: "-1\r" },
      { waitFor: "Enter value for sync.timeoutSeconds:", bytes: "0\r" },
      { waitFor: "Edit another setting?", bytes: enter },
      { waitFor: "Apply this workspace configuration?", bytes: "y\r" },
    ]);
    expect(result.config).toMatchObject({ sync: { timeoutSeconds: 0 } });
    expect(result.transcript.match(/✔ Choose configuration scope:/g)).toHaveLength(1);
  });

  test("lists and installs a generated active file separately", async () => {
    const result = await journey([
      { waitFor: "Choose configuration scope:", bytes: down + enter },
      { waitFor: "Choose setting in workspace-hooks:", bytes: down + enter },
      { waitFor: "Choose action for hooks.scripts.pre-create:", bytes: down + enter },
      { waitFor: "Choose source for pre-create:", bytes: downs(2) + enter },
      { waitFor: "Edit another setting?", bytes: enter },
      { waitFor: "Apply this workspace configuration?", bytes: "y\r" },
    ]);
    expect(result.transcript).toContain("Active files to create:");
    expect(result.transcript).toContain("pre-create.sh");
    expect(result.transcript).toContain("safe no-op; runtime-ready");
    expect(
      await readFile(join(result.workspace, ".arashi", "hooks", "pre-create.sh"), "utf8"),
    ).toContain("Safe active Arashi lifecycle hook scaffold");
  });

  test("observes and keeps an existing native hook before offering mutation actions", async () => {
    const result = await journey(
      [
        { waitFor: "Choose configuration scope:", bytes: down + enter },
        { waitFor: "Choose setting in workspace-hooks:", bytes: down + enter },
        { waitFor: "Native active hook configured", bytes: enter },
        { waitFor: "Edit another setting?", bytes: enter },
      ],
      {},
      {
        setup: async (workspace) => {
          await mkdir(join(workspace, ".arashi", "hooks"), { recursive: true });
          await writeFile(join(workspace, ".arashi", "hooks", "pre-create.sh"), "KEEP_NATIVE");
        },
      },
    );
    expect(result.transcript).not.toContain("Clear canonical field");
    expect(result.transcript).not.toContain("KEEP_NATIVE");
    expect(result.bytes).toBe(result.original);
  });

  test("edits repository paths through one manual path prompt at a time", async () => {
    const result = await journey([
      { waitFor: "Choose configuration scope:", bytes: downs(5) + enter },
      { waitFor: "Choose configured repository:", bytes: enter },
      { waitFor: "Choose setting in repos.app", bytes: downs(2) + enter },
      { waitFor: "Choose action for repos.app.copy:", bytes: down + enter },
      { waitFor: "Enter one copy path", bytes: ".env\r" },
      { waitFor: "Add another copy path?", bytes: down + enter },
      { waitFor: "Edit another setting?", bytes: enter },
      { waitFor: "Apply this workspace configuration?", bytes: "y\r" },
    ]);
    expect(result.config).toMatchObject({ repos: { app: { copy: [".env"] } } });
    expect(result.transcript).not.toContain("comma-separated repository-relative");
  });

  test("shows plaintext inline entry only during entry and exact final preview", async () => {
    const canary = "printf PTY_CONFIGURE_VISIBLE";
    const result = await journey([
      { waitFor: "Choose configuration scope:", bytes: down + enter },
      { waitFor: "Choose setting in workspace-hooks:", bytes: down + enter },
      { waitFor: "Choose action for hooks.scripts.pre-create:", bytes: down + enter },
      { waitFor: "Choose source for pre-create:", bytes: enter },
      { waitFor: "stored as visible plaintext:", bytes: `${canary}\r` },
      { waitFor: "Edit another setting?", bytes: enter },
      { waitFor: "Apply this workspace configuration?", bytes: "y\r" },
    ]);
    expect(result.transcript).toContain(canary);
    expect(JSON.stringify(result.config)).toContain(canary);
    expect(result.transcript).toContain("Not configured");
    expect(result.transcript).toContain("Effective (built-in)");
  });

  test("Ctrl+C before confirmation preserves original bytes", async () => {
    const result = await journey([{ waitFor: "Choose configuration scope:", bytes: "\x03" }]);
    expect(JSON.stringify(result.config, null, 2)).toBe(result.original);
  });

  test("preserves a concurrent configuration replacement after final confirmation", async () => {
    const newer = JSON.stringify(
      { version: "1.0.0", reposDir: "newer", repos: { app: { path: "repos/app" } } },
      null,
      2,
    );
    const result = await journey(
      [
        { waitFor: "Choose configuration scope:", bytes: enter },
        { waitFor: "Choose setting in workspace-settings:", bytes: enter },
        { waitFor: "Choose action for reposDir:", bytes: down + enter },
        { waitFor: "Enter value for reposDir:", bytes: "candidate\r" },
        { waitFor: "Edit another setting?", bytes: enter },
        { waitFor: "Apply this workspace configuration?", bytes: "y\r", replaceConfig: newer },
      ],
      {},
      { expectedStatus: 1 },
    );
    expect(result.bytes).toBe(newer);
    expect(result.transcript).toContain("changed concurrently");
  });
});
