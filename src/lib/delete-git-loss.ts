import { exec as gitExec, execRaw as gitExecRaw } from "./git.ts";
import type { WorktreeRemovalPlan } from "./delete-topology.ts";

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export type GitStatusKind = "tracked" | "conflicted" | "untracked" | "ignored";
export interface GitStatusEvidence {
  kind: GitStatusKind;
  path: string;
  status: string;
}

export interface GitRefEvidence {
  ref: string;
  objectOid: string;
  objectType: string;
  peeledOid: string | null;
  peeledType: string | null;
}

export interface GitLossPlanItem {
  id: string;
  kind: "local-ref";
  ownership: "delete";
  path: null;
  ref: string;
  oid: string;
  planned: true;
  completed: false;
  state: "planned";
  reasonCode: string | null;
  message: null;
}

export interface GitLossInspection {
  items: GitLossPlanItem[];
  warnings: string[];
}

export class GitLossEvidenceError extends Error {
  constructor(message: string) {
    super(`DELETE_GIT_DATA_LOSS: ${message}`);
    this.name = "GitLossEvidenceError";
  }
}

const statusError = (message: string): never => {
  throw new GitLossEvidenceError(`Git status evidence is malformed: ${message}`);
};

const refError = (message: string): never => {
  throw new GitLossEvidenceError(`Git ref evidence is malformed: ${message}`);
};

export const parsePorcelainV2StatusZ = (input: Uint8Array | string): GitStatusEvidence[] => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) statusError("output is not NUL terminated");
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    statusError("output is not valid UTF-8");
  }
  const records = text.slice(0, -1).split("\0");
  const result: GitStatusEvidence[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) statusError("empty record");
    const recordType = record[0];
    if (recordType === "1") {
      const match =
        /^1 (\S{2}) \S+ [0-7]{6} [0-7]{6} [0-7]{6} ([0-9a-f]+) ([0-9a-f]+) (.+)$/u.exec(record) ??
        statusError("invalid ordinary tracked record");
      if (!OID.test(match[2]!) || !OID.test(match[3]!))
        statusError("invalid ordinary tracked record");
      result.push({ kind: "tracked", path: match[4]!, status: match[1]! });
      continue;
    }
    if (recordType === "2") {
      const match =
        /^2 (\S{2}) \S+ [0-7]{6} [0-7]{6} [0-7]{6} ([0-9a-f]+) ([0-9a-f]+) [RC]\d+ (.+)$/u.exec(
          record,
        ) ?? statusError("invalid rename/copy record");
      if (!OID.test(match[2]!) || !OID.test(match[3]!)) statusError("invalid rename/copy record");
      const originalPath = records[index + 1];
      if (!originalPath) statusError("rename/copy original path is unavailable");
      index += 1;
      result.push({ kind: "tracked", path: match[4]!, status: match[1]! });
      continue;
    }
    if (recordType === "u") {
      const match =
        /^u (\S{2}) \S+ [0-7]{6} [0-7]{6} [0-7]{6} [0-7]{6} ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$/u.exec(
          record,
        ) ?? statusError("invalid unmerged record");
      if (!OID.test(match[2]!) || !OID.test(match[3]!) || !OID.test(match[4]!))
        statusError("invalid unmerged record");
      result.push({ kind: "conflicted", path: match[5]!, status: match[1]! });
      continue;
    }
    if (recordType === "?" || recordType === "!") {
      if (!record.startsWith(`${recordType} `) || record.length < 3)
        statusError("invalid untracked/ignored record");
      result.push({
        kind: recordType === "?" ? "untracked" : "ignored",
        path: record.slice(2),
        status: recordType,
      });
      continue;
    }
    if (recordType === "#") continue;
    statusError(`unknown record type ${recordType ?? "<empty>"}`);
  }
  return result;
};

export const parseGitRefInventory = (input: Uint8Array | string): GitRefEvidence[] => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0x0a) refError("output is not newline terminated");
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refError("output is not valid UTF-8");
  }
  const lines = text.slice(0, -1).split("\n");
  const seen = new Set<string>();
  return lines.map((line) => {
    const fields = line.split("\0");
    if (fields.length !== 5) refError("record does not have five fields");
    const [ref, objectOid, objectType, peeledOidRaw, peeledTypeRaw] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^(?:refs\/heads\/.+|refs\/tags\/.+|refs\/remotes\/.+|refs\/stash)$/u.test(ref))
      refError(`unexpected ref ${ref}`);
    if (seen.has(ref)) refError(`duplicate ref ${ref}`);
    seen.add(ref);
    if (!OID.test(objectOid)) refError(`invalid object ID for ${ref}`);
    const peeledOid = peeledOidRaw || null;
    const peeledType = peeledTypeRaw || null;
    if ((peeledOid === null) !== (peeledType === null))
      refError(`incomplete peeled evidence for ${ref}`);
    if (peeledOid && !OID.test(peeledOid)) refError(`invalid peeled object ID for ${ref}`);
    if (ref.startsWith("refs/tags/")) {
      if (objectType === "commit") {
        if (peeledOid || peeledType)
          refError(`lightweight tag has unexpected peeled fields: ${ref}`);
      } else if (objectType === "tag") {
        if (!peeledOid || peeledType !== "commit")
          refError(`tag does not peel to a commit: ${ref}`);
      } else {
        refError(`tag does not identify a commit: ${ref}`);
      }
    } else if (objectType !== "commit" || peeledOid || peeledType) {
      refError(`commit ref has unusable object evidence: ${ref}`);
    }
    return { objectOid, objectType, peeledOid, peeledType, ref };
  });
};

