import type { Config, RepoConfig } from "../../src/lib/config.ts";

const repository: RepoConfig = {
  copy: [".env", "config/local.json"],
  path: "./repos/app",
  symlink: [".cache/sdk", ".turbo"],
};

const materializationConfig: Config = {
  repos: { app: repository },
  reposDir: "./repos",
  version: "1.0.0",
};

const orderedCopy: readonly string[] | undefined = materializationConfig.repos.app.copy;
const orderedSymlink: readonly string[] | undefined = materializationConfig.repos.app.symlink;

export { orderedCopy, orderedSymlink };
export default materializationConfig;
