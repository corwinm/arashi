import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { captureOutput } from "../helpers/switch-t3-command.ts";
import { nativeTransportFixture } from "../helpers/switch-t3-native-transport.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("issue392 A16 inherited predispatch recheck and physical project matching", () => {
  test.each(["environment", "server-version", "CLI-version"])(
    "changed %s after preflight blocks every mutation",
    async (kind) => {
      const f = await nativeTransportFixture(roots);
      if (kind === "environment") f.runtime.environmentId = "environment-other";
      if (kind === "server-version") f.runtime.serverVersion = "0.0.44";
      if (kind === "CLI-version") f.cli("0.0.44");
      await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
        code: kind === "CLI-version" ? "T3_VERSION_MISMATCH" : "T3_ENVIRONMENT_CHANGED",
      });
      expect(f.commands).toEqual([]);
      expect(f.processes.some((p) => p.command.includes("issue"))).toBe(false);
    },
  );
  test.each(["exact", "equivalent", "none", "multiple"])(
    "project %s uses the exact physical checkout without guessing",
    async (kind) => {
      const f = await nativeTransportFixture(roots);
      const alias = join(f.root, "project physical alias");
      await symlink(f.workspacePath, alias, "junction");
      if (kind !== "none")
        f.projects.push({
          id: "existing-project",
          workspaceRoot: kind === "equivalent" ? alias : f.workspacePath,
          deletedAt: null,
        });
      if (kind === "multiple")
        f.projects.push({ id: "second-project", workspaceRoot: alias, deletedAt: null });
      if (kind === "multiple") {
        await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
          code: "T3_PROJECT_AMBIGUOUS",
        });
        expect(f.commands).toEqual([]);
      } else {
        const result = await dispatchT3Handoff(f.input);
        expect(result.status).toBe("succeeded");
        expect(f.commands.filter((c) => c.type === "project.create")).toHaveLength(
          kind === "none" ? 1 : 0,
        );
        if (kind !== "none") expect(result.project.id).toBe("existing-project");
        expect(f.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
      }
    },
  );
});
describe("issue392 A17 inherited exact native transport/body/CWD and directive removal", () => {
  test.each(
    ["plain", "multiline", "shell-sensitive"].flatMap((prompt) =>
      [false, true].map((child) => ({ prompt, child })),
    ),
  )("$prompt child=$child official body and auth argv only", async ({ prompt, child }) => {
    const text =
      prompt === "plain"
        ? "Exact task"
        : prompt === "multiline"
          ? "Line one 日本\nLine two\r\n"
          : "$(touch forbidden) `literal` '$HOME' ; & |";
    const f = await nativeTransportFixture(roots, text, child);
    const result = await dispatchT3Handoff(f.input);
    expect(result).toMatchObject({ status: "succeeded", ui: { mode: "none", status: "skipped" } });
    expect(f.commands.map((c) => c.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
    ]);
    expect(f.commands[0]!.workspaceRoot).toBe(f.workspacePath);
    expect(f.commands[1]!.worktreePath).toBeNull();
    expect(f.commands[2]!.message).toMatchObject({ text, attachments: [], role: "user" });
    expect(f.commands[1]!.runtimeMode).toBe("full-access");
    expect(f.commands[2]!.runtimeMode).toBe("full-access");
    expect(f.processes.map((p) => p.command)).toEqual([
      ["t3", "--version"],
      [
        "t3",
        "auth",
        "session",
        "issue",
        "--base-dir",
        "/t3",
        "--ttl",
        "5m",
        "--label",
        "Arashi handoff",
        "--json",
      ],
      ["t3", "auth", "session", "revoke", "session-1", "--base-dir", "/t3"],
    ]);
    expect(f.processes.every((p) => p.cwd === f.workspacePath)).toBe(true);
    expect(f.processes.slice(1).every((p) => p.env.T3CODE_HOME === "/t3")).toBe(true);
    expect(f.processes.flatMap((p) => p.command)).not.toContain(text);
    expect(JSON.stringify(await f.receipt())).not.toContain(text);
  });
  test.each(["version", "issue", "revoke"])(
    "every actual adapter %s child strips the directive variable",
    async (stage) => {
      vi.stubEnv("ARASHI_DIRECTIVE_FILE", "/sentinel/directive");
      const f = await nativeTransportFixture(roots);
      await dispatchT3Handoff(f.input);
      const process = f.processes[["version", "issue", "revoke"].indexOf(stage)]!;
      expect(Object.hasOwn(process.env, "ARASHI_DIRECTIVE_FILE")).toBe(false);
    },
  );
});
describe("issue392 A28 actual native persistence and public error/output surfaces", () => {
  test.each(
    ["prompt", "token", "session-output", "URL", "config-secret", "control-characters"].flatMap(
      (kind) => ["stdout", "stderr", "receipt", "error"].map((surface) => ({ kind, surface })),
    ),
  )("$kind $surface excludes raw native content", async ({ kind, surface }) => {
    const canary =
      kind === "control-characters" ? "CANARY\u001b[31m\u0007" : "CANARY_392_" + kind.toUpperCase();
    const f = await nativeTransportFixture(roots, kind === "prompt" ? canary : "Approved task");
    f.canary(canary);
    const output = captureOutput();
    if (surface === "error") f.failTask();
    const outcome = await dispatchT3Handoff(f.input).catch((error: unknown) => error);
    expect(f.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
    let text: string;
    if (surface === "receipt") text = await readFile(await t3ReceiptPath(f.workspacePath), "utf8");
    else if (surface === "stdout") text = output.stdout();
    else if (surface === "stderr") text = output.stderr();
    else {
      expect(outcome).toMatchObject({ code: "T3_UNREACHABLE" });
      text = JSON.stringify(outcome);
    }
    expect(text).not.toContain(canary);
    expect(text).not.toContain("http://token@");
    if (kind === "control-characters") {
      expect(text).not.toMatch(/\\u001b|\\u0007/u);
      expect(text).not.toContain(String.fromCharCode(27));
      expect(text).not.toContain(String.fromCharCode(7));
    }
    expect(JSON.stringify(await f.receipt())).not.toContain(canary);
  });
});
