export interface RuntimeMetadata {
  method: string;
  name: string;
  version: { available: boolean; reason?: string; value?: string };
}

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
