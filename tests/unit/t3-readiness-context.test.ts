import { afterEach, describe, expect, test, vi } from "vitest";
import { runtime } from "../../src/lib/runtime.ts";
import * as configModule from "../../src/lib/config.ts";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const filesystemAudit = vi.hoisted(() => ({
  active: false,
  calls: [] as { operation: string; path: string }[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = { ...original };
  for (const operation of [
    "readFile",
    "open",
    "readdir",
    "lstat",
    "stat",
    "realpath",
    "chmod",
    "mkdir",
    "writeFile",
    "rm",
  ] as const) {
    Object.assign(wrapped, {
      [operation]: (...args: unknown[]) => {
        if (filesystemAudit.active)
          filesystemAudit.calls.push({ operation, path: String(args[0]) });
        return Reflect.apply(original[operation], original, args);
      },
    });
  }
  return wrapped;
});
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";

let fixture: Awaited<ReturnType<typeof createReadinessFixture>> | undefined;
afterEach(async () => {
  filesystemAudit.active = false;
  vi.restoreAllMocks();
  await fixture?.dispose();
  fixture = undefined;
});
const raw = { version: "1", reposDir: "./repos", repos: {} };
async function setup(value: unknown = raw) {
  fixture = await createReadinessFixture();
  const path = join(fixture.repo, ".arashi/config.json");
  await mkdir(join(fixture.repo, ".arashi"), { recursive: true });
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value, null, 3) + "\n\n",
  );
  await chmod(path, 0o640);
  return { fixture, path };
}

describe("ordinary migration calibration", () => {
  test("ordinary loader still persists supported version migration", async () => {
    const { fixture, path } = await setup();
    const before = await readFile(path);
    await configModule.loadConfig(fixture.repo);
    // Positive calibration: ordinary migration behavior must remain unchanged.
    expect(await readFile(path)).not.toEqual(before);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe("1.0.0");
  });
});

