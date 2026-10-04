import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as native from "../../src/lib/t3-native.ts";
import { T3HandoffError } from "../../src/lib/t3-error.ts";
import { nativeEnvironment } from "../helpers/t3-native.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// Opt-in historical adapter exercises the REAL legacy issue/use/revoke path.
// It cannot recover the successful return value that legacy cleanup discards.
async function owned(
  ...args: Parameters<typeof native.withT3Session>
): Promise<native.T3OwnedSessionResult<unknown>> {
  if (process.env.ARASHI_SESSION_LEGACY_RED === "1") {
    try {
      return {
        use: { status: "succeeded", value: await native.withT3Session(...args) },
        cleanup: { status: "unknown", revoke: "succeeded" },
      };
    } catch {
      return {
        use: { status: "not_attempted" },
        cleanup: { status: "unknown", revoke: "not_attempted" },
      };
    }
  }
  return native.withOwnedT3Session(...args);
}
const body = (fields: object = {}) =>
  JSON.stringify({
    sessionId: "owned-session",
    token: "FIXTURE_SECRET",
    method: "bearer-access-token",
    scopes: ["orchestration:read"],
    expiresAt: "2026-10-04T12:00:00Z",
    ...fields,
  });
function runner(stdout: string, exitCode = 0, revoke: number | Error = 0) {
  const commands: string[][] = [];
  const runProcess: NonNullable<native.T3NativeDependencies["runProcess"]> = async (command) => {
    commands.push([...command]);
    if (command.includes("issue")) return { stdout, exitCode, stderr: "PRIVATE_STDERR" };
    if (revoke instanceof Error) throw revoke;
    return { stdout: "", stderr: "PRIVATE_STDERR", exitCode: revoke };
  };
  return { commands, runProcess };
}
describe("owned session foundation", () => {
  test("preserves successful use independently when revoke fails", async () => {
    const fixture = runner(body(), 0, 1);
    const result = await owned(nativeEnvironment(), ".", fixture, async () => "observed");
    expect(result.use).toEqual({ status: "succeeded", value: "observed" });
    expect(result.cleanup).toEqual({ status: "failed", revoke: "failed" });
  });
  test("cleans exact attributable ID with invalid token without using it", async () => {
    const fixture = runner(body({ token: {} }));
    let uses = 0;
    await owned(nativeEnvironment(), ".", fixture, async () => {
      uses++;
    });
    expect(uses).toBe(0);
    expect(fixture.commands.at(-1)).toEqual([
      "t3",
      "auth",
      "session",
      "revoke",
      "owned-session",
      "--base-dir",
      "/t3",
    ]);
  });
  test("exports the separate structured primitive", () => {
    expect(native.withOwnedT3Session).toBeTypeOf("function");
  });
  test.each([
    ["nonzero with ID", body(), 1, true],
    ["empty token", body({ token: "" }), 0, true],
    ["object token", body({ token: {} }), 0, true],
    ["array token", body({ token: ["secret"] }), 0, true],
    ["malformed JSON", "{", 0, false],
    ["missing ID", body({ sessionId: undefined }), 0, false],
    ["object ID", body({ sessionId: {} }), 0, false],
    ["array ID", body({ sessionId: ["owned-session"] }), 0, false],
    ["unsafe ID", body({ sessionId: "--all" }), 0, false],
    ["empty object", "{}", 0, false],
  ])("A13 %s", async (_name, stdout, exitCode, cleanup) => {
    const fixture = runner(stdout as string, exitCode as number);
    let uses = 0;
    const result = await owned(nativeEnvironment(), ".", fixture, async () => {
      uses++;
    });
    expect(uses).toBe(0);
    expect(result.use.status).toBe("not_attempted");
    expect(result.failure).toMatchObject({ code: "T3_AUTH_FAILED" });
    expect(result.cleanup).toEqual({
      status: "unknown",
      revoke: cleanup ? "succeeded" : "not_attempted",
    });
    expect(fixture.commands.filter((command) => command.includes("revoke"))).toHaveLength(
      cleanup ? 1 : 0,
    );
    expect(fixture.commands.flat()).not.toContain("list");
    expect(JSON.stringify(result)).not.toMatch(/FIXTURE_SECRET|PRIVATE_STDERR|owned-session/);
  });
  test.each(["spawn failure", "timeout"])(
    "A13 issue %s sanitizes failure and cannot guess cleanup",
    async (reason) => {
      const commands: string[][] = [];
      const result = await owned(
        nativeEnvironment(),
        ".",
        {
          runProcess: async (command) => {
            commands.push([...command]);
            throw new Error(`${reason} PRIVATE_STDERR`);
          },
        },
        async () => {
          throw new Error("must not use");
        },
      );
      expect(commands).toHaveLength(1);
      expect(result.failure).toMatchObject({ code: "T3_AUTH_FAILED" });
      expect(result.cleanup).toEqual({ status: "unknown", revoke: "not_attempted" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_STDERR");
    },
  );
  test.each([0, 1, new Error("PRIVATE_STDERR")])(
    "retains read failure with revoke %s",
    async (revoke) => {
      const fixture = runner(body(), 0, revoke);
      const result = await owned(nativeEnvironment(), ".", fixture, async () => {
        throw new T3HandoffError("T3_RESPONSE_INVALID", "T3 returned an incompatible response.");
      });
      expect(result.use.status).toBe("failed");
      expect(result.failure).toMatchObject({ code: "T3_RESPONSE_INVALID" });
      expect(result.cleanup).toEqual({
        status: revoke === 0 ? "unknown" : "failed",
        revoke: revoke === 0 ? "succeeded" : "failed",
      });
    },
  );
  test("undefined successful value is not a failed use", async () => {
    const result = await owned(nativeEnvironment(), ".", runner(body()), async () => undefined);
    expect(result.use).toEqual({ status: "succeeded", value: undefined });
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "succeeded" });
  });
  test("legacy wrapper preserves label, malformed issuance effects and cleanup error precedence", async () => {
    const invalid = runner(body({ token: {} }));
    await expect(
      native.withT3Session(nativeEnvironment(), ".", invalid, async () => 1),
    ).rejects.toMatchObject({ code: "T3_AUTH_FAILED" });
    expect(invalid.commands).toHaveLength(1);
    expect(invalid.commands[0]).toContain("Arashi handoff");
    const valid = runner(body(), 0, 1);
    await expect(
      native.withT3Session(nativeEnvironment(), ".", valid, async () => {
        throw new T3HandoffError("T3_RESPONSE_INVALID", "safe");
      }),
    ).rejects.toMatchObject({
      code: "T3_RESPONSE_INVALID",
      details: { sessionCleanupFailed: true },
    });
  });
  test("screens typed callback failure fields while legacy retains original error", async () => {
    const error = new T3HandoffError("T3_RESPONSE_INVALID", "FIXTURE_SECRET", {
      raw: "PRIVATE_STDERR",
    });
    const result = await owned(nativeEnvironment(), ".", runner(body()), async () => {
      throw error;
    });
    expect(result.failure?.code).toBe("T3_RESPONSE_INVALID");
    expect(result.failure?.message).not.toContain("FIXTURE_SECRET");
    expect(JSON.stringify(result)).not.toMatch(/FIXTURE_SECRET|PRIVATE_STDERR/);
    await expect(
      native.withT3Session(nativeEnvironment(), ".", runner(body()), async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
  test("falsey callback rejection is still structured failure", async () => {
    const result = await owned(nativeEnvironment(), ".", runner(body()), async () => {
      throw undefined;
    });
    expect(result.use.status).toBe("failed");
    expect(result.failure?.code).toBe("T3_HANDOFF_FAILED");
  });
  test("real owned executable and loopback read enforce direct argv/profile/exact revoke", async () => {
    const root = await mkdtemp(join(tmpdir(), "owned-session-"));
    roots.push(root);
    const cli = join(root, "fake-t3.cjs");
    const ledger = join(root, "ledger.jsonl");
    await writeFile(
      cli,
      `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv.slice(2); const base = ${JSON.stringify(root)}; if (process.env.T3CODE_HOME !== base || process.env.ARASHI_DIRECTIVE_FILE || process.cwd() !== base) process.exit(9); const issue = ['auth','session','issue','--base-dir',base,'--ttl','5m','--label','Arashi readiness','--json']; const revoke = ['auth','session','revoke','owned-session','--base-dir',base]; if (JSON.stringify(a)!==JSON.stringify(issue) && JSON.stringify(a)!==JSON.stringify(revoke)) process.exit(8); fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ operation:a[2], cwdBound:true, profileBound:true })+'\\n'); if (a[2]==='issue') console.log(${JSON.stringify(body())});\n`,
    );
    await chmod(cli, 0o700);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    for (const args of [
      ["auth", "session", "list", "--base-dir", root, "--json"],
      ["auth", "session", "revoke", "unrelated-session", "--base-dir", root],
    ]) {
      await expect(
        promisify(execFile)(cli, args, {
          cwd: root,
          env: native.nativeChildEnvironment({ T3CODE_HOME: root }),
        }),
      ).rejects.toMatchObject({ code: 8 });
    }
    const { createServer } = await import("node:http");
    let reads = 0;
    const server = createServer((request, response) => {
      if (
        request.url !== "/fixture-read" ||
        request.method !== "GET" ||
        request.headers.authorization !== "Bearer FIXTURE_SECRET"
      ) {
        response.writeHead(403).end();
        return;
      }
      reads++;
      response.setHeader("content-type", "application/json");
      response.end('{"observed":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture address");
      const result = await owned(
        { baseDir: root, cli, origin: `http://127.0.0.1:${address.port}` },
        root,
        {},
        async (request) => (await request("/fixture-read")).observed,
      );
      expect(result.use).toEqual({ status: "succeeded", value: true });
      expect(result.cleanup).toEqual({ status: "unknown", revoke: "succeeded" });
      expect(reads).toBe(1);
      expect(
        (await readFile(ledger, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).operation),
      ).toEqual(["issue", "revoke"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
