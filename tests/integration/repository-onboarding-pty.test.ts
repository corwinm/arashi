import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const helper = join(root, "tests/helpers/repository-onboarding-pty.mjs");
const temporaryRoots: string[] = [];

type Interaction = { waitFor: string; bytes: string };
type JourneyResult = {
  result: {
    status: string;
    reason?: string;
    editor?: {
      candidate: { repos: Record<string, unknown> };
      scripts: Array<{ lifecycle: string; mode: number | null; path: string }>;
    };
  };
  installed: Array<{ content: string; mode: number; path: string }>;
  existingHookContent?: string;
  transcript: string;
};

const runJourney = async (
  interactions: Interaction[],
  options: { existingHookContent?: string } = {},
): Promise<JourneyResult> => {
  const workspace = await mkdtemp(join(tmpdir(), "arashi-onboarding-pty-"));
  temporaryRoots.push(workspace);
  const repository = join(workspace, "repos", "app");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, ".env.local"), "ignored-local-value\n");
  await writeFile(join(repository, ".gitignore"), ".env.local\n");
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const resultPath = join(workspace, "result.json");
  const encoded = Buffer.from(
    JSON.stringify({ ...options, interactions, repository, resultPath, workspace }),
  ).toString("base64");
  const processResult = spawnSync(process.execPath, [helper, root, encoded], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(processResult.status, processResult.stderr || processResult.stdout).toBe(0);
  const result = JSON.parse(await readFile(resultPath, "utf8")) as Omit<
    JourneyResult,
    "transcript"
  >;
  return { ...result, transcript: Buffer.from(processResult.stdout, "base64").toString("utf8") };
};

