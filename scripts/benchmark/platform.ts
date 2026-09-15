export function executableNamesForPlatform(targetPlatform: NodeJS.Platform): string[] {
  return targetPlatform === "win32" ? ["arashi.bin.exe", "arashi.bin"] : ["arashi.bin"];
}
