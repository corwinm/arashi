import { afterEach, describe, expect, test } from "vitest";
import {
  readWorkspaceConfig,
  runArashi,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";
import { access } from "fs/promises";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { createHash } from "node:crypto";

const cleanups: (() => Promise<void>)[] = [];
const canary = "INLINE_SNIPPET_SECRET_9d414af2_DO_NOT_DISCLOSE";
const forbiddenProjections = [
  canary,
  canary.slice(0, 16),
  Buffer.from(canary).toString("base64"),
  createHash("sha256").update(canary).digest("hex"),
];

const expectNoSnippetProjection = (...surfaces: unknown[]): void => {
  const publicText = surfaces
    .map((surface) => (typeof surface === "string" ? surface : JSON.stringify(surface)))
    .join("\n");
  for (const projection of forbiddenProjections) {
    expect(publicText).not.toContain(projection);
  }
};

const parseSingleDocument = (stdout: string): Record<string, unknown> => {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(stdout.trim()).toBe(JSON.stringify(parsed, null, 2));
  return parsed;
};

const requiredHookOutcomeKeys = [
  "executionPath",
  "hookName",
  "hookStatus",
  "message",
  "reasonCode",
  "repositoryId",
  "scope",
  "sourceKind",
  "sourceOwnerKind",
  "sourceOwnerName",
  "sourceScriptPath",
  "targetRepositoryName",
  "targetRepositoryPath",
  "targetWorktreePath",
  "workspaceMode",
];

const expectExactHookOutcomeSchema = (outcome: Record<string, unknown>): void => {
  const expectedKeys =
    outcome.durationMs === undefined
      ? requiredHookOutcomeKeys
      : [...requiredHookOutcomeKeys, "durationMs"].toSorted();
  expect(Object.keys(outcome).toSorted()).toEqual(expectedKeys);
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("inline hook public source projection and secrecy RED", () => {
  test.runIf(process.platform !== "win32")(
    "JSON success uses exact additive inline metadata, logical repository names, quiet stdout, and unchanged stream bytes",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      const repos = config.repos as Record<string, Record<string, unknown>>;
      config.hooks = {
        ...(config.hooks as object),
        scripts: {
          "pre-create": `printf 'ROOT-OUT\\n\\n'; printf 'ROOT-ERR\\n\\n' >&2; : '${canary}'`,
        },
      };
      repos.alpha = {
        ...repos.alpha,
        hooks: {
          "post-create": `printf 'REPO-OUT\\n\\n'; printf 'REPO-ERR\\n\\n' >&2; : '${canary}'`,
        },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const result = await runArashi(workspace.workspacePath, [
        "create",
        "feature-inline-json-metadata",
        "--no-progress",
        "--json",
      ]);

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const envelope = parseSingleDocument(result.stdout) as {
        data?: { hookOutcomes?: Record<string, unknown>[] };
      };
      expect(Object.keys(envelope).toSorted()).toEqual([
        "command",
        "data",
        "ok",
        "schemaVersion",
        "warnings",
      ]);
      expect(envelope).toMatchObject({
        command: "create",
        ok: true,
        schemaVersion: 1,
        warnings: [],
      });
      expect(result.stdout).not.toContain("ROOT-OUT");
      expect(result.stdout).not.toContain("REPO-OUT");
      expect(result.stderr).not.toContain("ROOT-ERR");
      expect(result.stderr).not.toContain("REPO-ERR");
      expect(envelope.data?.hookOutcomes).toEqual([
        expect.objectContaining({
          hookName: "pre-create",
          sourceKind: "inline-config",
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
          sourceScriptPath: null,
        }),
        expect.objectContaining({
          hookName: "pre-create.alpha",
          hookStatus: "skipped",
          reasonCode: "not_found",
          sourceKind: "file",
        }),
        expect.objectContaining({
          hookName: "post-create.alpha",
          sourceKind: "inline-config",
          sourceOwnerKind: "repository",
          sourceOwnerName: "alpha",
          sourceScriptPath: null,
        }),
        expect.objectContaining({
          hookName: "pre-create.beta",
          hookStatus: "skipped",
          reasonCode: "not_found",
          sourceKind: "file",
        }),
        expect.objectContaining({
          hookName: "post-create.beta",
          hookStatus: "skipped",
          reasonCode: "not_found",
          sourceKind: "file",
        }),
        expect.objectContaining({
          hookName: "post-create",
          hookStatus: "skipped",
          reasonCode: "not_found",
          sourceKind: "file",
        }),
      ]);
      for (const outcome of envelope.data?.hookOutcomes ?? []) {
        expectExactHookOutcomeSchema(outcome);
      }
      expectNoSnippetProjection(result.stdout, result.stderr, envelope);
    },
  );

  test.runIf(process.platform !== "win32")(
    "JSON failure keeps canonical envelope location, evaluated-prefix ordering, and no snippet-derived disclosure",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      config.hooks = {
        ...(config.hooks as object),
        scripts: {
          "post-create": `: '${canary}'; exit 27`,
          "pre-create": ":",
        },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const result = await runArashi(workspace.workspacePath, [
        "create",
        "feature-inline-json-failure",
        "--no-progress",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const envelope = parseSingleDocument(result.stdout) as {
        error?: { code?: string; details?: { hookOutcomes?: Record<string, unknown>[] } };
      };
      expect(Object.keys(envelope).toSorted()).toEqual([
        "command",
        "error",
        "ok",
        "schemaVersion",
        "warnings",
      ]);
      expect(envelope).toMatchObject({
        command: "create",
        ok: false,
        schemaVersion: 1,
        warnings: [],
      });
      expect(envelope.error?.code).toBe("CREATE_FAILED");
      expect(envelope.error?.details?.hookOutcomes?.map((outcome) => outcome.hookName)).toEqual([
        "pre-create",
        "pre-create.alpha",
        "post-create.alpha",
        "pre-create.beta",
        "post-create.beta",
        "post-create",
      ]);
      expect(envelope.error?.details?.hookOutcomes?.at(-1)).toMatchObject({
        hookStatus: "failure",
        reasonCode: "exit_non_zero",
        sourceKind: "inline-config",
        sourceOwnerKind: "workspace",
        sourceOwnerName: null,
        sourceScriptPath: null,
      });
      for (const outcome of envelope.error?.details?.hookOutcomes ?? []) {
        expectExactHookOutcomeSchema(outcome);
      }
      expectNoSnippetProjection(result.stdout, result.stderr, envelope);
      await expect(
        access(workspace.getMainWorktreePath("feature-inline-json-failure")),
      ).rejects.toThrow();
    },
  );

  test.runIf(process.platform !== "win32")(
    "human and doctor surfaces attribute inline owners without command text or synthetic script paths",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      config.hooks = {
        ...(config.hooks as object),
        scripts: { "pre-create": `: '${canary}'; exit 19` },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const human = await runArashi(workspace.workspacePath, [
        "create",
        "feature-inline-human-source",
        "--no-progress",
      ]);
      const doctor = await runArashi(workspace.workspacePath, ["doctor", "--json"]);
      expect(`${human.stdout}\n${human.stderr}`).toMatch(/inline-config.*workspace.*pre-create/is);
      const doctorEnvelope = parseSingleDocument(doctor.stdout);
      expect(JSON.stringify(doctorEnvelope)).toContain('"sourceKind":"inline-config"');
      expect(JSON.stringify(doctorEnvelope)).toContain('"sourceOwnerKind":"workspace"');
      expectNoSnippetProjection(human.stdout, human.stderr, doctor.stdout, doctor.stderr);
    },
  );
});
