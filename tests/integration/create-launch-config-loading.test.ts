import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/lib/config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("real create launch configuration loading", () => {
  test("normalizes legacy generic and editor defaults without rewriting or polluting stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-create-launch-config-"));
    roots.push(root);
    const configDirectory = join(root, ".arashi");
    const configPath = join(configDirectory, "config.json");
    await mkdir(configDirectory, { recursive: true });
    const raw = `${JSON.stringify(
      {
        defaults: {
          create: { launch: true, launchMode: "sesh", switch: false },
          editors: {
            vscode: { create: { launch_mode: "herdr", switch: true } },
          },
        },
        repos: {},
        reposDir: "./repos",
        version: "1",
      },
      null,
      2,
    )}\n`;
    await writeFile(configPath, raw);

    const originalStdoutWrite = process.stdout.write;
    const originalError = console.error;
    let stdout = "";
    const stderr: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));

    try {
      const config = await loadConfig(root);
      expect(config.defaults?.create).toEqual({ launch: "sesh", switch: false });
      expect(config.defaults?.editors?.vscode?.create).toEqual({
        launch: "herdr",
        switch: true,
      });
    } finally {
      console.error = originalError;
      process.stdout.write = originalStdoutWrite;
    }

    expect(await readFile(configPath, "utf8")).toBe(raw);
    expect(stdout).toBe("");
    expect(stderr.join("\n")).toContain("defaults.create.launch");
    expect(stderr.join("\n")).toContain("defaults.editors.vscode.create.launch_mode");
  });
});
