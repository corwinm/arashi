import { isAbsolute, relative, resolve, sep } from "node:path";

export type MaterializationAction = "copy" | "symlink";
export type MaterializationSourceKind = "directory" | "file";
export type MaterializationReasonCode =
  | "none"
  | "source_missing"
  | "source_checkout_unavailable"
  | "source_inspection_failed"
  | "source_link_broken"
  | "source_escape"
  | "source_cycle"
  | "destination_exists"
  | "destination_ancestor_unsafe"
  | "destination_inspection_failed"
  | "symlink_unsupported"
  | "copy_failed"
  | "symlink_failed"
  | "rolled_back"
  | "rollback_failed";

export type PlannedMaterializationStatus = "blocked" | "skipped" | "would-copy" | "would-link";
export type ExecutedMaterializationStatus =
  | "copied"
  | "linked"
  | "skipped"
  | "failed"
  | "rolled-back";

export interface PlannedMaterializationOutcome {
  action: MaterializationAction;
  message: string;
  path: string;
  reasonCode: MaterializationReasonCode;
  status: PlannedMaterializationStatus;
}

export interface ExecutedMaterializationOutcome {
  action: MaterializationAction;
  message: string;
  path: string;
  reasonCode: MaterializationReasonCode;
  status: ExecutedMaterializationStatus;
}

export interface RepositoryMaterializationPlan {
  classification: "actionable" | "blocked";
  outcomes: readonly PlannedMaterializationOutcome[];
  repositoryId: string;
  targetOid: string;
}

export interface MaterializationPlannerInput {
  copy: readonly string[];
  destinationRoot: string;
  dryRun: boolean;
  platform: NodeJS.Platform;
  repositoryId: string;
  sourceRoot: string;
  symlink: readonly string[];
  targetOid: string;
}

export type SourceInspection =
  | { status: "missing" }
  | {
      canonicalPath: string;
      kind: MaterializationSourceKind;
      links?: ReadonlyArray<{
        ancestorCanonicalIdentities?: readonly string[];
        canonicalIdentity: string;
        path: string;
        target: string;
      }>;
      status: "present";
    };

export type DestinationInspection =
  | { status: "absent" }
  | { kind: "directory" | "file" | "symlink" | "junction"; status: "present" }
  | {
      ancestor: string;
      kind: "file" | "symlink" | "junction";
      status: "ancestor-unsafe";
    };

export type TargetTreeInspection =
  | { status: "absent" }
  | {
      kind: "directory" | "file" | "symlink";
      matchedPath: string;
      status: "present";
    };

export interface MaterializationPlannerDependencies {
  inspectDestination(path: string): Promise<DestinationInspection>;
  inspectSource(path: string, action: MaterializationAction): Promise<SourceInspection>;
  inspectTargetTree(targetOid: string, path: string): Promise<TargetTreeInspection>;
  resolveSymlinkCapability(kind: MaterializationSourceKind): Promise<"supported" | "unsupported">;
}

const WINDOWS_DEVICE_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DRIVE_PREFIX = /^[a-z]:/i;

export interface NormalizedMaterializationPath {
  collisionKey: string;
  path: string;
}

export function normalizeMaterializationPath(rawPath: string): NormalizedMaterializationPath {
  if (rawPath.includes("\0")) throw new Error("must not contain NUL");
  if (DRIVE_PREFIX.test(rawPath)) throw new Error("must not be drive-qualified or absolute");
  if (/^[\\/]{2}/.test(rawPath)) throw new Error("must not be a UNC or rooted path");
  if (/^[\\/]/.test(rawPath) || isAbsolute(rawPath)) throw new Error("must be a relative path");
  if (rawPath.includes(":")) throw new Error("must not contain ':'");

  const rawComponents = rawPath.split(/[\\/]+/);
  if (rawComponents.includes("..")) throw new Error("must not contain '..' segments");
  const components = rawComponents.filter((component) => component !== "" && component !== ".");
  if (components.length === 0) throw new Error("must not be empty after normalization");
  if (components.some((component) => /[. ]$/.test(component))) {
    throw new Error("components must not end in dot or space");
  }
  if (components.some((component) => WINDOWS_DEVICE_COMPONENT.test(component))) {
    throw new Error("must not contain a Windows reserved device component");
  }

  const path = components.join("/").normalize("NFC");
  if (path.length === 0) throw new Error("must not be empty after normalization");
  const collisionKey = path.toLocaleUpperCase("en-US").toLocaleLowerCase("en-US").normalize("NFC");
  return { collisionKey, path };
}

export function resolveMaterializationPath(root: string, normalizedPath: string): string {
  const absoluteRoot = resolve(root);
  const destination = resolve(absoluteRoot, ...normalizedPath.split("/"));
  const fromRoot = relative(absoluteRoot, destination);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("resolved materialization path escapes its repository root");
  }
  return destination;
}