describe("read-only diagnostic configuration", () => {
  test.each([
    ["healthy", { ...raw, version: "1.0.0" }],
    ["legacy version", raw],
    ["legacy create camel alias", { ...raw, defaults: { create: { launchMode: "herdr" } } }],
    ["legacy create boolean true", { ...raw, defaults: { create: { launch: true } } }],
    ["legacy create boolean false", { ...raw, defaults: { create: { launch: false } } }],
    [
      "legacy switch snake alias",
      { ...raw, defaults: { switch: { mode: "launch", launch_mode: "sesh" } } },
    ],
    [
      "legacy aliases",
      {
        ...raw,
        worktrees_dir: "../trees",
        defaults: {
          create: { launch_mode: "sesh" },
          switch: { mode: "launch", launchMode: "herdr" },
        },
      },
    ],
  ])(
    "normalizes %s in memory preserving owned filesystem bytes and modes",
    async (_name, value) => {
      const { fixture, path } = await setup(value);
      await fixture.installMarkers();
      const before = await fixture.snapshot();
      const output = [
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "log"),
        vi.spyOn(console, "error"),
      ];
      const processes = vi.spyOn(runtime, "spawn");
      const result = await configModule.readConfigForDiagnostics(fixture.repo);
      expect(processes).not.toHaveBeenCalled();
      expect(result?.config).toEqual(configModule.normalizeConfig(value));
      expect(result?.authoredWorktreesDir).toBe("worktrees_dir" in value);
      expect(result?.source).toBe("local-file");
      expect(result?.diagnostics.some((d) => d.code === "LEGACY_CONFIG_VERSION")).toBe(
        value.version === "1",
      );
      expect(JSON.stringify(result?.diagnostics)).not.toContain(JSON.stringify(value));
      expect(await stat(path).then((s) => s.mode & 0o777)).toBe(0o640);
      expect(await fixture.snapshot()).toEqual(before);
      for (const spy of output) expect(spy).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["malformed JSON", '{"secret":"CONFIG_CANARY",'],
    ["closed root", { ...raw, CONFIG_CANARY: "SECRET_VALUE" }],
    ["closed nested field", { ...raw, defaults: { create: { CONFIG_CANARY: "SECRET_VALUE" } } }],
    [
      "invalid applicable setting",
      { ...raw, defaults: { t3: { provider: { secret: "CONFIG_CANARY" } } } },
    ],
    ["unsupported version", { ...raw, version: "CONFIG_CANARY" }],
    [
      "invalid materialization",
      { ...raw, repos: { CONFIG_CANARY: { path: "./child", copy: ["../SECRET_VALUE"] } } },
    ],
  ])("blocks %s without leaking authored data or falling back", async (_name, value) => {
    const { fixture } = await setup(value);
    const before = await fixture.snapshot();
    const processes = vi.spyOn(runtime, "spawn");
    const output = [
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
    ];
    let error: unknown;
    try {
      await configModule.readConfigForDiagnostics(fixture.repo, { bareRepoPath: fixture.repo });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(configModule.ConfigError);
    expect(processes).not.toHaveBeenCalled();
    for (const spy of output) expect(spy).not.toHaveBeenCalled();
    expect(String(error) + JSON.stringify(error)).not.toMatch(/CONFIG_CANARY|SECRET_VALUE/);
    expect(await fixture.snapshot()).toEqual(before);
  });

  test.each(["directory", "dangling symlink", "symlink loop", "unreadable"])(
    "does not classify %s as absence",
    async (kind) => {
      const { fixture, path } = await setup();
      await rm(path);
      if (kind === "directory") await mkdir(path);
      else if (kind === "dangling symlink") await symlink("missing", path);
      else if (kind === "symlink loop") await symlink("config.json", path);
      else {
        await writeFile(path, JSON.stringify(raw));
        await chmod(path, 0);
      }
      const before = kind === "unreadable" ? await stat(path) : await fixture.snapshot();
      await expect(
        configModule.readConfigForDiagnostics(fixture.repo, { bareRepoPath: fixture.repo }),
      ).rejects.toBeInstanceOf(configModule.ConfigError);
      expect(kind === "unreadable" ? await stat(path) : await fixture.snapshot()).toEqual(before);
    },
  );

  test("returns explicit absence without creating directories", async () => {
    fixture = await createReadinessFixture();
    const before = await fixture.snapshot();
    expect(await configModule.readConfigForDiagnostics(fixture.repo)).toBeNull();
    expect(await fixture.snapshot()).toEqual(before);
  });

  test("reads tracked Git content without filters only after genuine local absence", async () => {
    const { fixture, path } = await setup();
    const { exec } = await import("../../src/lib/git.ts");
    await fixture.installMarkers();
    await writeFile(
      join(fixture.repo, ".gitattributes"),
      ".arashi/config.json filter=marker-clean\n",
    );
    await exec(["add", "--", ".arashi/config.json", ".gitattributes"], fixture.repo);
    await exec(["commit", "-m", "tracked configuration"], fixture.repo);
    await rm(path);
    const filterBefore = await readFile(fixture.markers.clean);
    const before = await fixture.snapshot();
    const processes = vi.spyOn(runtime, "spawn");
    const result = await configModule.readConfigForDiagnostics(fixture.repo, {
      bareRepoPath: fixture.repo,
    });
    const argv = processes.mock.calls.map(([args]) => args);
    expect(argv.slice(0, 3)).toEqual([
      ["git", "symbolic-ref", "--short", "HEAD"],
      ["git", "show-ref", "--verify", "refs/heads/main"],
      ["git", "rev-parse", "--verify", "main^{tree}"],
    ]);
    expect(argv.slice(3).map((args) => args.slice(0, 3))).toEqual([
      ["git", "ls-tree", "-z"],
      ["git", "cat-file", "-t"],
      ["git", "cat-file", "-s"],
      ["git", "cat-file", "-p"],
    ]);
    expect(argv[4]?.[3]).toBe(argv[5]?.[3]);
    expect(argv[5]?.[3]).toBe(argv[6]?.[3]);
    processes.mockRestore();
    expect(result?.source).toBe("repository-content");
    expect(result?.config).toEqual(configModule.normalizeConfig(raw));
    expect(await readFile(fixture.markers.clean)).toEqual(filterBefore);
    for (const marker of [fixture.markers.process, fixture.markers.fetch, fixture.markers.hook])
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.snapshot()).toEqual(before);
  });
  test("translated Git absence preserves ordinary checkout discovery", async () => {
    fixture = await createReadinessFixture();
    const { exec } = await import("../../src/lib/git.ts");
    const { ArashiError } = await import("../../src/lib/errors.ts");
    const args = ["show", "main:.arashi/config.json"];
    const original = await exec(args, fixture.repo).catch((error: unknown) => error);
    expect(original).toBeInstanceOf(ArashiError);
    const wrapper = join(fixture.home, "translated-git.cjs");
    // Delegate every read to real Git, changing only human stderr, never status/stdout.
    await writeFile(
      wrapper,
      `
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('git', process.argv.slice(2), {
        cwd: process.cwd(), env: process.env, timeout: 5000, maxBuffer: 1024 * 1024
      });
      if (result.error || result.signal) process.exit(125);
      process.stdout.write(result.stdout);
      process.stderr.write(result.status && result.stderr.length
        ? 'fatal : lecture Git impossible (message traduit)\\n' : result.stderr);
      process.exit(result.status);
    `,
    );
    const { spawn } = runtime;
    const processes = vi
      .spyOn(runtime, "spawn")
      .mockImplementation((argv, options) =>
        argv[0] === "git"
          ? spawn([process.execPath, wrapper, ...argv.slice(1)], options)
          : spawn(argv, options),
      );
    const translated = await exec(args, fixture.repo).catch((error: unknown) => error);
    expect(translated).toBeInstanceOf(ArashiError);
    expect((translated as InstanceType<typeof ArashiError>).context.exitCode).toBe(
      (original as InstanceType<typeof ArashiError>).context.exitCode,
    );
    expect((translated as InstanceType<typeof ArashiError>).context.stdout).toBe(
      (original as InstanceType<typeof ArashiError>).context.stdout,
    );
    expect((translated as InstanceType<typeof ArashiError>).context.stderr).toContain(
      "message traduit",
    );
    const before = await fixture.snapshot();
    await expect(
      configModule.readConfigForDiagnostics(fixture.repo, { bareRepoPath: fixture.repo }),
    ).resolves.toBeNull();
    await expect(context({ cwd: fixture.repo })).resolves.toMatchObject({
      checkout: fixture.repo,
      workspace: null,
      workspaceRoot: null,
    });
    processes.mockRestore();
    expect(await fixture.snapshot()).toEqual(before);
  });

  test.each(["unborn HEAD", "corrupt HEAD", "missing tracked blob", "malformed tracked config"])(
    "does not classify %s as tracked absence",
    async (kind) => {
      fixture = await createReadinessFixture();
      const { exec } = await import("../../src/lib/git.ts");
      if (kind === "unborn HEAD") {
        await exec(["update-ref", "-d", "refs/heads/main"], fixture.repo);
      } else if (kind === "corrupt HEAD") {
        await writeFile(join(fixture.repo, ".git/refs/heads/main"), `${"1".repeat(40)}\n`);
      } else {
        const path = join(fixture.repo, ".arashi/config.json");
        await mkdir(join(fixture.repo, ".arashi"));
        await writeFile(path, kind === "malformed tracked config" ? "{" : JSON.stringify(raw));
        await exec(["add", "--", ".arashi/config.json"], fixture.repo);
        await exec(["commit", "-m", "tracked config boundary"], fixture.repo);
        if (kind === "missing tracked blob") {
          const oid = (
            await exec(["rev-parse", "HEAD:.arashi/config.json"], fixture.repo)
          ).stdout.trim();
          await rm(join(fixture.repo, ".git/objects", oid.slice(0, 2), oid.slice(2)));
        }
        await rm(path);
      }
      // The shared snapshot requires valid refs; inspect broken-ref fixture bytes directly.
      const snapshot = () =>
        kind === "unborn HEAD" || kind === "corrupt HEAD"
          ? Promise.all([
              readFile(join(fixture!.repo, ".git/HEAD")),
              readFile(join(fixture!.repo, ".git/refs/heads/main")).catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") {
                    return null;
                  }
                  throw error;
                },
              ),
            ])
          : fixture!.snapshot();
      const before = await snapshot();
      await expect(
        configModule.readConfigForDiagnostics(fixture.repo, { bareRepoPath: fixture.repo }),
      ).rejects.toBeInstanceOf(
        kind === "malformed tracked config"
          ? configModule.ConfigParseError
          : configModule.ConfigError,
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  test("tracked absence is null but repository read failure remains an error", async () => {
    fixture = await createReadinessFixture();
    const before = await fixture.snapshot();
    expect(
      await configModule.readConfigForDiagnostics(fixture.repo, { bareRepoPath: fixture.repo }),
    ).toBeNull();
    await expect(
      configModule.readConfigForDiagnostics(fixture.repo, { bareRepoPath: fixture.home }),
    ).rejects.toBeInstanceOf(configModule.ConfigError);
    expect(await fixture.snapshot()).toEqual(before);
  });

  test.each(["dangling directory link", "directory link loop"])(
    "blocks %s rather than falling back",
    async (kind) => {
      fixture = await createReadinessFixture();
      await symlink(
        kind === "directory link loop" ? ".arashi" : "missing",
        join(fixture.repo, ".arashi"),
      );
      const before = await fixture.snapshot();
      await expect(
        configModule.readConfigForDiagnostics(fixture.repo, { bareRepoPath: fixture.repo }),
      ).rejects.toBeInstanceOf(configModule.ConfigError);
      expect(await fixture.snapshot()).toEqual(before);
    },
  );
});

