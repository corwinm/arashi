import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { launchSwitchTarget } from "../../src/lib/switch-launcher.ts";
import { tmpdir } from "os";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe.skipIf(process.platform === "win32")("unmanaged Kitty process lifecycle", () => {
  test("returns after starting an independent Kitty process instead of waiting for its window", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-unmanaged-"));
    roots.push(root);
    const argvPath = join(root, "launcher.argv");
    const fakeKitty = join(root, "kitty");
    const fakeOpen = join(root, "open");
    const launcherDouble = [
      "#!/bin/sh\n",
      'printf \'%s\\n\' "$@" > "$ARASHI_TEST_ARGV"\n',
      'if [ "$1" = "--detach" ]; then exit 0; fi\n',
      "sleep 1.2\n",
    ].join("");
    await writeFile(fakeKitty, launcherDouble);
    await writeFile(fakeOpen, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ARASHI_TEST_ARGV"\n');
    await Promise.all([chmod(fakeKitty, 0o755), chmod(fakeOpen, 0o755)]);

    const startedAt = Date.now();
    const result = await launchSwitchTarget(
      { branchName: "feature/kitty", repoName: "fixture", worktreePath: root },
      { disposition: "window" },
      {
        env: {
          ARASHI_TEST_ARGV: argvPath,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          TERM_PROGRAM: "kitty",
        },
        platform: process.platform,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(750);
    expect(result.command).toEqual(
      process.platform === "darwin"
        ? ["open", "-na", "kitty.app", "--args", "--directory", root]
        : ["kitty", "--detach", "--directory", root],
    );
    expect(await readFile(argvPath, "utf8")).toBe(
      process.platform === "darwin"
        ? `-na\nkitty.app\n--args\n--directory\n${root}\n`
        : `--detach\n--directory\n${root}\n`,
    );
    expect(result.command).not.toContain("@");
    expect(result.command).not.toContain("--wait-for-single-instance-window-close");
  });
});
