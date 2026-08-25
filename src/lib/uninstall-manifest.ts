import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";

export const MANIFEST_NAME = ".arashi-managed-entrypoints.json";

const POSIX_FILES = [
  ["arashi.bin", "native-executable"],
  ["arashi", "canonical-wrapper"],
  ["aw", "alias-wrapper"],
  ["uninstall.sh", "uninstall-helper"],
] as const;

const WINDOWS_FILES = [
  ["arashi.bin.exe", "native-executable"],
  ["arashi", "canonical-wrapper"],
  ["arashi.ps1", "canonical-powershell-wrapper"],
  ["arashi.bat", "canonical-cmd-wrapper"],
  ["aw", "alias-wrapper"],
  ["aw.ps1", "alias-powershell-wrapper"],
  ["aw.bat", "alias-cmd-wrapper"],
  ["uninstall.ps1", "uninstall-helper"],
] as const;

type PosixRole = (typeof POSIX_FILES)[number][1];
type WindowsRole = (typeof WINDOWS_FILES)[number][1];

export interface DirectInstallFile {
  relativePath: string;
  role: PosixRole | WindowsRole;
  digest: string;
}

export interface PosixPathMutation {
  profilePath: string;
  insertedBytes: string;
}

export interface WindowsPathMutation {
  entry: string;
  created: boolean;
}

export interface DirectInstallManifest {
  schemaVersion: 2;
  installationChannel: "official-direct";
  platform: "posix" | "windows";
  installDirectory: string;
  files: DirectInstallFile[];
  pathMutation?: PosixPathMutation | WindowsPathMutation;
}

export interface PlannedDirectFile extends DirectInstallFile {
  absolutePath: string;
  status: "absent" | "removable";
}

