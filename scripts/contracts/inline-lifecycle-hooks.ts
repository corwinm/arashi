import { dirname, resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { CURRENT_CONFIG_VERSION } from "../../src/lib/config.ts";

export const INLINE_LIFECYCLE_HOOK_CONTRACT_SCHEMA_VERSION = 1 as const;

export interface InlineLifecycleHookContract {
  schemaVersion: typeof INLINE_LIFECYCLE_HOOK_CONTRACT_SCHEMA_VERSION;
  producer: "scripts/contracts/inline-lifecycle-hooks.ts";
  configVersion: typeof CURRENT_CONFIG_VERSION;
  ownership: {
    workspace: "hooks.scripts.<lifecycle>";
    repository: "repos.<name>.hooks.<lifecycle>";
  };
  lifecycles: ["pre-create", "post-create", "pre-remove", "post-remove"];
  valueModel: {
    stringShorthand: "bash";
    interpreters: ["bash", "powershell", "cmd"];
    nonEmpty: true;
    closedKeys: true;
  };
  selection: {
    posix: { order: ["bash"]; lookup: string };
    windows: { order: ["powershell", "cmd", "bash"]; lookup: string };
  };
  logicalNames: {
    repositoryCreate: ["pre-create.<repo>", "post-create.<repo>"];
    repositoryRemove: ["pre-remove", "post-remove"];
  };
  ambiguity: {
    sourceKinds: ["inline-config", "file"];
    outcomeReason: "validation_failed";
    createJsonCode: "CREATE_FAILED";
    removeJsonCode: "HOOK_CONFIGURATION_INVALID";
    doctorCode: "HOOK_AMBIGUOUS";
  };
  options: {
    create: { noHooks: true; noHookInput: true };
    remove: { noHooks: false; noHookInput: true };
  };
  dryRun: {
    create: { discoversHooks: false; hookPreviews: false; emptyHookLedger: true };
    remove: { discoversHooks: true; hookPreviews: true; executesHooks: false };
  };
  automation: {
    timeout: "source-neutral";
    input: "source-neutral";
    quietOwner: "json";
    jsonStdoutDocuments: 1;
  };
  sourceMetadata: {
    fields: ["sourceKind", "sourceOwnerKind", "sourceOwnerName", "sourceScriptPath"];
    sourceKinds: ["file", "inline-config"];
    ownerKinds: ["workspace", "repository", "user-global"];
    inlineSourceScriptPath: null;
    snippetDisclosure: "forbidden";
  };
  boundaries: {
    standaloneInline: false;
    userGlobalInline: false;
    fileOnlyCompatible: true;
  };
}

export const buildInlineLifecycleHookContract = (): InlineLifecycleHookContract => ({
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
  configVersion: CURRENT_CONFIG_VERSION,
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
  schemaVersion: INLINE_LIFECYCLE_HOOK_CONTRACT_SCHEMA_VERSION,
  selection: {
    posix: {
      lookup: "scan non-empty PATH entries for executable bash and return its absolute realpath",
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

export const serializeInlineLifecycleHookContract = (
  contract: InlineLifecycleHookContract | Record<string, unknown>,
): string => {
  const formatted = JSON.stringify(contract, null, 2).replaceAll(
    /^(\s*"[^"]+": )\[\n((?:\s+"(?:[^"\\]|\\.)*",?\n)+)\s*\]/gm,
    (block, prefix: string, entries: string) => {
      const inline = `${prefix}[${entries
        .trim()
        .split("\n")
        .map((entry) => entry.trim().replace(/,$/, ""))
        .join(", ")}]`;
      return inline.length <= 100 ? inline : block;
    },
  );
  return `${formatted}\n`;
};

export const validateInlineLifecycleHookContract = (
  contract: Record<string, unknown>,
): string[] => {
  const expected = buildInlineLifecycleHookContract();
  const errors: string[] = [];

  for (const key of Object.keys(contract)) {
    if (!(key in expected)) {
      errors.push(`${key}: unknown property`);
    }
  }
  for (const key of Object.keys(expected)) {
    if (!(key in contract)) {
      errors.push(`${key}: missing property`);
    }
  }

  for (const key of Object.keys(expected) as (keyof InlineLifecycleHookContract)[]) {
    if (JSON.stringify(contract[key]) !== JSON.stringify(expected[key])) {
      errors.push(`${key}: does not match the inline lifecycle hook contract`);
    }
  }

  return errors;
};

const outputPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../contracts/inline-lifecycle-hooks.json",
);

const run = (): void => {
  const generated = buildInlineLifecycleHookContract();
  const validationErrors = validateInlineLifecycleHookContract(generated);
  if (validationErrors.length > 0) {
    console.error(validationErrors.join("\n"));
    process.exitCode = 1;
    return;
  }

  const serialized = serializeInlineLifecycleHookContract(generated);
  if (process.argv.includes("--check")) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (current !== serialized) {
      console.error(
        "contracts/inline-lifecycle-hooks.json is stale. Run `pnpm run contract:generate` and commit the result.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("Inline lifecycle hook contract is current.");
    return;
  }

  writeFileSync(outputPath, serialized);
  console.log("Generated contracts/inline-lifecycle-hooks.json.");
};

const [, invokedPath] = process.argv;
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  run();
}
