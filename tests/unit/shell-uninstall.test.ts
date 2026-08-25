import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyShellUninstall,
  planShellUninstall,
  planSupportedShellUninstalls,
} from "../../src/lib/shell-integration.ts";

const start = "# >>> arashi shell integration >>>";
const end = "# <<< arashi shell integration <<<";
let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashi-shell-uninstall-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("shell uninstall", () => {
  test("preflights every deterministic supported startup file", async () => {
    const zshProfile = join(home, ".zshrc");
    const fishProfile = join(home, ".config", "fish", "config.fish");
    await mkdir(join(home, ".config", "fish"), { recursive: true });
    await writeFile(zshProfile, `${start}\nzsh\n${end}\n`);
    await writeFile(fishProfile, `${start}\nfish\n${end}\n`);

    const plans = await planSupportedShellUninstalls({ HOME: home });

    expect(plans.map((plan) => plan.startupFilePath)).toEqual([zshProfile, fishProfile]);
    expect(plans.every((plan) => plan.status === "removable")).toBe(true);
  });

  test("all-shell planning reports linked and non-regular candidates without following them", async () => {
    const outside = join(home, "outside");
    const linked = join(home, ".zshrc");
    const nonRegular = join(home, ".bashrc");
    await writeFile(outside, `${start}\nowned\n${end}\n`);
    await (await import("node:fs/promises")).symlink(outside, linked);
    await mkdir(nonRegular);

    const plans = await planSupportedShellUninstalls({ HOME: home });

    expect(plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startupFilePath: linked, status: "preserved-unsafe" }),
        expect.objectContaining({ startupFilePath: nonRegular, status: "preserved-unsafe" }),
      ]),
    );
    expect(await readFile(outside, "utf8")).toBe(`${start}\nowned\n${end}\n`);
  });

  test("removes one exact managed range and preserves every outside byte", async () => {
    const profile = join(home, ".zshrc");
    await writeFile(profile, `before\n${start}\nowned\n${end}\nafter\n`);
    await chmod(profile, 0o640);
    const before = await stat(profile);
    const plan = await planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } });
    expect(plan.status).toBe("removable");
    await applyShellUninstall(plan);
    expect(await readFile(profile, "utf8")).toBe("before\n\nafter\n");
    const after = await stat(profile);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.ino).not.toBe(before.ino);
  });

  test("preserves the original and cleans the same-directory temporary file on rename failure", async () => {
    const profile = join(home, ".zshrc");
    const contents = `before\n${start}\nowned\n${end}\nafter\n`;
    await writeFile(profile, contents);
    await chmod(profile, 0o640);
    const before = await stat(profile);
    const plan = await planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } });

    await expect(
      applyShellUninstall(plan, {
        rename: async () => {
          throw new Error("injected rename failure");
        },
      }),
    ).rejects.toThrow(/injected rename failure/);

    expect(await readFile(profile, "utf8")).toBe(contents);
    expect((await stat(profile)).mode & 0o777).toBe(before.mode & 0o777);
    expect((await readdir(home)).filter((name) => name.includes("arashi-uninstall"))).toEqual([]);
  });

  test("fails closed when the startup file races immediately before atomic replacement", async () => {
    const profile = join(home, ".zshrc");
    const contents = `before\n${start}\nowned\n${end}\nafter\n`;
    await writeFile(profile, contents);
    const plan = await planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } });
    let lstatCalls = 0;

    await expect(
      applyShellUninstall(plan, {
        lstat: async (path) => {
          lstatCalls += 1;
          if (lstatCalls === 3) await writeFile(path, "raced bytes\n");
          return lstat(path);
        },
      }),
    ).rejects.toThrow(/changed after preflight/);

    expect(await readFile(profile, "utf8")).toBe("raced bytes\n");
    expect((await readdir(home)).filter((name) => name.includes("arashi-uninstall"))).toEqual([]);
  });

  test("preserves non-UTF-8 bytes outside the exact managed range", async () => {
    const profile = join(home, ".zshrc");
    const prefix = Buffer.from([0xff, 0x0a]);
    const suffix = Buffer.from([0x0a, 0x80]);
    await writeFile(
      profile,
      Buffer.concat([prefix, Buffer.from(`${start}\nowned\n${end}`), suffix]),
    );

    const plan = await planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } });
    await applyShellUninstall(plan);

    expect(await readFile(profile)).toEqual(Buffer.concat([prefix, suffix]));
  });

  test("missing markers are a no-op without creating a startup file", async () => {
    const plan = await planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } });
    expect(plan.status).toBe("absent");
    await applyShellUninstall(plan);
    await expect(readFile(join(home, ".zshrc"), "utf8")).rejects.toThrow();
  });

  test.each([
    ["orphan start", `${start}\n`],
    ["orphan end", `${end}\n`],
    ["duplicate", `${start}\nx\n${end}\n${start}\ny\n${end}\n`],
    ["nested", `${start}\n${start}\n${end}\n${end}\n`],
    ["reversed", `${end}\n${start}\n`],
  ])("refuses %s markers before writing", async (_name, contents) => {
    const profile = join(home, ".zshrc");
    await writeFile(profile, contents);
    await expect(planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } })).rejects.toThrow(
      /marker/i,
    );
    expect(await readFile(profile, "utf8")).toBe(contents);
  });

  test("refuses marker substrings embedded in unrelated command lines", async () => {
    const profile = join(home, ".zshrc");
    const contents = `before echo "${start}"\nunrelated command\necho "${end}" after\n`;
    await writeFile(profile, contents);

    await expect(planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } })).rejects.toThrow(
      /marker/i,
    );
    expect(await readFile(profile, "utf8")).toBe(contents);
  });

  test("plans canonical CRLF marker lines without changing outside bytes", async () => {
    const profile = join(home, ".zshrc");
    await writeFile(profile, `before\r\n${start}\r\nowned\r\n${end}\r\nafter\r\n`);

    const plan = await planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } });

    expect(plan.status).toBe("removable");
    expect(plan.nextContents).toBe("before\r\n\r\nafter\r\n");
  });

  test("refuses a linked deterministic startup target", async () => {
    const outside = join(home, "outside");
    const contents = `${start}\nowned\n${end}\n`;
    await writeFile(outside, contents);
    await (await import("node:fs/promises")).symlink(outside, join(home, ".zshrc"));
    await expect(planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } })).rejects.toThrow(
      /symbolic link/i,
    );
    expect(await readFile(outside, "utf8")).toBe(contents);
  });

  test("does not follow a startup file replaced by a symlink after planning", async () => {
    const profile = join(home, ".zshrc");
    const victim = join(home, "victim");
    const contents = `${start}\nowned\n${end}\n`;
    await writeFile(profile, contents);
    await writeFile(victim, contents);
    const plan = await planShellUninstall({ env: { HOME: home, SHELL: "/bin/zsh" } });
    await rm(profile);
    await (await import("node:fs/promises")).symlink(victim, profile);

    await expect(applyShellUninstall(plan)).rejects.toThrow();
    expect(await readFile(victim, "utf8")).toBe(contents);
  });
});