export interface DirectUninstallPlan {
  installDirectory: string;
  manifestPath: string;
  manifest: DirectInstallManifest;
  files: PlannedDirectFile[];
  pathMutation?:
    | ({ status: "absent" | "preserved" | "removable" } & PosixPathMutation)
    | ({ status: "preserved" | "removable" } & WindowsPathMutation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const keys = Object.keys(value).toSorted();
  const allowed = [...required, ...optional].toSorted();
  return required.every((key) => key in value) && keys.every((key) => allowed.includes(key));
}

export function normalizeInstallDirectoryForPlatform(
  directory: string,
  platform: "posix" | "windows",
): string {
  const pathApi = platform === "windows" ? win32 : posix;
  let normalized = pathApi.normalize(directory);
  const root = pathApi.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(pathApi.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return platform === "windows" ? normalized.toLowerCase() : normalized;
}

function validateManifest(value: unknown, requestedDirectory: string): DirectInstallManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["schemaVersion", "installationChannel", "platform", "installDirectory", "files"],
      ["pathMutation"],
    )
  ) {
    throw new Error("The ownership manifest has an unsupported property set.");
  }
  if (value.schemaVersion !== 2) {
    throw new Error("Unsupported ownership manifest schema; refresh this direct install first.");
  }
  if (value.installationChannel !== "official-direct") {
    throw new Error("The installation is not owned by the official direct installer.");
  }
  if (value.platform !== "posix" && value.platform !== "windows") {
    throw new Error("The ownership manifest platform is unsupported.");
  }
  const manifestPathApi = value.platform === "windows" ? win32 : posix;
  if (
    typeof value.installDirectory !== "string" ||
    !manifestPathApi.isAbsolute(value.installDirectory) ||
    (value.platform === "posix" &&
      normalizeInstallDirectoryForPlatform(value.installDirectory, value.platform) !==
        value.installDirectory) ||
    normalizeInstallDirectoryForPlatform(requestedDirectory, value.platform) !==
      normalizeInstallDirectoryForPlatform(value.installDirectory, value.platform)
  ) {
    throw new Error(
      "The ownership manifest installDirectory does not match the requested directory.",
    );
  }
  if (!Array.isArray(value.files)) {
    throw new Error("The ownership manifest files property is invalid.");
  }

  const expected = value.platform === "posix" ? POSIX_FILES : WINDOWS_FILES;
  if (value.files.length !== expected.length) {
    throw new Error("The ownership manifest does not contain the exact platform payload.");
  }
  const seenPaths = new Set<string>();
  const seenRoles = new Set<string>();
  for (let index = 0; index < value.files.length; index++) {
    const file = value.files[index];
    const expectedFile = expected[index];
    if (!isRecord(file) || !hasExactKeys(file, ["relativePath", "role", "digest"])) {
      throw new Error(`Invalid ownership file record at index ${index}.`);
    }
    if (
      typeof file.relativePath !== "string" ||
      isAbsolute(file.relativePath) ||
      file.relativePath.includes("\\") ||
      resolve(value.installDirectory, file.relativePath) !==
        join(value.installDirectory, file.relativePath) ||
      relative(
        value.installDirectory,
        resolve(value.installDirectory, file.relativePath),
      ).startsWith("..")
    ) {
      throw new Error(`Invalid or escaping relativePath at index ${index}.`);
    }
    if (file.relativePath !== expectedFile[0] || file.role !== expectedFile[1]) {
      throw new Error(`Unexpected file path or role at index ${index}.`);
    }
    if (seenPaths.has(file.relativePath) || seenRoles.has(String(file.role))) {
      throw new Error("Duplicate ownership file path or role.");
    }
    if (typeof file.digest !== "string" || !/^[a-f0-9]{64}$/.test(file.digest)) {
      throw new Error(`Invalid digest at index ${index}.`);
    }
    seenPaths.add(file.relativePath);
    seenRoles.add(String(file.role));
  }

  if (value.pathMutation !== undefined) {
    if (!isRecord(value.pathMutation)) throw new Error("Invalid pathMutation.");
    if (value.platform === "posix") {
      if (
        !hasExactKeys(value.pathMutation, ["profilePath", "insertedBytes"]) ||
        typeof value.pathMutation.profilePath !== "string" ||
        !isAbsolute(value.pathMutation.profilePath) ||
        resolve(value.pathMutation.profilePath) !== value.pathMutation.profilePath ||
        typeof value.pathMutation.insertedBytes !== "string" ||
        value.pathMutation.insertedBytes.length === 0
      )
        throw new Error("Invalid POSIX pathMutation.");
    } else if (
      !hasExactKeys(value.pathMutation, ["entry", "created"]) ||
      typeof value.pathMutation.entry !== "string" ||
      value.pathMutation.entry.length === 0 ||
      typeof value.pathMutation.created !== "boolean"
    ) {
      throw new Error("Invalid Windows pathMutation.");
    }
  }
  return value as unknown as DirectInstallManifest;
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readDirectInstallManifest(installDirectory: string) {
  const normalizedDirectory = resolve(installDirectory);
  const directoryStat = await optionalLstat(normalizedDirectory);
  if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("The install directory is missing, not a directory, or is a symbolic link.");
  }
  const canonicalDirectory = await realpath(normalizedDirectory);
  const manifestPath = join(canonicalDirectory, MANIFEST_NAME);
  const stat = await optionalLstat(manifestPath);
  if (!stat)
    throw new Error(
      `No current ownership manifest exists at ${manifestPath}. Refresh this direct install first.`,
    );
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("The ownership manifest is not a regular non-link file.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to parse the ownership manifest: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const declaredDirectory =
    isRecord(parsed) && typeof parsed.installDirectory === "string"
      ? resolve(parsed.installDirectory)
      : normalizedDirectory;
  const requestedDirectory =
    declaredDirectory === canonicalDirectory ? canonicalDirectory : normalizedDirectory;
  const manifest = validateManifest(parsed, requestedDirectory);
  return manifest;
}

function countOccurrences(contents: Buffer, needle: Buffer): number {
  let count = 0;
  let position = 0;
  while ((position = contents.indexOf(needle, position)) !== -1) {
    count++;
    position += needle.length;
  }
  return count;
}

