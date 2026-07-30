import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDir, "../..");
const workflowPath = join(repositoryRoot, ".github/workflows/release.yml");
const releaseConfigPath = join(repositoryRoot, ".releaserc.json");
const preflightPath = join(repositoryRoot, "scripts/release/verify-gpg-signing.sh");
const canRunGpgPreflight =
  process.platform !== "win32" &&
  spawnSync("bash", ["--version"]).status === 0 &&
  spawnSync("gpg", ["--version"]).status === 0 &&
  spawnSync("gpgconf", ["--version"]).status === 0;

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`;
}

function semanticReleaseExpression(expression: string): string {
  return `\${${expression}}`;
}

function workflowStep(source: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    return "";
  }
  const next = source.indexOf("\n      - name:", start + marker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function snapshotObjectStore(gitDir: string): string[] {
  const objectsDir = join(gitDir, "objects");
  const files: string[] = [];
  const pending = [objectsDir];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        files.push(`${relative(objectsDir, path)}:${statSync(path).size}`);
      }
    }
  }

  return files.toSorted();
}

function generateSigningKey(home: string, passphrase: string): string {
  execFileSync("gpgconf", ["--launch", "gpg-agent"], {
    env: { ...process.env, GNUPGHOME: home },
    stdio: "pipe",
  });
  execFileSync(
    "gpg",
    [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      passphrase,
      "--quick-generate-key",
      "Corwin Marsh <corwinm@users.noreply.github.com>",
      "ed25519",
      "cert",
      "1d",
    ],
    { env: { ...process.env, GNUPGHOME: home }, stdio: "pipe" },
  );

  const listing = execFileSync("gpg", ["--batch", "--with-colons", "--list-secret-keys"], {
    encoding: "utf8",
    env: { ...process.env, GNUPGHOME: home },
  });
  const fingerprint = listing
    .split("\n")
    .find((line) => line.startsWith("fpr:"))
    ?.split(":")[9];

  if (!fingerprint) {
    throw new Error("Generated test key did not expose a fingerprint");
  }

  execFileSync(
    "gpg",
    [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      passphrase,
      "--quick-add-key",
      fingerprint,
      "ed25519",
      "sign",
      "1d",
    ],
    { env: { ...process.env, GNUPGHOME: home }, stdio: "pipe" },
  );
  return fingerprint;
}

describe("release commit signing workflow", () => {
  test("pins the GPG importer and wires separate signing secrets", () => {
    const importStep = workflowStep(readWorkflow(), "Import release GPG key");

    expect(importStep).toContain("id: import_gpg");
    expect(importStep).toContain(
      "uses: crazy-max/ghaction-import-gpg@2dc316deee8e90f13e1a351ab510b4d5bc0c82cd",
    );
    expect(importStep).toContain(
      `gpg_private_key: ${githubExpression("secrets.RELEASE_GPG_PRIVATE_KEY")}`,
    );
    expect(importStep).toContain(
      `passphrase: ${githubExpression("secrets.RELEASE_GPG_PASSPHRASE")}`,
    );
    expect(importStep).toContain("git_user_signingkey: true");
    expect(importStep).toContain("git_commit_gpgsign: true");
    expect(importStep).not.toContain("git_tag_gpgsign: true");
  });

  test("runs signing preflight before semantic-release with the release identity", () => {
    const source = readWorkflow();
    const configureIndex = source.indexOf("      - name: Configure OpenPGP signing\n");
    const preflightIndex = source.indexOf("      - name: Verify GPG commit signing\n");
    const releaseIndex = source.indexOf("      - name: Run semantic-release\n");
    const configure = workflowStep(source, "Configure OpenPGP signing");
    const preflight = workflowStep(source, "Verify GPG commit signing");
    const release = workflowStep(source, "Run semantic-release");
    const expectedIdentity = [
      "GIT_AUTHOR_NAME: Corwin Marsh",
      "GIT_AUTHOR_EMAIL: corwinm@users.noreply.github.com",
      "GIT_COMMITTER_NAME: Corwin Marsh",
      "GIT_COMMITTER_EMAIL: corwinm@users.noreply.github.com",
    ];

    expect(configureIndex).toBeGreaterThan(-1);
    expect(configure).toContain("run: git config --local gpg.format openpgp");
    expect(preflightIndex).toBeGreaterThan(configureIndex);
    expect(releaseIndex).toBeGreaterThan(preflightIndex);
    expect(preflight).toContain("run: ./scripts/release/verify-gpg-signing.sh");
    expect(preflight).toContain(
      `RELEASE_GPG_FINGERPRINT: ${githubExpression("steps.import_gpg.outputs.fingerprint")}`,
    );
    expect(preflight).toContain(
      `RELEASE_GPG_KEY_NAME: ${githubExpression("steps.import_gpg.outputs.name")}`,
    );
    expect(preflight).toContain(
      `RELEASE_GPG_KEY_EMAIL: ${githubExpression("steps.import_gpg.outputs.email")}`,
    );
    for (const identityVariable of expectedIdentity) {
      expect(preflight).toContain(identityVariable);
      expect(release).toContain(identityVariable);
    }
  });

  test("preserves semantic-release git assets, message, and lightweight tags", () => {
    const releaseConfig = JSON.parse(readFileSync(releaseConfigPath, "utf8")) as {
      plugins: (string | [string, Record<string, unknown>])[];
    };
    const gitPlugin = releaseConfig.plugins.find(
      (plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/git",
    );
    const source = readWorkflow();

    expect(gitPlugin?.[1]).toMatchObject({
      assets: ["package.json", "CHANGELOG.md"],
      message: `chore(release): ${semanticReleaseExpression("nextRelease.version")} [skip ci]\n\n${semanticReleaseExpression("nextRelease.notes")}`,
    });
    expect(source).not.toContain("git_tag_gpgsign: true");
    expect(source).not.toContain("tag.gpgSign");
  });

  test.skipIf(!canRunGpgPreflight)(
    "preflight signs in an isolated object store without mutating checkout state",
    () => {
      expect(existsSync(preflightPath)).toBe(true);

      const signingTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
      const root = mkdtempSync(join(signingTempRoot, "arashi-release-signing-"));
      const repository = join(root, "repository");
      const gpgHome = join(root, "gnupg");
      const passphrase = "test-release-passphrase";

      try {
        mkdirSync(repository, { recursive: true });
        mkdirSync(gpgHome, { recursive: true });
        chmodSync(gpgHome, 0o700);
        const fingerprint = generateSigningKey(gpgHome, passphrase);

        git(repository, ["init", "-b", "main"]);
        git(repository, ["config", "user.name", "Corwin Marsh"]);
        git(repository, ["config", "user.email", "corwinm@users.noreply.github.com"]);
        git(repository, ["config", "commit.gpgsign", "false"]);
        writeFileSync(join(repository, "README.md"), "release signing fixture\n");
        git(repository, ["add", "README.md"]);
        git(repository, ["commit", "-m", "test: initialize signing fixture"]);

        const gpgWrapper = join(root, "gpg-wrapper.sh");
        writeFileSync(
          gpgWrapper,
          '#!/bin/sh\nexec gpg --batch --pinentry-mode loopback --passphrase "$RELEASE_GPG_PASSPHRASE" "$@"\n',
        );
        chmodSync(gpgWrapper, 0o700);
        git(repository, ["config", "user.signingkey", fingerprint]);
        git(repository, ["config", "commit.gpgsign", "true"]);
        git(repository, ["config", "gpg.format", "openpgp"]);
        git(repository, ["config", "gpg.program", gpgWrapper]);

        const gitDir = git(repository, ["rev-parse", "--absolute-git-dir"]);
        const before = {
          head: git(repository, ["rev-parse", "HEAD"]),
          index: readFileSync(join(gitDir, "index")).toString("base64"),
          objects: snapshotObjectStore(gitDir),
          refs: git(repository, ["show-ref"]),
          status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
        };
        const env = {
          GIT_AUTHOR_EMAIL: "corwinm@users.noreply.github.com",
          GIT_AUTHOR_NAME: "Corwin Marsh",
          GIT_COMMITTER_EMAIL: "corwinm@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Corwin Marsh",
          GNUPGHOME: gpgHome,
          RELEASE_GPG_FINGERPRINT: fingerprint,
          RELEASE_GPG_KEY_EMAIL: "corwinm@users.noreply.github.com",
          RELEASE_GPG_KEY_NAME: "Corwin Marsh",
          RELEASE_GPG_PASSPHRASE: passphrase,
        };
        const result = spawnSync("bash", [preflightPath], {
          cwd: repository,
          encoding: "utf8",
          env: { ...process.env, ...env },
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("GPG signing preflight passed");
        expect(result.stdout).not.toContain(passphrase);
        expect(result.stderr).not.toContain(passphrase);
        expect(git(repository, ["rev-parse", "HEAD"])).toBe(before.head);
        expect(git(repository, ["show-ref"])).toBe(before.refs);
        expect(git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
          before.status,
        );
        expect(readFileSync(join(gitDir, "index")).toString("base64")).toBe(before.index);
        expect(snapshotObjectStore(gitDir)).toEqual(before.objects);
      } finally {
        spawnSync("gpgconf", ["--kill", "gpg-agent"], {
          env: { ...process.env, GNUPGHOME: gpgHome },
        });
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  test.skipIf(!canRunGpgPreflight)(
    "preflight rejects an identity that does not match the imported key",
    () => {
      expect(existsSync(preflightPath)).toBe(true);

      const result = spawnSync("bash", [preflightPath], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: "corwinm@users.noreply.github.com",
          GIT_AUTHOR_NAME: "Corwin Marsh",
          GIT_COMMITTER_EMAIL: "corwinm@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Corwin Marsh",
          RELEASE_GPG_FINGERPRINT: "0000000000000000000000000000000000000000",
          RELEASE_GPG_KEY_EMAIL: "wrong@example.com",
          RELEASE_GPG_KEY_NAME: "Wrong Identity",
        },
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("does not match");
    },
  );
});
