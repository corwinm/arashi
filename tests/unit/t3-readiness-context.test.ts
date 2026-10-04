import { afterEach, describe, expect, test, vi } from "vitest";
import { runtime } from "../../src/lib/runtime.ts";
import * as configModule from "../../src/lib/config.ts";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";

let fixture: Awaited<ReturnType<typeof createReadinessFixture>> | undefined;
afterEach(async () => {
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
    expect(processes.mock.calls.map(([argv]) => argv)).toEqual([
      ["git", "symbolic-ref", "--short", "HEAD"],
      ["git", "show-ref", "--verify", "refs/heads/main"],
      ["git", "show", "main:.arashi/config.json"],
    ]);
    processes.mockRestore();
    expect(result?.source).toBe("repository-content");
    expect(result?.config).toEqual(configModule.normalizeConfig(raw));
    expect(await readFile(fixture.markers.clean)).toEqual(filterBefore);
    for (const marker of [fixture.markers.process, fixture.markers.fetch, fixture.markers.hook])
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.snapshot()).toEqual(before);
  });
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