export async function planDirectUninstall(installDirectory: string): Promise<DirectUninstallPlan> {
  const manifest = await readDirectInstallManifest(installDirectory);
  const canonicalDirectory = await realpath(resolve(installDirectory));
  const blockers: string[] = [];
  const files: PlannedDirectFile[] = [];
  for (const file of manifest.files) {
    const absolutePath = join(canonicalDirectory, file.relativePath);
    const stat = await optionalLstat(absolutePath);
    if (!stat) {
      files.push({ ...file, absolutePath, status: "absent" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      blockers.push(`${file.relativePath} is a symbolic link`);
      continue;
    }
    if (!stat.isFile()) {
      blockers.push(`${file.relativePath} is not a regular file`);
      continue;
    }
    const actual = createHash("sha256")
      .update(await readFile(absolutePath))
      .digest("hex");
    if (actual !== file.digest) {
      blockers.push(`${file.relativePath} has a digest mismatch`);
      continue;
    }
    files.push({ ...file, absolutePath, status: "removable" });
  }

  let pathMutation: DirectUninstallPlan["pathMutation"];
  if (
    manifest.pathMutation &&
    manifest.platform === "posix" &&
    "profilePath" in manifest.pathMutation
  ) {
    const mutation = manifest.pathMutation;
    const stat = await optionalLstat(mutation.profilePath);
    if (!stat) {
      pathMutation = { ...mutation, status: "absent" };
    } else if (stat.isSymbolicLink() || !stat.isFile()) {
      pathMutation = { ...mutation, status: "preserved" };
    } else {
      try {
        const contents = await readFile(mutation.profilePath);
        const count = countOccurrences(contents, Buffer.from(mutation.insertedBytes));
        pathMutation = {
          ...mutation,
          status: count === 1 ? "removable" : count === 0 ? "absent" : "preserved",
        };
      } catch {
        pathMutation = { ...mutation, status: "preserved" };
      }
    }
  } else if (
    manifest.pathMutation &&
    manifest.platform === "windows" &&
    "entry" in manifest.pathMutation
  ) {
    pathMutation = {
      ...manifest.pathMutation,
      status: manifest.pathMutation.created ? "removable" : "preserved",
    };
  }

  if (blockers.length > 0) {
    throw new Error(`Direct uninstall preflight refused:\n- ${blockers.join("\n- ")}`);
  }
  return {
    files,
    installDirectory: canonicalDirectory,
    manifest,
    manifestPath: join(canonicalDirectory, MANIFEST_NAME),
    ...(pathMutation ? { pathMutation } : {}),
  };
}

export async function applyDirectUninstall(
  plan: DirectUninstallPlan,
  options: { removeFile?: (path: string) => Promise<void> } = {},
): Promise<void> {
  const freshPlan = await planDirectUninstall(plan.manifest.installDirectory);
  const removeFile = options.removeFile ?? ((path: string) => rm(path));
  if (freshPlan.pathMutation?.status === "removable" && "profilePath" in freshPlan.pathMutation) {
    const stat = await optionalLstat(freshPlan.pathMutation.profilePath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("PATH profile changed after preflight.");
    }
    const contents = await readFile(freshPlan.pathMutation.profilePath);
    const insertedBytes = Buffer.from(freshPlan.pathMutation.insertedBytes);
    if (countOccurrences(contents, insertedBytes) !== 1) {
      throw new Error("PATH profile changed after preflight.");
    }
    const offset = contents.indexOf(insertedBytes);
    await writeFile(
      freshPlan.pathMutation.profilePath,
      Buffer.concat([
        contents.subarray(0, offset),
        contents.subarray(offset + insertedBytes.length),
      ]),
    );
  }
  for (const file of freshPlan.files) {
    if (file.status === "removable") await removeFile(file.absolutePath);
  }
  await removeFile(freshPlan.manifestPath);
}