const planItem = (ref: string, oid: string, protectedData: boolean): GitLossPlanItem => ({
  id: "",
  kind: "local-ref",
  ownership: "delete",
  path: null,
  ref,
  oid,
  planned: true,
  completed: false,
  state: "planned",
  reasonCode: protectedData ? "DELETE_GIT_DATA_LOSS" : null,
  message: null,
});

export const analyzeLocalRefLoss = async (input: {
  refs: readonly GitRefEvidence[];
  detachedCommits: readonly string[];
  isReachableFromRemote: (candidateOid: string, remoteOids: readonly string[]) => Promise<boolean>;
}): Promise<GitLossInspection> => {
  const refs = [...input.refs].toSorted((left, right) => bytewise(left.ref, right.ref));
  const remoteOids = [
    ...new Set(
      refs.filter(({ ref }) => ref.startsWith("refs/remotes/")).map(({ objectOid }) => objectOid),
    ),
  ].toSorted(bytewise);
  if (remoteOids.length === 0)
    throw new GitLossEvidenceError("remote-tracking commit evidence is unavailable");

  const candidates: Array<{ ref: string; oid: string; blocks: boolean }> = [];
  for (const evidence of refs) {
    if (evidence.ref.startsWith("refs/remotes/")) continue;
    if (evidence.ref.startsWith("refs/tags/")) {
      const commitOid = evidence.peeledOid ?? evidence.objectOid;
      candidates.push({ blocks: false, oid: evidence.objectOid, ref: evidence.ref });
      candidates.push({ blocks: true, oid: commitOid, ref: `${evidence.ref}^{}` });
    } else {
      candidates.push({ blocks: true, oid: evidence.objectOid, ref: evidence.ref });
    }
  }
  for (const detached of [...new Set(input.detachedCommits)].toSorted(bytewise)) {
    if (!OID.test(detached))
      throw new GitLossEvidenceError("detached checked-out commit evidence is malformed");
    candidates.push({ blocks: true, oid: detached, ref: "HEAD(detached)" });
  }

  const outcomes: Array<{ candidate: (typeof candidates)[number]; protectedData: boolean }> = [];
  for (const candidate of candidates) {
    let protectedData = false;
    if (candidate.blocks) {
      try {
        protectedData = !(await input.isReachableFromRemote(candidate.oid, remoteOids));
      } catch {
        throw new GitLossEvidenceError("Git reachability evidence is unavailable");
      }
    }
    outcomes.push({ candidate, protectedData });
  }
  const items = outcomes.map(({ candidate, protectedData }) =>
    planItem(candidate.ref, candidate.oid, protectedData),
  );
  const warnings = outcomes
    .filter(({ protectedData }) => protectedData)
    .map(
      ({ candidate }) =>
        `DELETE_GIT_DATA_LOSS: ${candidate.ref} ${candidate.oid} is not reachable from local remote-tracking refs`,
    );
  warnings.push(
    "DELETE_GIT_REFLOG_BOUNDARY: reflog-only unreachable objects are outside the local publication check",
    "DELETE_GIT_REMOTE_EVIDENCE: reachability uses local remote-tracking refs only; no fetch was performed",
  );
  return { items, warnings: warnings.toSorted(bytewise) };
};

export const inspectRepositoryGitLoss = async (
  topology: WorktreeRemovalPlan,
): Promise<GitLossInspection> => {
  const warnings: string[] = [];
  const presentWorktrees = topology.inventory
    .filter(({ bare, present }) => present && !bare)
    .toSorted((left, right) => bytewise(left.path, right.path));
  try {
    for (const worktree of presentWorktrees) {
      const output = (
        await gitExecRaw(
          ["status", "--porcelain=v2", "-z", "--ignored=matching", "--untracked-files=all"],
          worktree.path,
        )
      ).stdout;
      for (const status of parsePorcelainV2StatusZ(output)) {
        warnings.push(
          `DELETE_GIT_DATA_LOSS: ${worktree.path}: ${status.kind} ${status.status} ${status.path}`,
        );
      }
    }

    const inventoryOutput = (
      await gitExecRaw(
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
          "refs/heads",
          "refs/tags",
          "refs/remotes",
          "refs/stash",
        ],
        topology.primaryPath,
      )
    ).stdout;
    const refs = parseGitRefInventory(inventoryOutput);
    const detachedCommits = topology.inventory
      .filter(({ detached, head, present }) => detached && present && head !== null)
      .map(({ head }) => head!);
    for (const detached of new Set(detachedCommits)) {
      const resolved = (
        await gitExec(["rev-parse", "--verify", `${detached}^{commit}`], topology.primaryPath)
      ).stdout.trim();
      if (resolved !== detached)
        throw new GitLossEvidenceError("detached commit object is unavailable");
    }
    const refsLoss = await analyzeLocalRefLoss({
      detachedCommits,
      refs,
      isReachableFromRemote: async (candidateOid, remoteOids) => {
        const count = (
          await gitExec(
            ["rev-list", "--count", candidateOid, "--not", ...remoteOids],
            topology.primaryPath,
          )
        ).stdout.trim();
        if (!/^\d+$/u.test(count)) throw new Error("invalid rev-list count");
        return count === "0";
      },
    });
    return {
      items: refsLoss.items,
      warnings: [...warnings, ...refsLoss.warnings].toSorted(bytewise),
    };
  } catch (error) {
    if (error instanceof GitLossEvidenceError) throw error;
    throw new GitLossEvidenceError("Git status, ref, or object evidence is unavailable");
  }
};