function boundedOutcome(
  action: MaterializationAction,
  path: string,
  status: PlannedMaterializationStatus,
  reasonCode: MaterializationReasonCode,
  message: string,
): PlannedMaterializationOutcome {
  return Object.freeze({ action, message, path, reasonCode, status });
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function sourceLinkFailure(
  sourceRoot: string,
  lexicalSourcePath: string,
  inspection: Extract<SourceInspection, { status: "present" }>,
): MaterializationReasonCode | null {
  if (!isContained(sourceRoot, inspection.canonicalPath)) return "source_escape";
  for (const link of inspection.links ?? []) {
    if (!link.canonicalIdentity) return "source_link_broken";
    if (!isContained(sourceRoot, link.canonicalIdentity)) return "source_escape";
    const canonicalIdentity = resolve(link.canonicalIdentity);
    if (
      canonicalIdentity === resolve(lexicalSourcePath) ||
      (link.ancestorCanonicalIdentities ?? []).some(
        (ancestor) => resolve(ancestor) === canonicalIdentity,
      )
    ) {
      return "source_cycle";
    }
  }
  return null;
}

function findPortableCollisions(
  entries: ReadonlyArray<{ action: MaterializationAction; path: string }>,
): Set<number> {
  const collisions = new Set<number>();
  const seen = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    try {
      const key = normalizeMaterializationPath(entry.path).collisionKey;
      const previous = seen.get(key);
      if (previous !== undefined) {
        collisions.add(previous);
        collisions.add(index);
      } else {
        seen.set(key, index);
      }
    } catch {
      collisions.add(index);
    }
  }
  return collisions;
}

export async function planRepositoryMaterialization(
  input: MaterializationPlannerInput,
  dependencies: MaterializationPlannerDependencies,
): Promise<RepositoryMaterializationPlan> {
  const entries = [
    ...input.copy.map((path) => ({ action: "copy" as const, path })),
    ...input.symlink.map((path) => ({ action: "symlink" as const, path })),
  ];
  const collisions = findPortableCollisions(entries);
  const outcomes: PlannedMaterializationOutcome[] = [];

  for (const [index, entry] of entries.entries()) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeMaterializationPath(entry.path).path;
    } catch {
      outcomes.push(
        boundedOutcome(
          entry.action,
          entry.path,
          "blocked",
          "destination_exists",
          "Invalid materialization path",
        ),
      );
      continue;
    }
    if (collisions.has(index)) {
      outcomes.push(
        boundedOutcome(
          entry.action,
          normalizedPath,
          "blocked",
          "destination_exists",
          "Portable destination collision",
        ),
      );
      continue;
    }

    const sourcePath = resolveMaterializationPath(input.sourceRoot, normalizedPath);
    const destinationPath = resolveMaterializationPath(input.destinationRoot, normalizedPath);
    let source: SourceInspection;
    try {
      source = await dependencies.inspectSource(sourcePath, entry.action);
    } catch {
      outcomes.push(
        boundedOutcome(
          entry.action,
          normalizedPath,
          "blocked",
          "source_inspection_failed",
          "Source could not be inspected",
        ),
      );
      continue;
    }
    if (source.status === "missing") {
      outcomes.push(
        boundedOutcome(
          entry.action,
          normalizedPath,
          "skipped",
          "source_missing",
          "Source is missing; entry is optional",
        ),
      );
      continue;
    }

    const linkFailure = sourceLinkFailure(input.sourceRoot, sourcePath, source);
    if (linkFailure) {
      outcomes.push(
        boundedOutcome(
          entry.action,
          normalizedPath,
          "blocked",
          linkFailure,
          "Source link is unsafe",
        ),
      );
      continue;
    }

    try {
      const targetTree = await dependencies.inspectTargetTree(input.targetOid, normalizedPath);
      if (targetTree.status === "present") {
        outcomes.push(
          boundedOutcome(
            entry.action,
            normalizedPath,
            "blocked",
            "destination_exists",
            "Target Git tree contains the destination or an incompatible ancestor",
          ),
        );
        continue;
      }
    } catch {
      outcomes.push(
        boundedOutcome(
          entry.action,
          normalizedPath,
          "blocked",
          "destination_inspection_failed",
          "Target Git tree could not be inspected",
        ),
      );
      continue;
    }

    try {
      const destination = await dependencies.inspectDestination(destinationPath);
      if (destination.status === "present") {
        outcomes.push(
          boundedOutcome(
            entry.action,
            normalizedPath,
            "blocked",
            "destination_exists",
            "Destination already exists",
          ),
        );
        continue;
      }
      if (destination.status === "ancestor-unsafe") {
        outcomes.push(
          boundedOutcome(
            entry.action,
            normalizedPath,
            "blocked",
            "destination_ancestor_unsafe",
            "Destination ancestor is not a real directory",
          ),
        );
        continue;
      }
    } catch {
      outcomes.push(
        boundedOutcome(
          entry.action,
          normalizedPath,
          "blocked",
          "destination_inspection_failed",
          "Destination could not be inspected",
        ),
      );
      continue;
    }

    if (entry.action === "symlink") {
      try {
        if ((await dependencies.resolveSymlinkCapability(source.kind)) === "unsupported") {
          outcomes.push(
            boundedOutcome(
              entry.action,
              normalizedPath,
              "blocked",
              "symlink_unsupported",
              "Native symbolic links are unavailable",
            ),
          );
          continue;
        }
      } catch {
        outcomes.push(
          boundedOutcome(
            entry.action,
            normalizedPath,
            "blocked",
            "symlink_unsupported",
            "Native symbolic-link capability could not be established",
          ),
        );
        continue;
      }
    }

    outcomes.push(
      boundedOutcome(
        entry.action,
        normalizedPath,
        entry.action === "copy" ? "would-copy" : "would-link",
        "none",
        `Would ${entry.action} '${normalizedPath}'`,
      ),
    );
  }

  const frozenOutcomes = Object.freeze(outcomes);
  return Object.freeze({
    classification: outcomes.some(({ status }) => status === "blocked") ? "blocked" : "actionable",
    outcomes: frozenOutcomes,
    repositoryId: input.repositoryId,
    targetOid: input.targetOid,
  });
}
