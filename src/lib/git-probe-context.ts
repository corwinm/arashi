import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { RemoteTrackingTarget, RemoteTrackingFetchResult } from "./git-remote.ts";

export interface ProbeCall {
  executable: string;
  argv: string[];
  cwd: string;
  environment: Record<string, string>;
  parser: string;
  attemptToken: number | null;
  generation: number;
  repository: string | null;
  purpose: string;
}
export interface ProbeAuditEntry extends ProbeCall {
  contextId: string;
  parserOwner: string;
  repositoryAttribution: "canonical" | "provisional";
}
export interface ProbeResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}
export interface GitIdentity {
  repositoryKey: string;
  worktreeKey: string;
  topLevel: string | null;
  bare: boolean;
  cwd: string;
}
export interface ConfigEntry {
  scope: string;
  origin: Buffer;
  key: string;
  value: Buffer | null;
}
export interface EffectiveConfig {
  bytes: Buffer;
  entries: ConfigEntry[];
}
export interface RefFact {
  oid: string;
  symref: string;
  ahead: number | null;
  behind: number | null;
}
const failure = (probe: string) => new Error(`Git ${probe} probe failed`);
const decode = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure("output framing");
  }
};
const lines = (bytes: Buffer, count: number): string[] => {
  const text = decode(bytes);
  if (text.includes("\0")) throw failure("identity");
  const fields = text.replace(/\n$/, "").split("\n");
  if (fields.length !== count || fields.some((field) => !field || field.includes("\r")))
    throw failure("identity");
  return fields;
};
export async function parseIdentity(
  bytes: Buffer,
  cwd: string,
  canonicalize: (path: string) => Promise<string> = realpath,
  bare = false,
): Promise<GitIdentity> {
  const fields = lines(bytes, bare ? 2 : 3);
  if (fields[bare ? 1 : 2] !== (bare ? "true" : "false")) throw failure("identity");
  try {
    const repositoryKey = await canonicalize(resolve(cwd, fields[bare ? 0 : 1]!));
    const topLevel = bare ? null : await canonicalize(resolve(cwd, fields[0]!));
    return {
      repositoryKey,
      topLevel,
      bare,
      cwd: topLevel ?? cwd,
      worktreeKey: JSON.stringify([repositoryKey, bare ? ["bare"] : ["worktree", topLevel]]),
    };
  } catch {
    throw failure("identity");
  }
}
const nulFields = (bytes: Buffer): Buffer[] => {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw failure("output framing");
  const fields: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 0) {
      fields.push(bytes.subarray(offset, i));
      offset = i + 1;
    }
  return fields;
};
export function parseEffectiveConfig(bytes: Buffer): EffectiveConfig {
  const fields = nulFields(bytes);
  if (fields.length % 3) throw failure("configuration");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i < fields.length; i += 3) {
    const scope = decode(fields[i]!);
    const origin = fields[i + 1]!;
    const field = fields[i + 2]!;
    const lf = field.indexOf(10);
    const key = decode(lf < 0 ? field : field.subarray(0, lf));
    if (
      !/^(system|global|local|worktree|command|unknown)$/.test(scope) ||
      !origin.length ||
      !/^[a-z][a-z0-9-]*\.[^\n]+$/i.test(key)
    )
      throw failure("configuration");
    entries.push({ scope, origin, key, value: lf < 0 ? null : field.subarray(lf + 1) });
  }
  return { bytes: Buffer.from(bytes), entries };
}
export function validRef(ref: string): boolean {
  return (
    ref.startsWith("refs/") &&
    ![...ref].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
    !/[~^:?*[\\]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.endsWith(".") &&
    ref.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
export function parseRefSnapshot(bytes: Buffer, comparisons: boolean): Map<string, RefFact> {
  const refs = new Map<string, RefFact>();
  let offset = 0;
  while (offset < bytes.length) {
    const fields: string[] = [];
    for (let i = 0; i < (comparisons ? 4 : 3); i++) {
      const end = bytes.indexOf(0, offset);
      if (end < 0) throw failure("refs");
      fields.push(decode(bytes.subarray(offset, end)));
      offset = end + 1;
    }
    if (bytes[offset++] !== 10) throw failure("refs");
    const [name, oid, symref] = fields;
    if (
      !name ||
      !/^refs\/(heads|remotes)\//.test(name) ||
      !validRef(name) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid!) ||
      (symref && !validRef(symref)) ||
      refs.has(name)
    )
      throw failure("refs");
    let ahead: number | null = null,
      behind: number | null = null;
    if (comparisons) {
      const counts = /^(\d+) (\d+)$/.exec(fields[3]!);
      if (!counts) throw failure("refs");
      behind = Number(counts[1]);
      ahead = Number(counts[2]);
      if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw failure("refs");
    }
    refs.set(name, { oid: oid!, symref: symref!, ahead, behind });
  }
  return refs;
}

/** Rejections are shared while pending, never retained as facts. */
export class RetrySafeCache {
  #entries = new Map<string, Promise<unknown>>();
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#entries.get(key);
    if (existing) return existing as Promise<T>;
    const pending = Promise.resolve().then(load);
    this.#entries.set(key, pending);
    void pending.catch(() => {
      if (this.#entries.get(key) === pending) this.#entries.delete(key);
    });
    return pending;
  }
  delete(key: string): void {
    this.#entries.delete(key);
  }
  clear(): void {
    this.#entries.clear();
  }
}
export interface SpawnRecord {
  repositoryKey: string;
  cwdProjection: string;
  executable: string;
  lookupMode: string;
  environment: Record<string, string>;
  configBytes: Buffer;
  argv: string[];
  endpoint: string;
  stdio: string[];
  timeout: number | null;
  signal: string | null;
  platform: string;
  windowsHide: boolean;
}
export interface Fingerprint {
  readonly bytes: Buffer;
  readonly digest: string;
}
const frame = (parts: Buffer[]): Buffer =>
  Buffer.concat(
    parts.flatMap((part) => {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(part.length));
      return [length, part];
    }),
  );
export function normalizeSpawnRecord(
  record: SpawnRecord,
  digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"),
): Fingerprint {
  const keys = new Set<string>();
  const environment = Object.entries(record.environment)
    .map(([key, value]) => {
      const normalized = record.platform === "win32" ? key.toUpperCase() : key;
      if (keys.has(normalized)) throw failure("environment normalization");
      keys.add(normalized);
      return [normalized, value] as const;
    })
    .toSorted(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const strings = (items: readonly string[]) => frame(items.map((x) => Buffer.from(x)));
  const bytes = frame([
    Buffer.from("arashi.git-fetch-equivalence.v1"),
    strings([
      record.repositoryKey,
      "fetch",
      record.cwdProjection,
      record.executable,
      record.lookupMode,
    ]),
    frame(environment.map((entry) => strings(entry))),
    record.configBytes,
    strings(record.argv),
    strings([
      record.endpoint,
      ...record.stdio,
      JSON.stringify(record.timeout),
      JSON.stringify(record.signal),
      record.platform,
      String(record.windowsHide),
    ]),
  ]);
  // Deliberately non-enumerable: diagnostics must never serialize source bytes or hashes.
  return Object.defineProperties(
    {},
    { bytes: { value: bytes }, digest: { value: digest(bytes) } },
  ) as Fingerprint;
}
export function runGitProbe(call: ProbeCall): Promise<ProbeResult> {
  return new Promise((yes, no) => {
    const child = spawn(call.executable, call.argv, {
      cwd: call.cwd,
      env: call.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => no(failure(call.parser)));
    child.on("close", (code) =>
      yes({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 1 }),
    );
  });
}
interface ContextOptions {
  local?: boolean;
  run?: (call: ProbeCall) => Promise<ProbeResult>;
  realpath?: (path: string) => Promise<string>;
  executable?: string;
  environment?: Record<string, string>;
  platform?: string;
  digest?: (bytes: Buffer) => string;
}
interface GitExecutable {
  selected: string;
  canonical: string;
}
interface Attempt {
  outcome?: RemoteTrackingFetchResult;
  fingerprint: Fingerprint;
  token: number;
  epoch: number;
  promise: Promise<RemoteTrackingFetchResult>;
  settled: boolean;
}
interface RepositoryState {
  generation: number;
  epoch: number;
  tail: Promise<void>;
  pending: number;
  attempts: Attempt[];
}
const REF_FORMAT = "%(refname)%00%(objectname)%00%(symref)%00";
let nextContextId = 0;
const auditSemantics = (parser: string): { parserOwner: string; purpose: string } => {
  const semantics: Record<string, { parserOwner: string; purpose: string }> = {
    "bare identity": {
      parserOwner: "GitProbeContext bare identity parser",
      purpose: "bare repository identity fallback",
    },
    configuration: {
      parserOwner: "GitProbeContext effective-config byte parser",
      purpose: "exact effective configuration snapshot",
    },
    identity: {
      parserOwner: "GitProbeContext identity parser",
      purpose: "combined repository/worktree identity",
    },
    "native stdout (unparsed)": {
      parserOwner: "none (Git-native stdout)",
      purpose: "native verbose status",
    },
    "porcelain-v2": {
      parserOwner: "existing NUL porcelain-v2 parser",
      purpose: "structured worktree status and branch/upstream discovery",
    },
    "ref metadata": {
      parserOwner: "GitProbeContext ref-snapshot parser",
      purpose: "metadata-only compatibility ref snapshot",
    },
    "ref snapshot": {
      parserOwner: "GitProbeContext ref-snapshot parser",
      purpose: "HEAD-relative ref snapshot",
    },
    "rev-list comparison": {
      parserOwner: "GitProbeContext rev-list count parser",
      purpose: "supported-Git fallback divergence comparison",
    },
    "symbolic remote HEAD": {
      parserOwner: "GitProbeContext symbolic remote-HEAD parser",
      purpose: "selected remote symbolic HEAD fallback",
    },
    "targeted fetch": {
      parserOwner: "GitProbeContext classified fetch-result parser",
      purpose: "exact targeted remote-tracking refresh",
    },
    "worktree listing": {
      parserOwner: "standalone worktree porcelain parser",
      purpose: "standalone worktree listing",
    },
  };
  return semantics[parser] ?? { parserOwner: `GitProbeContext ${parser} parser`, purpose: parser };
};
export class GitProbeContext {
  #facts = new RetrySafeCache();
  #repositories = new Map<string, RepositoryState>();
  #disposed = false;
  #token = 0;
  #options: ContextOptions;
  #environment: Record<string, string>;
  #audit: ProbeAuditEntry[] = [];
  readonly #contextId = `git-probe-context-${++nextContextId}`;

  constructor(options: ContextOptions = {}) {
    this.#options = options;
    this.#environment = options.environment
      ? { ...options.environment }
      : Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        );
    if (options.local) this.#environment.GIT_NO_LAZY_FETCH = "1";
    if ((options.platform ?? process.platform) === "win32") {
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(this.#environment)) {
        const folded = key.toUpperCase();
        if (Object.hasOwn(normalized, folded)) throw failure("environment normalization");
        normalized[folded] = value;
      }
      this.#environment = normalized;
    }
  }
  #assert(): void {
    if (this.#disposed) throw failure("disposed context");
  }
  dispose(): void {
    this.#disposed = true;
    this.#facts.clear();
    this.#repositories.clear();
    this.#environment = {};
  }
  auditLedger(): readonly ProbeAuditEntry[] {
    return this.#audit.map((entry) => ({
      ...entry,
      argv: [...entry.argv],
      environment: { ...entry.environment },
    }));
  }
  #attribute(start: number, discoveryCwd: string, identity: GitIdentity): void {
    for (const entry of this.#audit.slice(start)) {
      if (entry.repositoryAttribution !== "provisional" || entry.cwd !== discoveryCwd) continue;
      entry.cwd = identity.cwd;
      entry.repository = identity.repositoryKey;
      entry.repositoryAttribution = "canonical";
    }
  }
  #state(id: GitIdentity): RepositoryState {
    let state = this.#repositories.get(id.repositoryKey);
    if (!state) {
      state = { generation: 0, epoch: 0, tail: Promise.resolve(), pending: 0, attempts: [] };
      this.#repositories.set(id.repositoryKey, state);
    }
    return state;
  }
  #git(cwd: string): Promise<GitExecutable> {
    return this.#facts.get(`executable:${cwd}`, async () => {
      const canonicalize = this.#options.realpath ?? realpath;
      if (this.#options.executable) {
        const selected = resolve(cwd, this.#options.executable);
        return { selected, canonical: await canonicalize(selected) };
      }
      const env = this.#environment;
      const windows = (this.#options.platform ?? process.platform) === "win32";
      const suffixes = windows ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
      const lookupPath =
        env.PATH ?? (windows ? (process.env.PATH ?? process.env.Path ?? "") : "/usr/bin:/bin");
      for (const directory of lookupPath.split(windows ? ";" : delimiter)) {
        for (const suffix of suffixes) {
          const candidate = resolve(cwd, directory, `git${suffix}`);
          try {
            await access(candidate, constants.X_OK);
            return { selected: candidate, canonical: await canonicalize(candidate) };
          } catch {
            /* Try the next executable lookup candidate. */
          }
        }
      }
      throw failure("executable discovery");
    });
  }
  #scope(id: GitIdentity): string {
    return JSON.stringify([id.worktreeKey, id.cwd]);
  }
  #retainDiscoveryCwd(id: GitIdentity, cwd: string): GitIdentity {
    // Keep Git's original interpretation of relative injected paths and command
    // configuration. Do not rewrite shell/config/path-list syntax ourselves.
    const injected = Object.entries(this.#environment).some(
      ([key, value]) =>
        ((/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|INDEX_FILE|SHALLOW_FILE|CONFIG_GLOBAL|CONFIG_SYSTEM)$/.test(
          key,
        ) ||
          /^(HOME|USERPROFILE|XDG_CONFIG_HOME)$/.test(key)) &&
          value &&
          !isAbsolute(value)) ||
        /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key),
    );
    const relativeLookup =
      this.#environment.PATH?.split(
        (this.#options.platform ?? process.platform) === "win32" ? ";" : delimiter,
      ).some((directory) => !isAbsolute(directory)) === true;
    return injected || relativeLookup ? { ...id, cwd } : id;
  }
  async #run(
    cwd: string,
    argv: string[],
    parser: string,
    id?: GitIdentity,
    token: number | null = null,
  ): Promise<ProbeResult> {
    this.#assert();
    const executable = await this.#git(cwd);
    const semantics = auditSemantics(parser);
    const call: ProbeCall = {
      executable: executable.selected,
      argv,
      cwd,
      environment: {
        ...this.#environment,
        ...(["identity", "ref snapshot"].includes(parser) ? { LC_ALL: "C" } : {}),
      },
      parser,
      attemptToken: token,
      generation: id ? this.#state(id).generation : 0,
      repository: id?.repositoryKey ?? `provisional:${cwd}`,
      purpose: semantics.purpose,
    };
    this.#audit.push({
      ...call,
      argv: [...call.argv],
      contextId: this.#contextId,
      environment: { ...call.environment },
      parserOwner: semantics.parserOwner,
      repositoryAttribution: id ? "canonical" : "provisional",
    });
    try {
      return await (this.#options.run ?? runGitProbe)(call);
    } catch {
      throw failure(parser);
    }
  }
  async identity(path: string): Promise<GitIdentity> {
    this.#assert();
    return this.#facts.get(`identity:${path}`, async () => {
      let cwd: string;
      try {
        cwd = await (this.#options.realpath ?? realpath)(path);
      } catch {
        throw failure("identity");
      }
      const auditStart = this.#audit.length;
      const result = await this.#run(
        cwd,
        ["rev-parse", "--show-toplevel", "--git-common-dir", "--is-bare-repository"],
        "identity",
      );
      if (!result.exitCode) {
        const identity = this.#retainDiscoveryCwd(
          await parseIdentity(result.stdout, cwd, this.#options.realpath ?? realpath),
          cwd,
        );
        this.#attribute(auditStart, cwd, identity);
        return identity;
      }
      if (!/this operation must be run in a work tree/.test(result.stderr.toString()))
        throw failure("identity");
      const fallback = await this.#run(
        cwd,
        ["rev-parse", "--git-common-dir", "--is-bare-repository"],
        "bare identity",
      );
      if (fallback.exitCode) throw failure("identity");
      const identity = this.#retainDiscoveryCwd(
        await parseIdentity(fallback.stdout, cwd, this.#options.realpath ?? realpath, true),
        cwd,
      );
      this.#attribute(auditStart, cwd, identity);
      return identity;
    });
  }
  configuration(id: GitIdentity): Promise<EffectiveConfig> {
    this.#assert();
    return this.#facts.get(`config:${this.#scope(id)}`, async () => {
      const result = await this.#run(
        id.cwd,
        ["config", "--null", "--list", "--show-origin", "--show-scope"],
        "configuration",
        id,
      );
      if (result.exitCode) throw failure("configuration");
      return parseEffectiveConfig(result.stdout);
    });
  }
  porcelain(id: GitIdentity): Promise<string> {
    this.#assert();
    return this.#facts.get(`porcelain:${this.#scope(id)}`, async () => {
      const result = await this.#run(
        id.cwd,
        ["status", "--porcelain=v2", "--branch", "-z"],
        "porcelain-v2",
        id,
      );
      if (result.exitCode) throw failure("status");
      return result.stdout.toString("utf8");
    });
  }
  async nativeStatus(id: GitIdentity): Promise<string> {
    const result = await this.#run(id.cwd, ["status"], "native stdout (unparsed)", id);
    if (result.exitCode) throw failure("native status");
    return result.stdout.toString("utf8");
  }
  async worktreeList(id: GitIdentity): Promise<string> {
    const result = await this.#run(
      id.cwd,
      ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
      "worktree listing",
      id,
    );
    if (result.exitCode) throw failure("worktree listing");
    return result.stdout.toString("utf8");
  }
  async #read<T>(id: GitIdentity, key: string, load: () => Promise<T>): Promise<T> {
    this.#assert();
    const state = this.#state(id);
    for (;;) {
      while (state.pending) await state.tail;
      const generation = state.generation;
      const scoped = `ref:${this.#scope(id)}:${generation}:${key}`;
      const value = await this.#facts.get(scoped, load);
      // Synchronous validation and return are the read's linearization point.
      if (!state.pending && state.generation === generation) return value;
      this.#facts.delete(scoped);
    }
  }
  refs(id: GitIdentity, head: string | null): Promise<Map<string, RefFact>> {
    return this.#read(id, `snapshot:${head}`, async () => {
      let comparisons = head !== null;
      let result = await this.#run(
        id.cwd,
        [
          "for-each-ref",
          `--format=${REF_FORMAT}${comparisons ? "%(ahead-behind:HEAD)%00" : ""}`,
          "refs/heads",
          "refs/remotes",
        ],
        "ref snapshot",
        id,
      );
      if (
        result.exitCode &&
        comparisons &&
        /unknown field name: ahead-behind:HEAD/.test(result.stderr.toString())
      ) {
        comparisons = false;
        result = await this.#run(
          id.cwd,
          ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"],
          "ref metadata",
          id,
        );
      }
      if (result.exitCode) throw failure("refs");
      return parseRefSnapshot(result.stdout, comparisons);
    });
  }
  compare(id: GitIdentity, head: string, ref: string): Promise<{ ahead: number; behind: number }> {
    return this.#read(id, `comparison:${head}:${ref}`, async () => {
      const snapshot = await this.refs(id, head);
      const value = snapshot.get(ref);
      if (!value || !validRef(ref)) throw failure("comparison");
      if (value.ahead !== null && value.behind !== null)
        return { ahead: value.ahead, behind: value.behind };
      const result = await this.#run(
        id.cwd,
        ["rev-list", "--left-right", "--count", `HEAD...${ref}`],
        "rev-list comparison",
        id,
      );
      const match = /^(\d+)[\t ](\d+)\n?$/.exec(result.stdout.toString());
      if (result.exitCode || !match) throw failure("comparison");
      const ahead = Number(match[1]),
        behind = Number(match[2]);
      if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind))
        throw failure("comparison");
      return { ahead, behind };
    });
  }
  remoteHead(id: GitIdentity, remote: string): Promise<string | null> {
    return this.#read(id, `symbolic:${remote}`, async () => {
      if (!validRef(`refs/remotes/${remote}/HEAD`)) throw failure("remote HEAD");
      const result = await this.#run(
        id.cwd,
        ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
        "symbolic remote HEAD",
        id,
      );
      if (result.exitCode === 1) return null;
      if (result.exitCode) throw failure("remote HEAD");
      const text = decode(result.stdout).replace(/\n$/, "");
      const prefix = `${remote}/`;
      if (!text.startsWith(prefix) || !validRef(`refs/heads/${text.slice(prefix.length)}`))
        throw failure("remote HEAD");
      return text.slice(prefix.length);
    });
  }
  async #fingerprint(
    id: GitIdentity,
    target: RemoteTrackingTarget,
    argv: string[],
  ): Promise<Fingerprint> {
    const config = await this.configuration(id);
    const values = (key: string) =>
      config.entries.filter((e) => e.key === key).map((e) => e.value?.toString() ?? "");
    const urls = values(`remote.${target.remote}.url`);
    let endpoint = urls.at(-1) ?? target.remote;
    let safe = false;
    if (urls.length === 1 && !endpoint.includes(":") && endpoint) {
      try {
        endpoint = await (this.#options.realpath ?? realpath)(resolve(id.cwd, endpoint));
        safe = true;
      } catch {
        safe = false;
      }
    }
    const hooks = values("core.hookspath").at(-1);
    safe &&= hooks === "/dev/null" || hooks === "NUL";
    const safeKey =
      /^(?:user\.(?:name|email)|core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|worktree|hookspath)|extensions\.worktreeconfig|branch\..*\.(?:remote|merge)|remote\.[^.]+\.(?:url|fetch))$/;
    safe &&= config.entries.every((e) => safeKey.test(e.key));
    const safeEnvironment =
      /^(?:PATH|HOME|USERPROFILE|XDG_CONFIG_HOME|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_(?:KEY|VALUE)_\d+|LANG|LC_ALL|LC_CTYPE|TMPDIR|TEMP|TMP|SYSTEMROOT)$/;
    safe &&= Object.keys(this.#environment).every((key) => safeEnvironment.test(key));
    safe &&= (this.#environment.PATH ?? "/usr/bin:/bin")
      .split((this.#options.platform ?? process.platform) === "win32" ? ";" : delimiter)
      .every((directory) => isAbsolute(directory));
    safe &&= this.#options.executable === undefined || isAbsolute(this.#options.executable);
    safe &&= [
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
    ].every((key) => this.#environment[key] === undefined || isAbsolute(this.#environment[key]!));
    return normalizeSpawnRecord(
      {
        repositoryKey: id.repositoryKey,
        cwdProjection: safe ? "cwd-independent" : "cwd:" + id.cwd,
        executable: (await this.#git(id.cwd)).canonical,
        lookupMode: this.#options.executable ? "explicit" : "PATH",
        environment: this.#environment,
        configBytes: config.bytes,
        argv,
        endpoint,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: null,
        signal: null,
        platform: this.#options.platform ?? process.platform,
        windowsHide: true,
      },
      this.#options.digest,
    );
  }
  async fetch(
    id: GitIdentity,
    target: RemoteTrackingTarget,
    options: { retry?: boolean } = {},
  ): Promise<RemoteTrackingFetchResult> {
    this.#assert();
    if (this.#options.local) throw failure("local context disallows fetch");
    if (
      target.remote.startsWith("-") ||
      !validRef(`refs/remotes/${target.remote}/${target.branch}`) ||
      !validRef(`refs/heads/${target.branch}`)
    )
      throw failure("fetch target");
    const argv = [
      "fetch",
      "--no-tags",
      "--prune",
      target.remote,
      `+refs/heads/${target.branch}:refs/remotes/${target.remote}/${target.branch}`,
    ];
    const fingerprint = await this.#fingerprint(id, target, argv);
    const state = this.#state(id);
    if (!options.retry) {
      const match = state.attempts.find(
        (a) =>
          (!a.settled || (a.epoch === state.epoch && a.outcome?.ok === true)) &&
          a.fingerprint.digest === fingerprint.digest &&
          a.fingerprint.bytes.equals(fingerprint.bytes),
      );
      if (match) return match.promise;
    }
    const token = ++this.#token;
    const epoch = ++state.epoch;
    state.attempts = state.attempts.filter((a) => !a.settled);
    state.pending++;
    const predecessor = state.tail;
    const attempt: Attempt = {
      fingerprint,
      token,
      epoch,
      promise: Promise.resolve({ ok: true }),
      settled: false,
    };
    attempt.promise = (async () => {
      await predecessor;
      state.generation++;
      try {
        const result = await this.#run(id.cwd, argv, "targeted fetch", id, token);
        if (!result.exitCode) return { ok: true } as const;
        const missing = /could(?:n't| not) find remote ref\s+/.test(result.stderr.toString());
        const error = missing
          ? `couldn't find remote ref refs/heads/${target.branch}`
          : "Remote fetch failed";
        return {
          ok: false,
          kind: missing ? "missing-remote-ref" : "generic",
          error,
          message: error,
        } as RemoteTrackingFetchResult;
      } catch {
        return {
          ok: false,
          kind: "generic",
          error: "Remote fetch failed",
          message: "Remote fetch failed",
        } as const;
      } finally {
        state.generation++;
        state.pending--;
        attempt.settled = true;
      }
    })().then((outcome) => {
      attempt.outcome = outcome;
      return outcome;
    });
    state.tail = attempt.promise.then(() => {});
    state.attempts.push(attempt);
    return attempt.promise;
  }
}