const effectSnapshotMetadata = (
  value: Awaited<ReturnType<NonNullable<typeof fixture>["snapshot"]>>,
) => ({
  refs: value.refs,
  worktrees: value.worktrees,
  // Equality is checked in memory; persisted evidence contains no application
  // bytes or configuration fingerprints (including private fixture data).
  files: value.files.map(({ bytes: _bytes, ...file }) => file),
});

async function saveEffectEvidence(
  name: string,
  before: Awaited<ReturnType<NonNullable<typeof fixture>["snapshot"]>>,
  after: typeof before,
  processes: unknown,
  filesystem: unknown,
) {
  const root = process.env.ARASHI_READINESS_TEST_EVIDENCE;
  if (!root) return;
  await writeFile(
    join(root, name + "-effects.json"),
    JSON.stringify(
      {
        before: effectSnapshotMetadata(before),
        after: effectSnapshotMetadata(after),
        bytesAndModesEqual: true,
        processes,
        filesystem,
      },
      null,
      2,
    ),
  );
}

async function context(options: {
  cwd: string;
  path?: string;
  explicitSettings?: import("../../src/lib/t3-settings.ts").T3Settings;
}) {
  const { resolveT3ReadinessContext } = await import("../../src/lib/t3-readiness-context.ts");
  return resolveT3ReadinessContext({ explicitSettings: {}, ...options });
}
async function contextFixture() {
  fixture = await createReadinessFixture();
  vi.stubEnv("HOME", fixture.home);
  vi.stubEnv("T3CODE_HOME", "");
  return fixture;
}
afterEach(() => vi.unstubAllEnvs());
async function git(args: string[], cwd: string) {
  return (await import("../../src/lib/git.ts")).exec(args, cwd);
}

