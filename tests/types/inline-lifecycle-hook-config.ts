import type {
  Config,
  InlineHookInterpreter,
  InlineHookValue,
  RepoConfig,
} from "../../src/lib/config.ts";

const interpreter: InlineHookInterpreter = "powershell";
const shorthand: InlineHookValue = "printf root";
const interpreterMap: InlineHookValue = {
  bash: "printf bash",
  cmd: "echo cmd",
  powershell: "Write-Output powershell",
};

const repository: RepoConfig = {
  groups: ["core"],
  hooks: {
    "post-create": interpreterMap,
    "pre-create": shorthand,
  },
  path: "./repos/api",
};

const typedInlineHookConfig: Config = {
  hooks: {
    scripts: {
      "post-remove": { [interpreter]: "Write-Output cleanup" },
      "pre-create": shorthand,
    },
    timeout: 12_345,
  },
  repos: { api: repository },
  reposDir: "./repos",
  version: "1.0.0",
};

export default typedInlineHookConfig;
