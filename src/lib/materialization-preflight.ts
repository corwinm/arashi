import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { exec } from "./git.ts";
import {
  planRepositoryMaterialization,
  type DestinationInspection,
  type MaterializationAction,
  type MaterializationPlannerInput,
  type RepositoryMaterializationPlan,
  type SourceInspection,
  type TargetTreeInspection,
} from "./materialization.ts";

const missing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const contained = (root: string, candidate: string): boolean => {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
};

const unsupportedSymlink = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"].includes(String(error.code));

export interface NativeSymlinkCapabilityDependencies {
  createProbeRoot?: () => Promise<string>;
  createSymlink?: (target: string, path: string, kind: "dir" | "file") => Promise<void>;
}

export async function resolveNativeSymlinkCapability(
  kind: "directory" | "file",
  dependencies: NativeSymlinkCapabilityDependencies = {},
): Promise<"supported" | "unsupported"> {
  const probeRoot = await (
    dependencies.createProbeRoot ?? (() => mkdtemp(join(tmpdir(), "arashi-symlink-probe-")))
  )();
  try {
    const target = join(probeRoot, "target");
    const link = join(probeRoot, "link");
    if (kind === "directory") await mkdir(target);
    else await writeFile(target, "");
    try {
      await (dependencies.createSymlink ?? symlink)(
        target,
        link,
        kind === "directory" ? "dir" : "file",
      );
    } catch (error) {
      if (unsupportedSymlink(error)) return "unsupported";
      throw error;
    }
    return "supported";
  } finally {
    await rm(probeRoot, { force: true, recursive: true });
  }
}

async function inspectSourceTree(
  sourceRoot: string,
  sourcePath: string,
): Promise<SourceInspection> {
  try {
    await lstat(sourcePath);
  } catch (error) {
    if (missing(error)) return { status: "missing" };
    throw error;
  }

  const canonicalPath = await realpath(sourcePath);
  const kind = (await stat(sourcePath)).isDirectory() ? "directory" : "file";
  const links: NonNullable<Extract<SourceInspection, { status: "present" }>["links"]>[number][] =
    [];
  if (kind === "directory") {
    const completed = new Set<string>();
    const visit = async (path: string, active: readonly string[]): Promise<void> => {
      const lexical = await lstat(path);
      let canonicalIdentity: string;
      try {
        canonicalIdentity = await realpath(path);
      } catch (error) {
        if (lexical.isSymbolicLink() && missing(error)) {
          links.push({
            canonicalIdentity: "",
            path,
            target: await import("node:fs/promises").then(({ readlink }) => readlink(path)),
          });
          return;
        }
        throw error;
      }
      if (lexical.isSymbolicLink()) {
        links.push({
          ancestorCanonicalIdentities: active,
          canonicalIdentity,
          path,
          target: await import("node:fs/promises").then(({ readlink }) => readlink(path)),
        });
      }
      const followed = await stat(path);
      if (!followed.isDirectory()) return;
      if (active.some((ancestor) => resolve(ancestor) === resolve(canonicalIdentity))) return;
      if (completed.has(canonicalIdentity)) return;
      const nextActive = [...active, canonicalIdentity];
      for (const child of await readdir(path)) await visit(resolve(path, child), nextActive);
      completed.add(canonicalIdentity);
    };
    await visit(sourcePath, []);
  }
  return { canonicalPath, kind, links, status: "present" };
}

async function inspectDestination(root: string, path: string): Promise<DestinationInspection> {
  const components = relative(root, path).split(sep).filter(Boolean);
  let current = resolve(root);
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    try {
      const entry = await lstat(current);
      const final = index === components.length - 1;
      if (final) {
        const kind = entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : "file";
        return { kind, status: "present" };
      }
      if (entry.isSymbolicLink())
        return { ancestor: current, kind: "symlink", status: "ancestor-unsafe" };
      if (!entry.isDirectory())
        return { ancestor: current, kind: "file", status: "ancestor-unsafe" };
    } catch (error) {
      if (missing(error)) return { status: "absent" };
      throw error;
    }
  }
  return { status: "absent" };
}

async function inspectTargetTree(
  repositoryPath: string,
  targetOid: string,
  path: string,
): Promise<TargetTreeInspection> {
  const components = path.split("/");
  for (let length = 1; length <= components.length; length += 1) {
    const candidate = components.slice(0, length).join("/");
    const result = await exec(["ls-tree", "-z", targetOid, "--", candidate], repositoryPath);
    if (result.stdout.length === 0) continue;
    const metadata = result.stdout.slice(0, result.stdout.indexOf("\t"));
    const kind = metadata.split(" ")[1];
    const final = length === components.length;
    if (final || kind !== "tree") {
      return {
        kind: kind === "tree" ? "directory" : kind === "commit" ? "symlink" : "file",
        matchedPath: candidate,
        status: "present",
      };
    }
  }
  return { status: "absent" };
}

export interface PlanConfiguredMaterializationInput extends MaterializationPlannerInput {
  repositoryPath: string;
}

export async function planConfiguredRepositoryMaterialization(
  input: PlanConfiguredMaterializationInput,
): Promise<RepositoryMaterializationPlan> {
  if (
    !contained(input.sourceRoot, input.sourceRoot) ||
    !contained(input.destinationRoot, input.destinationRoot)
  ) {
    throw new Error("Materialization roots are invalid");
  }
  const symlinkCapabilities = new Map<"directory" | "file", Promise<"supported" | "unsupported">>();
  return planRepositoryMaterialization(input, {
    inspectDestination: (path) => inspectDestination(input.destinationRoot, path),
    inspectSource: (path, _action: MaterializationAction) =>
      inspectSourceTree(input.sourceRoot, path),
    inspectTargetTree: (targetOid, path) =>
      inspectTargetTree(input.repositoryPath, targetOid, path),
    resolveSymlinkCapability: (kind) => {
      const existing = symlinkCapabilities.get(kind);
      if (existing !== undefined) return existing;
      const capability = resolveNativeSymlinkCapability(kind);
      symlinkCapabilities.set(kind, capability);
      return capability;
    },
  });
}
