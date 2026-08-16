export const EXECUTABLE_DISTRIBUTION_SCHEMA_VERSION = 1 as const;
export const ARASHI_ALIAS_MARKERS = {
  cmd: "arashi-managed-alias:aw:v1",
  posix: "arashi-managed-alias:aw:v1",
  powershell: "arashi-managed-alias:aw:v1",
} as const;

export const executableDistributionPolicy = {
  alias: { expansion: "Arashi Workspace", name: "aw" },
  canonical: "arashi",
  completionNames: ["arashi", "aw"],
  identity: {
    branding: "arashi",
    commanderProgramName: "arashi",
    configurationVocabulary: "arashi",
    environmentPrefix: "ARASHI_",
    managedShellBlock: "arashi",
    packageName: "arashi",
  },
  ledger: { name: ".arashi-managed-entrypoints.json", schemaVersion: 1 },
  nativeBinaries: { posix: "arashi.bin", windows: "arashi.bin.exe" },
  npmBins: { arashi: "./bin/arashi.js", aw: "./bin/arashi.js" },
  ownership: {
    collisionPolicy: "marker-and-ledger-hash",
    ledger: { name: ".arashi-managed-entrypoints.json", schemaVersion: 1 },
    markers: ARASHI_ALIAS_MARKERS,
  },
  posix: {
    installed: ["arashi.bin", "arashi", "aw"],
    releaseLaunchers: ["arashi", "aw"],
  },
  schemaVersion: EXECUTABLE_DISTRIBUTION_SCHEMA_VERSION,
  shellWrapperNames: ["arashi", "aw"],
  windows: {
    installed: ["arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat"],
    releaseLaunchers: ["arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat"],
  },
} as const;

export type ExecutableDistributionPolicy = typeof executableDistributionPolicy;