describe("readiness locale-independent Git identity", () => {
  async function translatedGit() {
    const f = await contextFixture();
    vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
    const wrapper = join(f.home, "identity-git.cjs");
    await writeFile(
      wrapper,
      `
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('git', process.argv.slice(2), {
        cwd: process.cwd(), env: process.env, timeout: 5000, maxBuffer: 1024 * 1024
      });
      if (result.error || result.signal) process.exit(125);
      process.stdout.write(result.stdout);
      process.stderr.write(result.status && result.stderr.length && process.env.LC_ALL !== 'C'
        ? 'fatal : pas de dépôt Git (message traduit)\\n' : result.stderr);
      process.exit(result.status);
    `,
    );
    const { spawn } = runtime;
    vi.spyOn(runtime, "spawn").mockImplementation((argv, options) =>
      argv[0] === "git"
        ? spawn([process.execPath, wrapper, ...argv.slice(1)], options)
        : spawn(argv, options),
    );
    return f;
  }

  test("translated real non-repository failure allows global context without changing ordinary Git locale", async () => {
    const f = await translatedGit();
    const { ArashiError } = await import("../../src/lib/errors.ts");
    const failure = await git(["rev-parse", "--is-bare-repository"], f.home).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ArashiError);
    expect(failure.context).toMatchObject({ exitCode: 128, stdout: "" });
    expect(failure.context.stderr).toContain("message traduit");
    expect(failure.code).not.toBe("NOT_A_REPOSITORY");
    const before = await f.snapshot();
    await expect(context({ cwd: f.home })).resolves.toMatchObject({
      checkout: null,
      workspace: null,
      workspaceRoot: null,
    });
    expect(process.env.LC_ALL).toBe("fr_FR.UTF-8");
    const ordinary = await git(["rev-parse", "--is-bare-repository"], f.home).catch(
      (error) => error,
    );
    expect(ordinary.context.stderr).toContain("message traduit");
    expect(await f.snapshot()).toEqual(before);
  });

  test("translated probe retains Git parent lookup and valid bare context", async () => {
    const f = await translatedGit();
    const nested = join(f.repo, "ordinary", "nested");
    await mkdir(nested, { recursive: true });
    await expect(context({ cwd: nested })).resolves.toMatchObject({ checkout: f.repo });
    const bare = join(f.root, "bare.git");
    await git(["init", "--bare", bare], f.root);
    await expect(context({ cwd: bare })).resolves.toMatchObject({ checkout: null });
    vi.stubEnv("GIT_DIR", bare);
    await expect(context({ cwd: f.home })).resolves.toMatchObject({ checkout: null });
  });

  test.each([
    ["selected", false],
    ["ancestor", false],
    ["selected", true],
    ["ancestor", true],
  ])(
    "ordinary objects and refs directories at %s (HEAD document: %s) allow global context",
    async (location, head) => {
      const f = await translatedGit();
      await mkdir(join(f.home, "objects"));
      await mkdir(join(f.home, "refs"));
      if (head) await writeFile(join(f.home, "HEAD"), "ordinary document\n");
      const cwd = location === "selected" ? f.home : join(f.home, "nested");
      await mkdir(cwd, { recursive: true });
      const before = await f.snapshot();
      await expect(context({ cwd })).resolves.toMatchObject({
        checkout: null,
        workspace: null,
        workspaceRoot: null,
      });
      expect(await f.snapshot()).toEqual(before);
    },
  );

  test.each([
    ["ordinary document", "ordinary file\n"],
    ["wrong section", "[unrelated]\n bare = true\n"],
    ["non-bare config", "[core]\n bare = false\n"],
    ["overridden bare", "[core]\n bare = true\n bare = false\n"],
    ["include ambiguity", "[core]\n bare = true\n[include]\n path = elsewhere\n"],
    ["oversized config", "[core]\n bare = true\n#" + "x".repeat(4096)],
  ])("ordinary layout with %s is not damaged bare evidence", async (_name, config) => {
    const f = await translatedGit();
    await mkdir(join(f.home, "objects"));
    await mkdir(join(f.home, "refs"));
    await writeFile(join(f.home, "config"), config);
    await expect(context({ cwd: f.home })).resolves.toMatchObject({ checkout: null });
  });

  test.each(["ordinary", "dangling", "directory", "bare"])(
    "%s config symlink uses only bounded regular-target evidence",
    async (kind) => {
      const f = await translatedGit();
      await mkdir(join(f.home, "objects"));
      const target = join(f.home, "config-target");
      if (kind === "directory") await mkdir(target);
      else if (kind !== "dangling")
        await writeFile(target, kind === "bare" ? "[core]\n bare = true\n" : "ordinary");
      await symlink(target, join(f.home, "config"));
      if (kind === "bare") await expect(context({ cwd: f.home })).rejects.toThrow();
      else await expect(context({ cwd: f.home })).resolves.toMatchObject({ checkout: null });
    },
  );

  test("an unowned config FIFO does not block global context", async () => {
    const f = await translatedGit();
    await mkdir(join(f.home, "objects"));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("mkfifo", [join(f.home, "config")]);
    await expect(context({ cwd: f.home })).resolves.toMatchObject({ checkout: null });
  });

  test("unreadable unowned config is not Git evidence", async () => {
    const f = await translatedGit();
    await mkdir(join(f.home, "objects"));
    const config = join(f.home, "config");
    await writeFile(config, "[core]\n bare = true\n");
    await chmod(config, 0);
    try {
      await expect(context({ cwd: f.home })).resolves.toMatchObject({ checkout: null });
    } finally {
      await chmod(config, 0o600);
    }
  });

  test.each(["HEAD", "objects", "refs"])("a lone %s name is not bare metadata", async (name) => {
    const f = await translatedGit();
    if (name === "HEAD") {
      await writeFile(join(f.home, name), "ordinary file");
    } else {
      await mkdir(join(f.home, name));
    }
    await expect(context({ cwd: f.home })).resolves.toMatchObject({ checkout: null });
  });

  test.each([
    "file",
    "directory",
    "permissions",
    "ancestor",
    "GIT_DIR",
    "bare HEAD",
    "bare objects",
    "bare refs",
  ])("retains %s metadata failure instead of global absence", async (kind) => {
    const f = await translatedGit();
    // Calibrate metadata rejection independently of the translated-error guard.
    vi.stubEnv("LC_ALL", "C");
    let cwd = join(f.root, "broken");
    await mkdir(cwd);
    if (kind === "GIT_DIR") vi.stubEnv("GIT_DIR", join(f.root, "missing-git"));
    else if (kind.startsWith("bare ")) {
      await git(["init", "--bare"], cwd);
      await rm(join(cwd, kind.slice(5)), { recursive: true });
    } else if (kind === "file") await writeFile(join(cwd, ".git"), "gitdir: missing\n");
    else {
      await mkdir(join(cwd, ".git"));
      if (kind === "permissions") await chmod(join(cwd, ".git"), 0);
      if (kind === "ancestor") {
        cwd = join(cwd, "nested");
        await mkdir(cwd);
      }
    }
    try {
      await expect(context({ cwd })).rejects.toThrow();
      vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
      await expect(context({ cwd })).rejects.toThrow();
    } finally {
      if (kind === "permissions") await chmod(join(cwd, ".git"), 0o700);
    }
  });

  test("independent child does not conceal dangling containing Git metadata", async () => {
    const f = await translatedGit();
    await symlink("missing-metadata", join(f.root, ".git"));
    await expect(context({ cwd: f.repo })).rejects.toThrow();
  });

  test("translated malformed HEAD ref is not an unborn repository", async () => {
    const f = await translatedGit();
    await writeFile(join(f.repo, ".git/refs/heads/main"), "invalid-ref\n");
    await expect(context({ cwd: f.repo })).rejects.toThrow();
  });

  test("translated unborn HEAD with other valid refs remains an ordinary checkout", async () => {
    const f = await translatedGit();
    await git(["symbolic-ref", "HEAD", "refs/heads/unborn"], f.repo);
    await expect(context({ cwd: f.repo })).resolves.toMatchObject({
      checkout: f.repo,
      workspace: null,
    });
  });

  test("non-repository cwd does not hide other nonzero Git failures", async () => {
    const f = await translatedGit();
    await writeFile(join(f.home, ".gitconfig"), "[invalid\n");
    await expect(context({ cwd: f.home })).rejects.toThrow();
  });
});

