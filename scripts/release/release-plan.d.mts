export type ReleasePlugin = string | [string, Record<string, unknown>];

export function releasePlanPlugins(config: { plugins?: ReleasePlugin[] }): ReleasePlugin[];
export function runReleasePlan(repositoryUrl: string): Promise<unknown>;
