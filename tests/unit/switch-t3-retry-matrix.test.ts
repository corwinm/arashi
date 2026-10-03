import { rm } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff } from "../../src/lib/t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";
import { nativeConfig } from "../helpers/t3-native.ts";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
);
const authored = {
  baseDir: "/t3",
  cli: "t3",
  effort: "medium",
  model: "catalog-default",
  provider: "codex",
};
test.each(
  Object.keys(authored).flatMap((leaf) =>
    ["omitted-changed-default", "explicit-same", "explicit-changed"].map((retry) => ({
      leaf,
      retry,
    })),
  ),
)("A24 pinned $leaf $retry", async ({ leaf, retry }) => {
  const f = await switchFixture(roots);
  const value = authored[leaf as keyof typeof authored];
  f.input.switch!.explicitSettings = { [leaf]: value };
  f.input.switch!.provenance = { [leaf]: "cli" };
  f.input.request.permission = "approval-required";
  f.input.switch!.explicitSettings.permission = "approval-required";
  const original = await dispatchT3Handoff(f.input);
  const before = f.commands.length;
  f.input.request.permission = "full-access";
  f.input.switch!.explicitSettings =
    retry === "omitted-changed-default"
      ? {}
      : { [leaf]: retry === "explicit-same" ? value : "other" };
  if (["provider", "model", "effort"].includes(leaf)) {
    f.input.environment.settings = { [leaf]: "changed-default" };
  }
  if (leaf === "baseDir") {
    f.input.environment.baseDir = "/changed-default";
  }
  if (leaf === "cli") {
    f.input.environment.cli = "changed-default-cli";
  }
  if (retry === "explicit-changed") {
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: "T3_HANDOFF_INTENT_CHANGED",
    });
  } else {
    const result = await dispatchT3Handoff(f.input);
    expect(result).toMatchObject({
      native: original.native,
      permission: "approval-required",
      selection: original.selection,
      status: "succeeded",
    });
  }
  expect(f.commands).toHaveLength(before);
});
test.each(["prompt", "permission", "environment"])(
  "A24 explicit changed $0 fails before dispatch",
  async (leaf) => {
    const f = await switchFixture(roots);
    await dispatchT3Handoff(f.input);
    const before = f.commands.length;
    if (leaf === "prompt") {
      f.input.request.promptDigest = "0".repeat(64);
    }
    if (leaf === "permission") {
      f.input.request.permission = "approval-required";
      f.input.switch!.explicitSettings.permission = "approval-required";
    }
    if (leaf === "environment") {
      f.input.environment.environmentId = "different";
    }
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: leaf === "environment" ? "T3_ENVIRONMENT_CHANGED" : "T3_HANDOFF_INTENT_CHANGED",
    });
    expect(f.commands).toHaveLength(before);
  },
);
test.each(["provider", "model", "effort"])(
  "A24 pinned $0 removed from live catalog rejects continuation",
  async (leaf) => {
    const f = await switchFixture(roots);
    f.fail("thread.create", "after");
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    const before = f.commands.length;
    const config = nativeConfig();
    if (leaf === "provider") {
      config.providers = [];
    }
    if (leaf === "model") {
      config.providers[0]!.models = [];
    }
    if (leaf === "effort") {
      config.providers[0]!.models[0]!.capabilities.optionDescriptors[0]!.options = [];
    }
    f.dependencies.getConfig = async () => config;
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    expect(f.commands).toHaveLength(before);
    expect(f.commands.some((v) => v.type === "thread.turn.start")).toBe(false);
  },
);
test("A19 stable saved literal later reuse after deliberate followups", async () => {
  const f = await switchFixture(roots);
  const results = [];
  for (const intentId of ["default", "followup-1", "followup-2"]) {
    f.input.switch!.intentId = intentId;
    results.push(await dispatchT3Handoff(f.input));
  }
  expect(f.projects).toHaveLength(1);
  expect(f.threads).toHaveLength(3);
  expect(new Set(results.map((v) => v.native!.threadId)).size).toBe(3);
  const before = f.commands.length;
  for (const [index, intentId] of ["default", "followup-1", "followup-2"].entries()) {
    f.input.switch!.intentId = intentId;
    expect((await dispatchT3Handoff(f.input)).native).toEqual(results[index]!.native);
  }
  expect(f.commands).toHaveLength(before);
});