describe("readiness exact context A01 A04", () => {
  test.each([
    "outside",
    "ordinary",
    "configured",
    "child",
    "standalone",
    "linked",
    "configured linked",
  ])("selects %s without adoption", async (kind) => {
    const f = await contextFixture();
    let cwd = kind === "outside" ? f.home : f.repo;
    let selected: string | null = kind === "outside" ? null : f.repo;
    if (kind.startsWith("configured") || kind === "child") {
      await mkdir(join(f.repo, ".arashi"));
      await writeFile(join(f.repo, ".arashi/config.json"), JSON.stringify(raw));
    }
    if (kind === "standalone") await mkdir(join(f.repo, ".worktrees"));
    if (kind === "child") {
      cwd = join(f.repo, "repos/child");
      await mkdir(cwd, { recursive: true });
      await git(["init"], cwd);
      selected = cwd;
    }
    if (kind.includes("linked")) {
      cwd = join(f.root, "linked checkout");
      await git(["worktree", "add", "-b", "linked", cwd], f.repo);
      selected = cwd;
    }
    const before = await f.snapshot();
    const result = await context({ cwd });
    expect(result.checkout).toBe(selected);
    expect(result.workspaceRoot).toBe(
      kind.startsWith("configured") || kind === "child" ? f.repo : null,
    );
    expect(await f.snapshot()).toEqual(before);
  });
  test.each(["main", "linked", "alias", "relative", "spaces"])("exact --path %s", async (kind) => {
    const f = await contextFixture();
    let target = f.repo;
    if (kind === "linked") {
      target = join(f.root, "linked");
      await git(["worktree", "add", "-b", "linked", target], f.repo);
    }
    let path = target;
    if (kind === "alias") {
      path = join(f.root, "alias");
      await symlink(target, path);
    }
    if (kind === "relative") path = "../checkout with spaces";
    expect((await context({ cwd: f.home, path })).checkout).toBe(target);
  });
  test.each(["missing", "nonGit", "subdirectory", "bare", "unreadable", "unregistered"])(
    "rejects explicit %s before other discovery",
    async (kind) => {
      const f = await contextFixture();
      let path = join(f.root, kind);
      if (kind !== "missing") await mkdir(path);
      if (kind === "subdirectory") {
        path = join(f.repo, "subdir");
        await mkdir(path);
      }
      if (kind === "bare") await git(["init", "--bare"], path);
      if (kind === "unreadable") await chmod(path, 0);
      if (kind === "unregistered") {
        await writeFile(join(path, ".git"), `gitdir: ${join(f.repo, ".git")}\n`);
      }
      const native = vi.spyOn(runtime, "file");
      await expect(context({ cwd: f.home, path })).rejects.toThrow(/checkout/i);
      expect(native).not.toHaveBeenCalled();
      if (kind === "unreadable") await chmod(path, 0o700);
    },
  );
  test("bare CWD is global; bare-backed linked remains diagnostic-only", async () => {
    const f = await contextFixture();
    const bare = join(f.root, "bare.git");
    await git(["clone", "--bare", f.repo, bare], f.root);
    expect((await context({ cwd: bare })).checkout).toBeNull();
    const linked = join(f.root, "bare linked");
    await git(["worktree", "add", linked, "main"], bare);
    expect((await context({ cwd: linked })).checkout).toBe(linked);
  });
});

describe("readiness settings A02 A26", () => {
  const leaves = ["baseDir", "cli", "provider", "model", "effort"] as const;
  const values = {
    baseDir: "/owned/t3",
    cli: "/owned/bin/t3",
    provider: "provider",
    model: "model",
    effort: "high",
  };
  async function configs(workspace: object, user: object) {
    const f = await contextFixture();
    await mkdir(join(f.repo, ".arashi"));
    await writeFile(
      join(f.repo, ".arashi/config.json"),
      JSON.stringify({ ...raw, defaults: { t3: workspace } }),
    );
    await mkdir(join(f.home, ".arashi"));
    await writeFile(
      join(f.home, ".arashi/config.json"),
      JSON.stringify({ version: "1.0.0", defaults: { t3: user } }),
    );
    return f;
  }
  test.each(leaves)("resolves independent %s precedence", async (leaf) => {
    const f = await configs({ [leaf]: values[leaf] }, { [leaf]: values[leaf] + "-user" });
    const before = await f.snapshot();
    const cli = await context({ cwd: f.repo, explicitSettings: { [leaf]: values[leaf] + "-cli" } });
    expect(cli.settings[leaf]).toBe(values[leaf] + "-cli");
    expect(cli.sources[leaf]).toBe("cli");
    const workspace = await context({ cwd: f.repo });
    expect(workspace.settings[leaf]).toBe(values[leaf]);
    expect(workspace.sources[leaf]).toBe("workspace");
    await rm(join(f.repo, ".arashi/config.json"));
    const user = await context({ cwd: f.repo });
    expect(user.settings[leaf]).toBe(values[leaf] + "-user");
    expect(user.sources[leaf]).toBe("user");
    await writeFile(
      join(f.repo, ".arashi/config.json"),
      before.files.find((x) => x.path === join(f.repo, ".arashi/config.json"))!.bytes,
    );
    expect(await f.snapshot()).toEqual(before);
  });
  test("mixes all five sources independently and never saves", async () => {
    const f = await configs(
      { provider: "workspace-provider", model: "workspace-model" },
      { model: "user-model", effort: "user-effort" },
    );
    vi.stubEnv("T3CODE_HOME", f.baseDir);
    const before = await f.snapshot();
    const result = await context({ cwd: f.repo, explicitSettings: { model: "cli-model" } });
    expect(result.settings).toEqual({
      baseDir: f.baseDir,
      cli: "t3",
      provider: "workspace-provider",
      model: "cli-model",
      effort: "user-effort",
    });
    expect(result.sources).toEqual({
      baseDir: "environment",
      cli: "builtin",
      provider: "workspace",
      model: "cli",
      effort: "user",
    });
    expect(await f.snapshot()).toEqual(before);
  });
  test("native fallback leaves provider/model/effort unset", async () => {
    const f = await contextFixture();
    const result = await context({ cwd: f.home });
    expect(result.settings).toEqual({ baseDir: join(f.home, ".t3"), cli: "t3" });
    expect(result.sources).toEqual({ baseDir: "builtin", cli: "builtin" });
  });
  test.each([{ baseDir: "relative" }, { cli: "./bin/t3" }, { permission: "allow" }])(
    "rejects unsupported explicit settings %j",
    async (settings) => {
      const f = await contextFixture();
      await expect(context({ cwd: f.repo, explicitSettings: settings as never })).rejects.toThrow();
    },
  );
  test("anchors general paths to workspace owner, not selected linked", async () => {
    const f = await configs({}, {});
    await writeFile(
      join(f.repo, ".arashi/config.json"),
      JSON.stringify({ ...raw, worktreesDir: "../owner-trees" }),
    );
    const linked = join(f.root, "linked");
    await git(["worktree", "add", "-b", "linked", linked], f.repo);
    const result = await context({ cwd: linked });
    expect(result.checkout).toBe(linked);
    expect(result.roots).toEqual({
      repositoriesBase: join(f.repo, "repos"),
      worktreesBase: join(f.root, "owner-trees"),
    });
  });
  test("unauthored workspace default allows owner-relative user worktrees", async () => {
    const f = await configs({}, {});
    await writeFile(
      join(f.home, ".arashi/config.json"),
      JSON.stringify({ version: "1.0.0", worktreesDir: "../user-trees" }),
    );
    const linked = join(f.root, "linked");
    await git(["worktree", "add", "-b", "linked", linked], f.repo);
    expect((await context({ cwd: linked })).roots?.worktreesBase).toBe(join(f.root, "user-trees"));
  });
  test("HOME ancestor remains personal schema, never workspace schema", async () => {
    const f = await contextFixture();
    vi.stubEnv("HOME", f.root);
    await mkdir(join(f.root, ".arashi"));
    await writeFile(
      join(f.root, ".arashi/config.json"),
      JSON.stringify({ version: "1.0.0", defaults: { t3: { model: "personal" } } }),
    );
    const result = await context({ cwd: f.repo });
    expect(result.workspaceRoot).toBeNull();
    expect(result.settings.model).toBe("personal");
    expect(result.sources.model).toBe("user");
  });
});

