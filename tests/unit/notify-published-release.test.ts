import { describe, expect, test } from "vitest";
import {
  extractClosingReferences,
  isExactVersion,
  notificationMarker,
  notifyTarget,
  releaseCommits,
} from "../../scripts/release/notify-published-release.mjs";
import { readFileSync } from "node:fs";

const missingRequest = async (): Promise<never> => {
  throw Object.assign(new Error("Not Found"), { status: 404 });
};

describe("published release notifications", () => {
  test("rejects empty prerelease identifiers", () => {
    for (const version of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-01",
      "1.2.3-rc.01",
      "1.2.3-.",
      "1.2.3-foo.",
      "1.2.3-..",
    ]) {
      expect(isExactVersion(version)).toBe(false);
    }
    expect(isExactVersion("0.0.0")).toBe(true);
    expect(isExactVersion("1.2.3-0")).toBe(true);
    expect(isExactVersion("1.2.3-rc.1")).toBe(true);
  });

  test("keeps semantic-release notification hooks out of the publish result", () => {
    const releaseConfig = JSON.parse(
      readFileSync(new URL("../../.releaserc.json", import.meta.url), "utf8"),
    );

    expect(releaseConfig.success).toBe(false);
    expect(releaseConfig.fail).toBe(false);
  });

  test("extracts only local closing references", () => {
    expect(
      extractClosingReferences(
        "Fixes #12, closes corwinm/arashi#13, resolves https://github.com/corwinm/arashi/issues/14; fixes other/repo#99",
        "corwinm",
        "arashi",
      ),
    ).toEqual([12, 13, 14]);
  });

  test("uses a version marker so retries do not duplicate comments", () => {
    expect(notificationMarker("1.35.2")).toBe("<!-- arashi-release:1.35.2 -->");
  });

  test("skips deleted references without failing the notification pass", async () => {
    await expect(
      notifyTarget({
        number: 329,
        owner: "corwinm",
        releaseUrl: "https://github.com/corwinm/arashi/releases/tag/v1.35.2",
        repo: "arashi",
        request: missingRequest,
        version: "1.35.2",
      }),
    ).resolves.toBe("missing");
  });

  test("repairs a missing released label without duplicating the comment", async () => {
    const writes: string[] = [];
    const request = async (path: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        writes.push(path);
      }
      if (path.includes("/comments?")) {
        return [
          {
            body: notificationMarker("1.35.2"),
            user: { login: "github-actions[bot]" },
          },
        ];
      }
      return {};
    };

    await expect(
      notifyTarget({
        number: 12,
        owner: "corwinm",
        releaseUrl: "https://github.com/corwinm/arashi/releases/tag/v1.35.2",
        repo: "arashi",
        request,
        version: "1.35.2",
      }),
    ).resolves.toBe("existing");
    expect(writes).toEqual(["/repos/corwinm/arashi/issues/12/labels"]);
  });

  test("does not trust a release marker from another commenter", async () => {
    const writes: string[] = [];
    const request = async (path: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        writes.push(path);
      }
      if (path.includes("/comments?")) {
        return [{ body: notificationMarker("1.35.2"), user: { login: "attacker" } }];
      }
      return {};
    };

    await notifyTarget({
      number: 12,
      owner: "corwinm",
      releaseUrl: "https://github.com/corwinm/arashi/releases/tag/v1.35.2",
      repo: "arashi",
      request,
      version: "1.35.2",
    });

    expect(writes).toEqual([
      "/repos/corwinm/arashi/issues/12/comments",
      "/repos/corwinm/arashi/issues/12/labels",
    ]);
  });

  test("finds an authoritative marker on a later comment page", async () => {
    const reads: string[] = [];
    const writes: string[] = [];
    const request = async (path: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        writes.push(path);
      }
      if (path.includes("/comments?")) {
        reads.push(path);
        if (path.endsWith("page=1")) {
          return Array.from({ length: 100 }, () => ({ body: "old" }));
        }
        return [
          {
            body: notificationMarker("1.35.2"),
            user: { login: "github-actions[bot]" },
          },
        ];
      }
      return {};
    };

    await notifyTarget({
      number: 12,
      owner: "corwinm",
      releaseUrl: "https://github.com/corwinm/arashi/releases/tag/v1.35.2",
      repo: "arashi",
      request,
      version: "1.35.2",
    });

    expect(reads).toEqual([
      "/repos/corwinm/arashi/issues/12/comments?per_page=100&page=1",
      "/repos/corwinm/arashi/issues/12/comments?per_page=100&page=2",
    ]);
    expect(writes).toEqual(["/repos/corwinm/arashi/issues/12/labels"]);
  });

  test("loads every comparison page", async () => {
    const comparisonPaths: string[] = [];
    const request = async (path: string) => {
      if (path.endsWith("/releases?per_page=100")) {
        return [
          { html_url: "https://example.test/v1.35.2", tag_name: "v1.35.2" },
          { draft: false, prerelease: false, tag_name: "v1.35.1" },
        ];
      }
      comparisonPaths.push(path);
      const page = path.endsWith("page=1") ? 1 : 2;
      return {
        commits: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
          sha: `${page}-${index}`,
        })),
        total_commits: 101,
      };
    };

    const result = await releaseCommits({
      currentTag: "v1.35.2",
      owner: "corwinm",
      repo: "arashi",
      request,
    });

    expect(result.commits).toHaveLength(101);
    expect(comparisonPaths).toEqual([
      "/repos/corwinm/arashi/compare/v1.35.1...v1.35.2?per_page=100&page=1",
      "/repos/corwinm/arashi/compare/v1.35.1...v1.35.2?per_page=100&page=2",
    ]);
  });
});
