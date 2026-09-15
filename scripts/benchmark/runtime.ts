export interface RuntimeMetadata {
  method: string;
  name: string;
  version: { available: boolean; reason?: string; value?: string };
}

interface VersionProbeResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type VersionProbe = () => Promise<VersionProbeResult>;

export function nodeRuntime(method: string): RuntimeMetadata {
  return {
    method,
    name: "node",
    version: { available: true, value: process.version },
  };
}

export function cliRuntime(source: boolean): RuntimeMetadata {
  if (source) {
    return nodeRuntime("node-source");
  }
  return {
    method: "compiled-executable",
    name: "bun",
    version: {
      available: false,
      reason: "The embedded Bun runtime version is not introspected from the compiled executable.",
    },
  };
}

export async function buildRuntime(
  source: boolean,
  probeVersion: VersionProbe,
): Promise<RuntimeMetadata> {
  if (source) {
    return {
      method: "not-applicable-source-mode",
      name: "bun",
      version: {
        available: false,
        reason: "Source mode does not build or invoke the Arashi executable.",
      },
    };
  }

  const outcome = await probeVersion().then(
    (probe) => ({ probe }),
    (error: unknown) => ({ error }),
  );
  if ("error" in outcome) {
    return {
      method: "bun-version-path-probe",
      name: "bun",
      version: { available: false, reason: `Bun version probe failed: ${String(outcome.error)}` },
    };
  }
  const { probe } = outcome;
  if (probe.exitCode !== 0) {
    return {
      method: "bun-version-path-probe",
      name: "bun",
      version: {
        available: false,
        reason: `Bun version probe failed: ${probe.stderr.trim() || `exit ${probe.exitCode}`}`,
      },
    };
  }
  const version = probe.stdout.trim();
  if (!version) {
    return {
      method: "bun-version-path-probe",
      name: "bun",
      version: { available: false, reason: "Bun version probe returned no version." },
    };
  }
  return {
    method: "bun-version-path-probe",
    name: "bun",
    version: { available: true, value: version },
  };
}