const yes = "y\r";
const enter = "\r";
const down = "\x1b[B";
const choose = (...indexes: number[]): string => {
  let cursor = 0;
  let bytes = "";
  for (const index of indexes) {
    bytes += down.repeat(index - cursor) + " ";
    cursor = index;
  }
  return bytes + enter;
};
const begin = (sections: number[]): Interaction[] => [
  { waitFor: "Configure repository worktree setup now?", bytes: yes },
  { waitFor: "Choose repository setup sections:", bytes: choose(...sections) },
];
const finish = (): Interaction => ({ waitFor: "Apply this repository setup?", bytes: yes });

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// The helper drives a POSIX PTY and imports source paths directly. Native Windows terminal
// behavior is covered by the dedicated built-binary acceptance job.
describe.skipIf(process.platform === "win32")("repository onboarding raw PTY journeys", () => {
  test("top-level default-no decline is a no-op", async () => {
    const journey = await runJourney([
      { waitFor: "Configure repository worktree setup now?", bytes: enter },
    ]);
    expect(journey.result).toMatchObject({ status: "declined" });
    expect(journey.installed).toEqual([]);
  });

  test.each([
    ["copy-only", 0, "copy"],
    ["symlink-only", 1, "symlink"],
  ] as const)(
    "collects %s paths without inferring suggestion selection",
    async (_name, section, field) => {
      const journey = await runJourney([
        ...begin([section]),
        { waitFor: `Enter one ${field} path`, bytes: `.manual-${field}\r` },
        { waitFor: `Add another ${field} path?`, bytes: down + enter },
        finish(),
      ]);
      expect(journey.result.status).toBe("confirmed");
      expect(journey.result.editor?.candidate.repos.app).toMatchObject({
        [field]: [`.manual-${field}`],
      });
      expect(journey.result.editor?.candidate.repos.app).not.toMatchObject({
        [field]: [".env.local"],
      });
      expect(journey.installed).toEqual([]);
    },
  );

  test("inline command remains visible while the user enters it", async () => {
    const canary = "VISIBLE-Pty:/274?inline=value";
    const journey = await runJourney([
      ...begin([2]),
      { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0) },
      { waitFor: "Choose source for pre-create:", bytes: enter },
      { waitFor: "Enter Bash command for pre-create:", bytes: `${canary}\r` },
      finish(),
    ]);
    expect(journey.result).toMatchObject({ status: "confirmed" });
    expect(journey.installed).toEqual([]);
    expect(journey.transcript).toContain(canary);
  });

  test("file-only installs the exact active filename as executable safe no-op", async () => {
    const journey = await runJourney([
      ...begin([2]),
      { waitFor: "Choose repository lifecycle hooks:", bytes: choose(2) },
      { waitFor: "Choose source for pre-remove:", bytes: down + down + enter },
      finish(),
    ]);
    expect(journey.result.status).toBe("confirmed");
    expect(journey.installed).toHaveLength(1);
    expect(journey.installed[0]).toMatchObject({ mode: 0o755 });
    expect(journey.installed[0].path).toMatch(/repos\/app\/\.arashi\/hooks\/pre-remove\.sh$/);
    expect(journey.installed[0].content).toBe(
      "#!/usr/bin/env bash\n# Safe active Arashi lifecycle hook scaffold.\nexit 0\n",
    );
  });

  test("mixed inline/file setup persists distinct sources and installs only the file", async () => {
    const journey = await runJourney([
      ...begin([2]),
      { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0, 1) },
      { waitFor: "Choose source for pre-create:", bytes: enter },
      { waitFor: "Enter Bash command for pre-create:", bytes: "printf-inline\r" },
      { waitFor: "Choose source for post-create:", bytes: down + down + enter },
      finish(),
    ]);
    expect(journey.result.editor?.candidate.repos.app).toMatchObject({
      hooks: { "pre-create": { bash: "printf-inline" } },
    });
    expect(journey.installed).toHaveLength(1);
    expect(journey.installed[0].path).toMatch(/\.arashi\/hooks\/post-create\.app\.sh$/);
  });

  test("persistent native hook collision can be kept after file and inline retries", async () => {
    const existingHookContent = "#!/usr/bin/env bash\nprintf 'user-owned'\n";
    const journey = await runJourney(
      [
        ...begin([2]),
        { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0) },
        { waitFor: "Choose source for pre-create:", bytes: down + down + enter },
        { waitFor: "pre-create:", bytes: enter },
        { waitFor: "Enter Bash command for pre-create:", bytes: "printf-attempted\r" },
        { waitFor: "pre-create:", bytes: down + down + down + enter },
        finish(),
      ],
      { existingHookContent },
    );

    expect(journey.result.status).toBe("confirmed");
    expect(journey.result.editor?.scripts).toEqual([]);
    expect(journey.result.editor?.candidate.repos.app).not.toHaveProperty("hooks");
    expect(journey.installed).toEqual([]);
    expect(journey.existingHookContent).toBe(existingHookContent);
  });

  test("validation retries the owning path prompt", async () => {
    const journey = await runJourney([
      ...begin([0]),
      { waitFor: "Enter one copy path", bytes: "../outside\r" },
      { waitFor: "Add another copy path?", bytes: down + enter },
      { waitFor: "copy:", bytes: ".env.valid\r" },
      { waitFor: "Add another copy path?", bytes: down + enter },
      finish(),
    ]);
    expect(journey.result.editor?.candidate.repos.app).toMatchObject({ copy: [".env.valid"] });
    expect(journey.transcript).toContain("copy:");
  });

  test("final decline is cancellation rather than top-level minimal success", async () => {
    const journey = await runJourney([
      ...begin([]),
      { waitFor: "Apply this repository setup?", bytes: enter },
    ]);
    expect(journey.result).toMatchObject({ reason: "declined", status: "cancelled" });
    expect(journey.installed).toEqual([]);
  });

  const partialCommandCanary = 'Part!al-"Command\\:/274?value';
  const ctrlCStages: readonly {
    name: string;
    interactions: Interaction[];
    partialCommand?: string;
  }[] = [
    {
      name: "initial confirmation",
      interactions: [{ waitFor: "Configure repository worktree setup now?", bytes: "\x03" }],
    },
    {
      name: "section selection",
      interactions: [
        { waitFor: "Configure repository worktree setup now?", bytes: yes },
        { waitFor: "Choose repository setup sections:", bytes: "\x03" },
      ],
    },
    {
      name: "copy path input",
      interactions: [...begin([0]), { waitFor: "Enter one copy path", bytes: "\x03" }],
    },
    {
      name: "copy add-another selection",
      interactions: [
        ...begin([0]),
        { waitFor: "Enter one copy path", bytes: ".env.copy\r" },
        { waitFor: "Add another copy path?", bytes: "\x03" },
      ],
    },
    {
      name: "symlink path input",
      interactions: [...begin([1]), { waitFor: "Enter one symlink path", bytes: "\x03" }],
    },
    {
      name: "symlink add-another selection",
      interactions: [
        ...begin([1]),
        { waitFor: "Enter one symlink path", bytes: ".env.link\r" },
        { waitFor: "Add another symlink path?", bytes: "\x03" },
      ],
    },
    {
      name: "lifecycle selection",
      interactions: [
        ...begin([2]),
        { waitFor: "Choose repository lifecycle hooks:", bytes: "\x03" },
      ],
    },
    {
      name: "hook source selection",
      interactions: [
        ...begin([2]),
        { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0) },
        { waitFor: "Choose source for pre-create:", bytes: "\x03" },
      ],
    },
    {
      name: "partial inline Bash command input",
      partialCommand: partialCommandCanary,
      interactions: [
        ...begin([2]),
        { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0) },
        { waitFor: "Choose source for pre-create:", bytes: enter },
        {
          waitFor: "Enter Bash command for pre-create:",
          bytes: `${partialCommandCanary}\x03`,
        },
      ],
    },
    {
      name: "partial interpreter-map Bash command input",
      partialCommand: partialCommandCanary,
      interactions: [
        ...begin([2]),
        { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0) },
        { waitFor: "Choose source for pre-create:", bytes: down + enter },
        {
          waitFor: "Enter bash command for pre-create (blank to omit):",
          bytes: `${partialCommandCanary}\x03`,
        },
      ],
    },
    {
      name: "partial interpreter-map PowerShell command input",
      partialCommand: partialCommandCanary,
      interactions: [
        ...begin([2]),
        { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0) },
        { waitFor: "Choose source for pre-create:", bytes: down + enter },
        { waitFor: "Enter bash command for pre-create (blank to omit):", bytes: enter },
        {
          waitFor: "Enter powershell command for pre-create (blank to omit):",
          bytes: `${partialCommandCanary}\x03`,
        },
      ],
    },
    {
      name: "partial interpreter-map cmd command input",
      partialCommand: partialCommandCanary,
      interactions: [
        ...begin([2]),
        { waitFor: "Choose repository lifecycle hooks:", bytes: choose(0) },
        { waitFor: "Choose source for pre-create:", bytes: down + enter },
        { waitFor: "Enter bash command for pre-create (blank to omit):", bytes: enter },
        {
          waitFor: "Enter powershell command for pre-create (blank to omit):",
          bytes: enter,
        },
        {
          waitFor: "Enter cmd command for pre-create (blank to omit):",
          bytes: `${partialCommandCanary}\x03`,
        },
      ],
    },
    {
      name: "final confirmation",
      interactions: [...begin([]), { waitFor: "Apply this repository setup?", bytes: "\x03" }],
    },
  ];

  test.each(ctrlCStages)(
    "Ctrl+C at $name is controlled and mutation-free",
    async ({ interactions, partialCommand }) => {
      const journey = await runJourney(interactions);
      expect(journey.result).toMatchObject({ status: "cancelled" });
      expect(journey.installed).toEqual([]);
      if (partialCommand) expect(journey.transcript).toContain(partialCommand);
    },
    20_000,
  );
});