describe("readiness authority and bounded effects A03 A25", () => {
  test.each(["malformed", "unreadable", "ambiguous hooks", "missing materialization"])(
    "handles authoritative %s without ordinary probes",
    async (kind) => {
      const f = await contextFixture();
      await mkdir(join(f.repo, ".arashi"));
      await mkdir(join(f.repo, ".worktrees"));
      await mkdir(join(f.home, ".arashi"));
      await writeFile(
        join(f.home, ".arashi/config.json"),
        JSON.stringify({ version: "1.0.0", defaults: { t3: { model: "healthy" } } }),
      );
      const path = join(f.repo, ".arashi/config.json");
      const value =
        kind === "ambiguous hooks"
          ? { ...raw, hooks: { scripts: { "pre-create": "echo canary" } } }
          : kind === "missing materialization"
            ? { ...raw, repos: { child: { path: "./missing", copy: ["missing-source"] } } }
            : raw;
      await writeFile(path, kind === "malformed" ? "{CANARY" : JSON.stringify(value));
      if (kind === "ambiguous hooks") {
        await mkdir(join(f.repo, ".arashi/hooks"));
        await writeFile(join(f.repo, ".arashi/hooks/pre-create.sh"), "echo file\n");
      }
      if (kind === "unreadable") await chmod(path, 0);
      if (kind === "malformed" || kind === "unreadable")
        await expect(context({ cwd: f.repo })).rejects.toBeInstanceOf(configModule.ConfigError);
      else expect((await context({ cwd: f.repo })).workspaceRoot).toBe(f.repo);
      if (kind === "unreadable") await chmod(path, 0o600);
    },
  );
  test("nested child's parent primary tracked fallback keeps owner root", async () => {
    const f = await contextFixture();
    const path = join(f.repo, ".arashi/config.json");
    await mkdir(join(f.repo, ".arashi"));
    await writeFile(path, JSON.stringify({ ...raw, defaults: { t3: { model: "parent" } } }));
    await git(["add", ".arashi/config.json"], f.repo);
    await git(["commit", "-m", "parent config"], f.repo);
    await rm(path);
    const linked = join(f.root, "linked");
    await git(["worktree", "add", "-b", "linked", linked], f.repo);
    await rm(join(linked, ".arashi/config.json"));
    const child = join(linked, "repos/child");
    await mkdir(child, { recursive: true });
    await git(["init", "-b", "main"], child);
    await git(["config", "user.name", "T3 readiness fixture"], child);
    await git(["config", "user.email", "t3-readiness@example.invalid"], child);
    await git(["commit", "--allow-empty", "-m", "child"], child);
    const result = await context({ cwd: child });
    expect(result.checkout).toBe(child);
    expect(result.workspaceRoot).toBe(f.repo);
    expect(result.settings.model).toBe("parent");
    expect(result.workspace?.source).toBe("repository-content");
  });
  test("configured bare common root remains authority over linked local config", async () => {
    const f = await contextFixture();
    const bare = join(f.root, "bare.git");
    await git(["clone", "--bare", f.repo, bare], f.root);
    await mkdir(join(bare, ".arashi"));
    await writeFile(
      join(bare, ".arashi/config.json"),
      JSON.stringify({ ...raw, defaults: { t3: { model: "bare-owner" } } }),
    );
    const linked = join(f.root, "bare linked");
    await git(["worktree", "add", linked, "main"], bare);
    await mkdir(join(linked, ".arashi"));
    await writeFile(
      join(linked, ".arashi/config.json"),
      JSON.stringify({ ...raw, defaults: { t3: { model: "linked" } } }),
    );
    const result = await context({ cwd: linked });
    expect(result.checkout).toBe(linked);
    expect(result.workspaceRoot).toBe(bare);
    expect(result.settings.model).toBe("bare-owner");
  });
  test.each(["normal", "unsafe receipt root"])(
    "actual discovery preserves calibrated fixture %s",
    async (kind) => {
      const f = await contextFixture();
      await f.installMarkers();
      const path = join(f.repo, ".arashi/config.json");
      await writeFile(path, JSON.stringify(raw));
      await chmod(path, 0o640);
      if (kind === "unsafe receipt root")
        await chmod(join(f.repo, ".git/.arashi-t3-handoffs"), 0o777);
      const before = await f.snapshot();
      const ordinary = [
        vi.spyOn(configModule, "loadConfig"),
        vi.spyOn(configModule, "findWorkspaceRoot"),
      ];
      const read = vi.spyOn(runtime, "file");
      const processes = vi.spyOn(runtime, "spawn");
      filesystemAudit.calls = [];
      filesystemAudit.active = true;
      await context({ cwd: f.repo });
      filesystemAudit.active = false;
      expect(
        filesystemAudit.calls.filter((call) =>
          ["open", "readFile", "readdir"].includes(call.operation),
        ),
      ).toEqual([{ operation: "open", path }]);
      for (const call of filesystemAudit.calls) {
        expect(["chmod", "mkdir", "writeFile", "rm"].includes(call.operation)).toBe(false);
        expect(call.path).not.toMatch(
          /handoffs|receipt|lock|orphan|hooks|userdata|private-control/u,
        );
      }
      for (const spy of ordinary) expect(spy).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      const allowed = new Set([
        JSON.stringify(["git", "rev-parse", "--is-bare-repository"]),
        JSON.stringify(["git", "rev-parse", "--show-toplevel"]),
        JSON.stringify(["git", "rev-parse", "--git-common-dir"]),
        JSON.stringify(["git", "worktree", "list", "--porcelain", "-z"]),
      ]);
      expect(processes.mock.calls.length).toBe(4);
      for (const [argv] of processes.mock.calls)
        expect(allowed.has(JSON.stringify(argv))).toBe(true);
      const processLedger = processes.mock.calls.map(([argv, options]) => ({
        argv,
        cwd: options?.cwd,
        envKeys: Object.keys(options?.env ?? {}).toSorted(),
      }));
      processes.mockRestore();
      read.mockRestore();
      expect(await f.effects()).toEqual([]);
      const after = await f.snapshot();
      expect(after).toEqual(before);
      await saveEffectEvidence(
        kind === "normal" ? "local" : "unsafe-receipt-root",
        before,
        after,
        processLedger,
        filesystemAudit.calls,
      );
      for (const marker of Object.values(f.markers))
        await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("readiness additional topology boundaries", () => {
  test("unborn ordinary repository still selects exact checkout without adoption", async () => {
    const f = await contextFixture();
    const empty = join(f.root, "empty");
    await mkdir(empty);
    await git(["init", "-b", "main"], empty);
    const result = await context({ cwd: empty });
    expect(result.checkout).toBe(empty);
    expect(result.workspaceRoot).toBeNull();
  });
  test("physical HOME alias is never misread as ancestor workspace", async () => {
    const f = await contextFixture();
    const alias = join(f.home, "alias");
    await symlink(f.root, alias);
    vi.stubEnv("HOME", alias);
    await mkdir(join(f.root, ".arashi"));
    await writeFile(
      join(f.root, ".arashi/config.json"),
      JSON.stringify({ version: "1.0.0", defaults: { t3: { model: "personal" } } }),
    );
    const result = await context({ cwd: f.repo });
    expect(result.workspaceRoot).toBeNull();
    expect(result.settings.model).toBe("personal");
  });
  test("healthy unrelated sibling configuration never supplies settings", async () => {
    const f = await contextFixture();
    const sibling = join(f.root, "sibling");
    await mkdir(join(sibling, ".arashi"), { recursive: true });
    await writeFile(
      join(sibling, ".arashi/config.json"),
      JSON.stringify({ ...raw, defaults: { t3: { model: "sibling" } } }),
    );
    expect((await context({ cwd: f.repo })).settings.model).toBeUndefined();
  });
  test.each(["absolute", "relative"])(
    "retains workspace-authored %s worktrees policy",
    async (kind) => {
      const f = await contextFixture();
      await mkdir(join(f.repo, ".arashi"));
      await mkdir(join(f.home, ".arashi"));
      const directory = kind === "absolute" ? join(f.root, "absolute-trees") : "../authored-trees";
      await writeFile(
        join(f.repo, ".arashi/config.json"),
        JSON.stringify({ ...raw, worktreesDir: directory }),
      );
      await writeFile(
        join(f.home, ".arashi/config.json"),
        JSON.stringify({ version: "1.0.0", worktreesDir: "../user-trees" }),
      );
      if (kind === "absolute") {
        await expect(context({ cwd: f.repo })).rejects.toBeInstanceOf(configModule.ConfigError);
      } else {
        expect((await context({ cwd: f.repo })).roots?.worktreesBase).toBe(
          join(f.root, "authored-trees"),
        );
      }
    },
  );
  test("absolute personal worktrees retain repository qualification", async () => {
    const f = await contextFixture();
    await mkdir(join(f.repo, ".arashi"));
    await mkdir(join(f.home, ".arashi"));
    await writeFile(join(f.repo, ".arashi/config.json"), JSON.stringify(raw));
    const directory = join(f.root, "personal-trees");
    await writeFile(
      join(f.home, ".arashi/config.json"),
      JSON.stringify({ version: "1.0.0", worktreesDir: directory }),
    );
    const { resolveUserWorktreesBase } = await import("../../src/lib/user-config.ts");
    expect((await context({ cwd: f.repo })).roots?.worktreesBase).toBe(
      resolveUserWorktreesBase(f.repo, directory),
    );
  });
});

describe("readiness tracked-primary effect boundary", () => {
  test("real discovery reads filtered tracked config as a blob without filter execution", async () => {
    const f = await contextFixture();
    await f.installMarkers();
    const path = join(f.repo, ".arashi/config.json");
    await writeFile(path, JSON.stringify(raw));
    await writeFile(join(f.repo, ".gitattributes"), ".arashi/config.json filter=marker-clean\n");
    await git(["add", ".arashi/config.json", ".gitattributes"], f.repo);
    await git(["commit", "-m", "filtered config"], f.repo);
    await rm(path);
    const before = await f.snapshot();
    const marker = await readFile(f.markers.clean);
    const processes = vi.spyOn(runtime, "spawn");
    const result = await context({ cwd: f.repo });
    expect(result.checkout).toBe(f.repo);
    expect(result.workspace?.source).toBe("repository-content");
    expect(processes.mock.calls.map(([argv]) => argv)).toEqual([
      ["git", "rev-parse", "--is-bare-repository"],
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "rev-parse", "--git-common-dir"],
      ["git", "worktree", "list", "--porcelain", "-z"],
      ["git", "rev-parse", "--verify", "HEAD"],
      ["git", "symbolic-ref", "--short", "HEAD"],
      ["git", "show-ref", "--verify", "refs/heads/main"],
      ["git", "rev-parse", "--verify", "main^{tree}"],
      [
        "git",
        "ls-tree",
        "-z",
        expect.stringMatching(/^[0-9a-f]{40}$/),
        "--",
        ".arashi/config.json",
      ],
      ["git", "cat-file", "-t", expect.stringMatching(/^[0-9a-f]{40}$/)],
      ["git", "cat-file", "-s", expect.stringMatching(/^[0-9a-f]{40}$/)],
      ["git", "cat-file", "-p", expect.stringMatching(/^[0-9a-f]{40}$/)],
    ]);
    processes.mockRestore();
    expect(await f.snapshot()).toEqual(before);
    expect(await readFile(f.markers.clean)).toEqual(marker);
    for (const path of [f.markers.process, f.markers.fetch, f.markers.hook])
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.effects()).toEqual([]);
  });
});

describe("specification corrections S1–S4", () => {
  test.each([
    ["implicit", "healthy"],
    ["explicit", "healthy"],
    ["implicit", "malformed"],
    ["explicit", "malformed"],
  ])("S1 stale unrelated registration: %s selected %s config", async (selection, kind) => {
    const f = await contextFixture();
    const stale = join(f.root, "missing-linked");
    await git(["worktree", "add", "-b", "stale", stale], f.repo);
    await rm(stale, { recursive: true });
    await mkdir(join(f.repo, ".arashi"));
    await writeFile(
      join(f.repo, ".arashi/config.json"),
      kind === "malformed" ? "{" : JSON.stringify(raw),
    );
    const before = await f.snapshot();
    const options = selection === "explicit" ? { cwd: f.home, path: f.repo } : { cwd: f.repo };
    if (kind === "malformed") {
      await expect(context(options)).rejects.toBeInstanceOf(configModule.ConfigError);
    } else {
      await expect(context(options)).resolves.toMatchObject({
        checkout: f.repo,
        workspaceRoot: f.repo,
      });
    }
    expect(await f.snapshot()).toEqual(before);
  });

  test("S1 implicit identity read failure is not global absence", async () => {
    const f = await contextFixture();
    await writeFile(join(f.repo, ".git/config"), "[broken\n");
    await expect(context({ cwd: f.repo })).rejects.toThrow();
  });

  test.each(["malformed", "unreadable"])(
    "S2 bare owner cannot hide %s linked authority",
    async (kind) => {
      const f = await contextFixture();
      const bare = join(f.root, "bare.git");
      await git(["clone", "--bare", f.repo, bare], f.root);
      await mkdir(join(bare, ".arashi"));
      await writeFile(join(bare, ".arashi/config.json"), JSON.stringify(raw));
      const linked = join(f.root, "bare-linked");
      await git(["worktree", "add", linked, "main"], bare);
      await mkdir(join(linked, ".arashi"));
      const path = join(linked, ".arashi/config.json");
      await writeFile(path, kind === "malformed" ? "{" : JSON.stringify(raw));
      if (kind === "unreadable") {
        await chmod(path, 0);
      }
      const before = await stat(path);
      try {
        await expect(context({ cwd: linked })).rejects.toBeInstanceOf(configModule.ConfigError);
        const after = await stat(path);
        expect({ mode: after.mode, mtimeMs: after.mtimeMs, size: after.size }).toEqual({
          mode: before.mode,
          mtimeMs: before.mtimeMs,
          size: before.size,
        });
      } finally {
        if (kind === "unreadable") {
          await chmod(path, 0o600);
        }
      }
    },
  );

  test.each([
    ["linked", "relative"],
    ["linked", "absolute"],
    ["child", "relative"],
    ["child", "absolute"],
  ])("S3 %s keeps primary-owned %s personal root", async (selection, kind) => {
    const f = await contextFixture();
    await mkdir(join(f.repo, ".arashi"));
    await writeFile(join(f.repo, ".arashi/config.json"), JSON.stringify(raw));
    await git(["add", ".arashi/config.json"], f.repo);
    await git(["commit", "-m", "tracked owner"], f.repo);
    const linked = join(f.root, "nested/linked");
    await mkdir(join(f.root, "nested"));
    await git(["worktree", "add", "-b", "linked", linked], f.repo);
    const directory = kind === "relative" ? "../user-trees" : join(f.root, "personal-trees");
    await mkdir(join(f.home, ".arashi"));
    await writeFile(
      join(f.home, ".arashi/config.json"),
      JSON.stringify({ version: "1.0.0", worktreesDir: directory }),
    );
    let cwd = linked;
    if (selection === "child") {
      cwd = join(linked, "repos/child");
      await mkdir(cwd, { recursive: true });
      await git(["init", "-b", "main"], cwd);
    }
    const before = await f.snapshot();
    const result = await context({ cwd });
    const { resolveUserWorktreesBase } = await import("../../src/lib/user-config.ts");
    expect(result.checkout).toBe(cwd);
    expect(result.workspaceRoot).toBe(linked);
    expect(result.roots?.repositoriesBase).toBe(join(linked, "repos"));
    expect(result.roots?.worktreesBase).toBe(resolveUserWorktreesBase(f.repo, directory));
    expect(await f.snapshot()).toEqual(before);
  });

  test.each(["cli", "workspace", "user"])(
    "S4 %s absolute base overrides invalid unused environment",
    async (layer) => {
      const f = await contextFixture();
      vi.stubEnv("T3CODE_HOME", "relative-environment");
      if (layer !== "cli") {
        const owner = layer === "workspace" ? f.repo : f.home;
        await mkdir(join(owner, ".arashi"));
        await writeFile(
          join(owner, ".arashi/config.json"),
          JSON.stringify({
            ...(layer === "workspace" ? raw : { version: "1.0.0" }),
            defaults: { t3: { baseDir: f.baseDir } },
          }),
        );
      }
      const before = await f.snapshot();
      await expect(
        context({ cwd: f.repo, explicitSettings: layer === "cli" ? { baseDir: f.baseDir } : {} }),
      ).resolves.toMatchObject({
        settings: { baseDir: f.baseDir },
        sources: { baseDir: layer },
      });
      expect(await f.snapshot()).toEqual(before);
    },
  );

  test("S4 invalid environment rejects when it wins", async () => {
    const f = await contextFixture();
    vi.stubEnv("T3CODE_HOME", "relative-environment");
    await expect(context({ cwd: f.home })).rejects.toThrow(/absolute path/);
  });

  test.each(["workspace", "user"])(
    "S4 invalid applicable %s rejects despite CLI override",
    async (layer) => {
      const f = await contextFixture();
      const owner = layer === "workspace" ? f.repo : f.home;
      await mkdir(join(owner, ".arashi"));
      await writeFile(
        join(owner, ".arashi/config.json"),
        JSON.stringify({
          ...(layer === "workspace" ? raw : { version: "1.0.0" }),
          defaults: { t3: { baseDir: "relative-authored" } },
        }),
      );
      await expect(
        context({ cwd: f.repo, explicitSettings: { baseDir: f.baseDir } }),
      ).rejects.toThrow();
    },
  );
});

describe("readiness exact whitespace paths", () => {
  test.each(["trailing space ", "embedded\nnewline"])(
    "preserves physical path %j",
    async (name) => {
      const f = await contextFixture();
      const target = join(f.root, name);
      await mkdir(target);
      await git(["init", "-b", "main"], target);
      expect((await context({ cwd: f.home, path: target })).checkout).toBe(target);
    },
  );
});
