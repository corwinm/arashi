import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { exec } from "./git.ts";
import {
  classifyRegularMaterializationSource,
  normalizeMaterializationPath,
  planRepositoryMaterialization,
  portableMaterializationCollisionKey,
  resolveMaterializationPath,
  type DestinationInspection,
  type MaterializationAction,
  type MaterializationPlannerInput,
  type RepositoryMaterializationPlan,
  type SourceInspection,
  type TargetTreeInspection,
} from "./materialization.ts";

const missing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const copiedEntriesMatch = async (source: string, destination: string): Promise<boolean> => {
  try {
    const [sourceStat, destinationStat] = await Promise.all([lstat(source), lstat(destination)]);
    if (sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
      return (
        sourceStat.isSymbolicLink() &&
        destinationStat.isSymbolicLink() &&
        (await readlink(source)) === (await readlink(destination))
      );
    }
    if (sourceStat.isFile() || destinationStat.isFile()) {
      return (
        sourceStat.isFile() &&
        destinationStat.isFile() &&
        (await readFile(source)).equals(await readFile(destination))
      );
    }
    if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) return false;
    const [sourceEntries, destinationEntries] = await Promise.all([
      readdir(source),
      readdir(destination),
    ]);
    sourceEntries.sort();
    destinationEntries.sort();
    if (sourceEntries.join("\0") !== destinationEntries.join("\0")) return false;
    return (
      await Promise.all(
        sourceEntries.map((entry) =>
          copiedEntriesMatch(join(source, entry), join(destination, entry)),
        ),
      )
    ).every(Boolean);
  } catch {
    return false;
  }
};

export async function preserveCorrectReusableMaterialization(input: {
  copy: readonly string[];
  destinationRoot: string;
  plan: RepositoryMaterializationPlan;
  sourceRoot: string;
  symlink: readonly string[];
}): Promise<RepositoryMaterializationPlan> {
  const copyPaths = new Set(input.copy.map((path) => normalizeMaterializationPath(path).path));
  const symlinkPaths = new Set(
    input.symlink.map((path) => normalizeMaterializationPath(path).path),
  );
  const outcomes = await Promise.all(
    input.plan.outcomes.map(async (outcome) => {
      if (outcome.status !== "blocked" || outcome.reasonCode !== "destination_exists")
        return outcome;
      const source = resolveMaterializationPath(input.sourceRoot, outcome.path);
      const destination = resolveMaterializationPath(input.destinationRoot, outcome.path);
      let correct = false;
      if (copyPaths.has(outcome.path)) {
        correct = await copiedEntriesMatch(source, destination);
      } else if (symlinkPaths.has(outcome.path)) {
        try {
          correct =
            (await lstat(destination)).isSymbolicLink() && (await readlink(destination)) === source;
        } catch {
          correct = false;
        }
      }
      return correct
        ? {
            ...outcome,
            message: "Existing materialization is already correct",
            reasonCode: "none" as const,
            status: "skipped" as const,
          }
        : outcome;
    }),
  );
  return {
    ...input.plan,
    classification: outcomes.some((outcome) => outcome.status === "blocked")
      ? "blocked"
      : "actionable",
    outcomes,
  };
}

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
  probeBasePath?: string;
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = resolve(path);
  while (true) {
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isDirectory()) {
        throw new Error(`Symlink capability probe ancestor is not a directory: ${candidate}`);
      }
      return realpath(candidate);
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export async function resolveNativeSymlinkCapability(
  kind: "directory" | "file",
  dependencies: NativeSymlinkCapabilityDependencies = {},
): Promise<"supported" | "unsupported"> {
  const createProbeRoot = async (): Promise<string> => {
    const probeParent =
      dependencies.probeBasePath === undefined
        ? tmpdir()
        : await nearestExistingDirectory(dirname(resolve(dependencies.probeBasePath)));
    return mkdtemp(join(probeParent, ".arashi-symlink-probe-"));
  };
  const probeRoot = await (dependencies.createProbeRoot ?? createProbeRoot)();
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

export async function inspectMaterializationSourceTree(
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
  const kind = classifyRegularMaterializationSource(await stat(sourcePath));
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
      const followedKind = classifyRegularMaterializationSource(await stat(path));
      if (followedKind !== "directory") return;
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
  let candidateTrees: { matchedComponents: string[]; oid: string }[] = [
    { matchedComponents: [], oid: targetOid },
  ];
  for (let index = 0; index < components.length; index += 1) {
    const expectedKey = portableMaterializationCollisionKey(components[index]!);
    const matches: { kind: string; matchedComponents: string[]; oid: string }[] = [];
    for (const tree of candidateTrees) {
      const result = await exec(["ls-tree", "-z", tree.oid], repositoryPath);
      for (const record of result.stdout.split("\0")) {
        if (record === "") continue;
        const separatorIndex = record.indexOf("\t");
        if (separatorIndex < 0) throw new Error("Invalid git ls-tree output");
        const metadata = record.slice(0, separatorIndex).split(" ");
        const name = record.slice(separatorIndex + 1);
        if (portableMaterializationCollisionKey(name) !== expectedKey) continue;
        matches.push({
          kind: metadata[1] ?? "",
          matchedComponents: [...tree.matchedComponents, name],
          oid: metadata[2] ?? "",
        });
      }
    }
    if (matches.length === 0) return { status: "absent" };
    if (matches.length > 1) {
      const ambiguous = matches[0]!;
      return {
        kind: ambiguous.kind === "tree" ? "directory" : "file",
        matchedPath: ambiguous.matchedComponents.join("/"),
        status: "present",
      };
    }
    const final = index === components.length - 1;
    const incompatible = matches.find((match) => final || match.kind !== "tree");
    if (incompatible) {
      return {
        kind:
          incompatible.kind === "tree"
            ? "directory"
            : incompatible.kind === "commit"
              ? "symlink"
              : "file",
        matchedPath: incompatible.matchedComponents.join("/"),
        status: "present",
      };
    }
    candidateTrees = matches.map(({ matchedComponents, oid }) => ({ matchedComponents, oid }));
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
      inspectMaterializationSourceTree(input.sourceRoot, path),
    inspectTargetTree: (targetOid, path) =>
      inspectTargetTree(input.repositoryPath, targetOid, path),
    resolveSymlinkCapability: (kind) => {
      const existing = symlinkCapabilities.get(kind);
      if (existing !== undefined) return existing;
      const capability = resolveNativeSymlinkCapability(kind, {
        probeBasePath: input.destinationRoot,
      });
      symlinkCapabilities.set(kind, capability);
      return capability;
    },
  });
}
