import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { executeShellUninstall } from "../../src/commands/shell.ts";
import {
  executeDirectUninstall,
  stageDirectUninstallHelper,
} from "../../src/commands/uninstall.ts";

const emptyDirectPlan = async () => ({
  files: [],
  installDirectory: "/owned",
  manifest: {} as never,
  manifestPath: "/owned/manifest",
});
const emptyShellPlan = async () => ({ startupFilePath: "/profile", status: "absent" as const });
const removableShellPlan = async () => ({
  currentContents: "x",
  nextContents: "",
  startupFilePath: "/profile",
  status: "removable" as const,
});

describe("uninstall command consent", () => {
  test("dry-run prints a preflighted plan without mutation or prompting", async () => {
    const apply = vi.fn();
    const confirm = vi.fn();
    const output: string[] = [];
    const result = await executeDirectUninstall(
      { dryRun: true },
      {
        apply,
        confirm,
        installDirectory: "/owned",
        plan: emptyDirectPlan,
        shellPlan: emptyShellPlan,
        write: (line) => output.push(line),
      },
    );
    expect(result).toBe("dry-run");
    expect(output.join("\n")).toMatch(/official-direct|Preserved/);
    expect(confirm).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  test("derives a custom direct install directory from the running executable", async () => {
    const plannedDirectories: string[] = [];
    await executeDirectUninstall(
      { dryRun: true },
      {
        execPath: "/custom/arashi/bin/arashi.bin",
        plan: async (installDirectory) => {
          plannedDirectories.push(installDirectory);
          return emptyDirectPlan();
        },
        shellPlan: emptyShellPlan,
        write: () => {},
      },
    );
    expect(plannedDirectories).toEqual(["/custom/arashi/bin"]);
  });

  test("non-interactive apply requires --yes and interactive confirmation defaults no", async () => {
    const apply = vi.fn();
    await expect(
      executeDirectUninstall(
        {},
        {
          apply,
          installDirectory: "/owned",
          interactive: false,
          plan: emptyDirectPlan,
          shellPlan: emptyShellPlan,
          write: () => {},
        },
      ),
    ).rejects.toThrow(/--yes/);
    const confirm = vi.fn(async () => ({ status: "ok", value: false }) as const);
    await expect(
      executeDirectUninstall(
        {},
        {
          apply,
          confirm,
          installDirectory: "/owned",
          interactive: true,
          plan: emptyDirectPlan,
          shellPlan: emptyShellPlan,
          write: () => {},
        },
      ),
    ).resolves.toBe("declined");
    expect(confirm).toHaveBeenCalledWith(expect.any(String), false);
    expect(apply).not.toHaveBeenCalled();
  });

  test("shell uninstall applies only after --yes", async () => {
    const apply = vi.fn();
    await expect(
      executeShellUninstall({ yes: true }, { apply, plan: removableShellPlan, write: () => {} }),
    ).resolves.toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
  });

  test("direct uninstall does not depend on ambient supported-shell detection", async () => {
    await expect(
      executeDirectUninstall(
        { dryRun: true },
        {
          installDirectory: "/owned",
          plan: emptyDirectPlan,
          shellPlan: async () => {
            throw new Error("Unable to detect a supported shell for `arashi shell uninstall`.");
          },
          write: () => {},
        },
      ),
    ).resolves.toBe("dry-run");
  });

  test("direct uninstall discovers shell blockers before consent or payload handoff", async () => {
    const apply = vi.fn();
    const confirm = vi.fn();
    await expect(
      executeDirectUninstall(
        { yes: true },
        {
          apply,
          confirm,
          installDirectory: "/owned",
          plan: emptyDirectPlan,
          shellPlan: async () => {
            throw new Error("ambiguous shell markers");
          },
          write: () => {},
        },
      ),
    ).rejects.toThrow(/ambiguous shell markers/);
    expect(confirm).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  test("direct uninstall reports an unsafe shell candidate without blocking payload handoff", async () => {
    const apply = vi.fn(async () => {});
    const output: string[] = [];
    await expect(
      executeDirectUninstall(
        { yes: true },
        {
          apply,
          installDirectory: "/owned",
          plan: emptyDirectPlan,
          shellPlan: async () => ({
            diagnostic: "symbolic link",
            startupFilePath: "/home/user/.zshrc",
            status: "preserved-unsafe" as const,
          }),
          write: (line) => output.push(line),
        },
      ),
    ).resolves.toBe("applied");
    expect(output.join("\n")).toContain("/home/user/.zshrc");
    expect(output.join("\n")).toMatch(/preserv.*symbolic link/i);
    expect(apply).toHaveBeenCalledOnce();
  });

  test("stages the manifest-owned helper and passes its declared directory and parent PID", async () => {
    const copies: string[][] = [];
    const spawns: { args: string[]; command: string; options: unknown }[] = [];
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { unref });
    await stageDirectUninstallHelper(
      {
        files: [
          {
            absolutePath: "/canonical/owned/uninstall.sh",
            digest: createHash("sha256").update("helper").digest("hex"),
            relativePath: "uninstall.sh",
            role: "uninstall-helper",
            status: "removable",
          },
        ],
        installDirectory: "/canonical/owned",
        manifest: { installDirectory: "/linked/owned", platform: "posix" } as never,
        manifestPath: "/canonical/owned/manifest",
      },
      {
        chmod: async () => {},
        copyFile: async (...paths) => {
          copies.push(paths);
        },
        mkdtemp: async () => "/tmp/arashi-uninstall-unique",
        parentPid: 42,
        readFile: async () => Buffer.from("helper"),
        spawn: (command, args, options) => {
          spawns.push({ args, command, options });
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
      },
    );
    expect(copies).toEqual([
      ["/canonical/owned/uninstall.sh", "/tmp/arashi-uninstall-unique/uninstall.sh"],
    ]);
    expect(spawns).toEqual([
      {
        command: "/tmp/arashi-uninstall-unique/uninstall.sh",
        args: ["--install-dir", "/linked/owned", "--parent-pid", "42", "--yes", "--temporary-self"],
        options: { detached: true, stdio: "inherit" },
      },
    ]);
    expect(unref).toHaveBeenCalledOnce();
  });

  test("rejects an asynchronous detached-helper spawn error without reporting success", async () => {
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { unref });
    const result = stageDirectUninstallHelper(
      {
        files: [
          {
            absolutePath: "/owned/uninstall.sh",
            digest: createHash("sha256").update("helper").digest("hex"),
            relativePath: "uninstall.sh",
            role: "uninstall-helper",
            status: "removable",
          },
        ],
        installDirectory: "/owned",
        manifest: { installDirectory: "/owned", platform: "posix" } as never,
        manifestPath: "/owned/manifest",
      },
      {
        chmod: async () => {},
        copyFile: async () => {},
        mkdtemp: async () => "/tmp/arashi-uninstall-unique",
        readFile: async () => Buffer.from("helper"),
        spawn: () => {
          queueMicrotask(() => child.emit("error", new Error("injected spawn error")));
          return child;
        },
      },
    );

    await expect(result).rejects.toThrow(/injected spawn error/);
    expect(unref).not.toHaveBeenCalled();
  });

  test("refuses to execute a staged helper whose bytes no longer match the manifest", async () => {
    const spawn = vi.fn();
    await expect(
      stageDirectUninstallHelper(
        {
          files: [
            {
              absolutePath: "/owned/uninstall.sh",
              digest: "0".repeat(64),
              relativePath: "uninstall.sh",
              role: "uninstall-helper",
              status: "removable",
            },
          ],
          installDirectory: "/owned",
          manifest: { platform: "posix" } as never,
          manifestPath: "/owned/manifest",
        },
        {
          chmod: async () => {},
          copyFile: async () => {},
          mkdtemp: async () => "/tmp/arashi-uninstall-unique",
          readFile: async () => Buffer.from("changed"),
          spawn,
        },
      ),
    ).rejects.toThrow(/staged uninstall helper.*digest/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});
