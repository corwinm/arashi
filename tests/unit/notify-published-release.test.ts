import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import {
  extractClosingReferences,
  notificationMarker,
  notifyTarget,
} from "../../scripts/release/notify-published-release.mjs";

const missingRequest = async (): Promise<never> => {
  throw Object.assign(new Error("Not Found"), { status: 404 });
};

describe("published release notifications", () => {
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
      if (path.endsWith("/comments?per_page=100")) {
        return [{ body: notificationMarker("1.35.2") }];
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
});
