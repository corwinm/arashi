import { access, readFile } from "fs/promises";
import { describe, expect, test } from "vitest";
import { join } from "path";

const root = process.cwd();
const producerPath = join(root, "scripts", "contracts", "inline-lifecycle-hooks.ts");
const artifactPath = join(root, "contracts", "inline-lifecycle-hooks.json");

describe("inline lifecycle hook dedicated contract freshness RED", () => {
  test("owns a deterministic schema-v1 producer and byte-current generated artifact", async () => {
    await expect(access(producerPath)).resolves.toBeUndefined();
    await expect(access(artifactPath)).resolves.toBeUndefined();
    const producer = (await import(producerPath).catch(() => ({}))) as Record<string, unknown>;
    expect(producer.buildInlineLifecycleHookContract).toBeTypeOf("function");
    expect(producer.serializeInlineLifecycleHookContract).toBeTypeOf("function");
    const build = producer.buildInlineLifecycleHookContract as () => Record<string, unknown>;
    const serialize = producer.serializeInlineLifecycleHookContract as (
      contract: Record<string, unknown>,
    ) => string;
    const generated = build();
    expect(generated).toEqual({
      ambiguity: {
        createJsonCode: "CREATE_FAILED",
        doctorCode: "HOOK_AMBIGUOUS",
        outcomeReason: "validation_failed",
        removeJsonCode: "HOOK_CONFIGURATION_INVALID",
        sourceKinds: ["inline-config", "file"],
      },
      automation: {
        input: "source-neutral",
        jsonStdoutDocuments: 1,
        quietOwner: "json",
        timeout: "source-neutral",
      },
      boundaries: {
        fileOnlyCompatible: true,
        standaloneInline: false,
        userGlobalInline: false,
      },
      configVersion: "1.0.0",
      dryRun: {
        create: { discoversHooks: false, emptyHookLedger: true, hookPreviews: false },
        remove: { discoversHooks: true, executesHooks: false, hookPreviews: true },
      },
      lifecycles: ["pre-create", "post-create", "pre-remove", "post-remove"],
      logicalNames: {
        repositoryCreate: ["pre-create.<repo>", "post-create.<repo>"],
        repositoryRemove: ["pre-remove", "post-remove"],
      },
      options: {
        create: { noHookInput: true, noHooks: true },
        remove: { noHookInput: true, noHooks: false },
      },
      ownership: {
        repository: "repos.<name>.hooks.<lifecycle>",
        workspace: "hooks.scripts.<lifecycle>",
      },
      producer: "scripts/contracts/inline-lifecycle-hooks.ts",
      schemaVersion: 1,
      selection: {
        posix: {
          lookup:
            "scan non-empty PATH entries for executable bash and return its absolute realpath",
          order: ["bash"],
        },
        windows: {
          lookup:
            "use fixed SystemRoot PowerShell and cmd paths, then scan non-empty PATH entries for regular bash.exe",
          order: ["powershell", "cmd", "bash"],
        },
      },
      sourceMetadata: {
        fields: ["sourceKind", "sourceOwnerKind", "sourceOwnerName", "sourceScriptPath"],
        inlineSourceScriptPath: null,
        ownerKinds: ["workspace", "repository", "user-global"],
        snippetDisclosure: "forbidden",
        sourceKinds: ["file", "inline-config"],
      },
      valueModel: {
        closedKeys: true,
        interpreters: ["bash", "powershell", "cmd"],
        nonEmpty: true,
        stringShorthand: "bash",
      },
    });
    expect(await readFile(artifactPath, "utf8")).toBe(serialize(generated));
  });

  test("keeps config version 1.0.0 and command schema version 7 in their existing artifacts", async () => {
    const [schema, commandContract] = await Promise.all([
      readFile(join(root, "schema", "config.schema.json"), "utf8").then(JSON.parse),
      readFile(join(root, "contracts", "cli-commands.json"), "utf8").then(JSON.parse),
    ]);
    expect(schema.definitions.ConfigVersion).toEqual({ const: "1.0.0", type: "string" });
    expect(commandContract.schemaVersion).toBe(8);
    expect(commandContract).not.toHaveProperty("inlineLifecycleHooks");
  });

  test("validator fails closed on controlled ownership, lifecycle, interpreter, and disclosure drift", async () => {
    const producer = (await import(producerPath).catch(() => ({}))) as Record<string, unknown>;
    expect(producer.validateInlineLifecycleHookContract).toBeTypeOf("function");
    const validate = producer.validateInlineLifecycleHookContract as (
      contract: Record<string, unknown>,
    ) => string[];
    const valid = (producer.buildInlineLifecycleHookContract as () => Record<string, unknown>)();
    const controlledDrift: [Record<string, unknown>, string][] = [
      [{ ...valid, ownership: { workspace: "hooks.inline" } }, "ownership"],
      [{ ...valid, lifecycles: ["pre-create", "dynamic-repo-key"] }, "lifecycles"],
      [
        {
          ...valid,
          valueModel: {
            ...(valid.valueModel as Record<string, unknown>),
            interpreters: ["pwsh"],
          },
        },
        "valueModel",
      ],
      [
        {
          ...valid,
          sourceMetadata: {
            ...(valid.sourceMetadata as Record<string, unknown>),
            fields: ["snippet", "snippetHash"],
          },
        },
        "sourceMetadata",
      ],
    ];
    for (const [mutation, path] of controlledDrift) {
      expect(validate(mutation)).toContain(
        `${path}: does not match the inline lifecycle hook contract`,
      );
    }
  });
});
