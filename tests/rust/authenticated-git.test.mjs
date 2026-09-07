import { terminateChild, waitForOutput } from "./child-process.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const fixture = await import("./authenticated-git.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url?.endsWith("/authenticated-git.mjs")) {
    return {};
  }
  throw error;
});

test("acceptance fixture cleanup preserves a primary failure", async () => {
  assert.equal(
    typeof fixture.withAuthenticatedGitFixture,
    "function",
    "authenticated acceptance fixture lifecycle helper is missing",
  );
  const primary = new Error("acceptance assertion failure");
  const cleanup = new Error("acceptance fixture cleanup failure");
  const server = {
    close() {
      throw cleanup;
    },
  };

  await assert.rejects(
    fixture.withAuthenticatedGitFixture(
      () => server,
      () => {
        throw primary;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    },
  );
});

test("acceptance fixture cleanup-only failure still fails", async () => {
  const cleanup = new Error("acceptance fixture cleanup failure");
  await assert.rejects(
    fixture.withAuthenticatedGitFixture(
      () => ({
        close() {
          throw cleanup;
        },
      }),
      () => "complete",
    ),
    (error) => error === cleanup,
  );
});

test("cleanup failure does not replace a primary fixture failure", async () => {
  const primary = new Error("primary readiness failure");
  const cleanup = new Error("fixture cleanup failure");

  await assert.rejects(
    fixture.withCleanup(
      () => {
        throw primary;
      },
      () => {
        throw cleanup;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    },
  );
});

test("cleanup-only failure still fails the fixture operation", async () => {
  const cleanup = new Error("fixture cleanup failure");
  await assert.rejects(
    fixture.withCleanup(
      () => "ready",
      () => {
        throw cleanup;
      },
    ),
    (error) => error === cleanup,
  );
});

test("holder termination and root removal cleanup failures are both surfaced", async () => {
  const primary = new Error("fixture operation failure");
  const termination = new Error("holder termination failure");
  const removal = new Error("fixture root removal failure");

  await assert.rejects(
    fixture.withCleanup(
      () => {
        throw primary;
      },
      () =>
        fixture.withCleanup(
          () => {
            throw termination;
          },
          () => {
            throw removal;
          },
        ),
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      const [reportedPrimary, cleanup] = error.errors;
      assert.equal(reportedPrimary, primary);
      assert.ok(cleanup instanceof AggregateError);
      assert.equal(cleanup.cause, termination);
      assert.deepEqual(cleanup.errors, [termination, removal]);
      return true;
    },
  );
});

test(
  "fixture cleanup waits out a transient Windows ownership lock",
  { skip: process.platform !== "win32" },
  async () => {
    assert.equal(typeof fixture.removeFixtureRoot, "function", "fixture cleanup helper is missing");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { spawn } = await import("node:child_process");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arashi-auth-cleanup-"));
    const locked = path.join(root, "locked");
    fs.writeFileSync(locked, "owned fixture data");
    const holder = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "$stream = [IO.File]::Open($env:ARASHI_LOCK_FILE, 'Open', 'ReadWrite', 'None'); " +
          "[Console]::Out.WriteLine('LOCKED'); Start-Sleep -Milliseconds 300; $stream.Dispose()",
      ],
      {
        env: { ...process.env, ARASHI_LOCK_FILE: locked },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    await fixture.withCleanup(
      async () => {
        assert.match(await waitForOutput(holder, "LOCKED", 5000), /LOCKED/);
        await fixture.removeFixtureRoot(root);
        assert.equal(fs.existsSync(root), false);
      },
      () =>
        fixture.withCleanup(
          () => terminateChild(holder, 2000),
          () => {
            fs.rmSync(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
          },
        ),
    );
  },
);

test("real authenticated HTTPS and SSH clone/fetch/push with denial controls", async () => {
  assert.equal(
    typeof fixture.startAuthenticatedGit,
    "function",
    "authenticated transport fixture is missing",
  );
  const server = await fixture.startAuthenticatedGit();
  const { root } = server;
  try {
    for (const transport of ["https", "ssh"]) {
      const url = server.urls[transport];
      const initial = await server.commit("seed", "initial");
      await server.git("seed", ["push", server.remote, "HEAD:main"]);
      for (const mode of ["wrong-credential", "wrong-trust"]) {
        const before = server.events.length;
        const denied = await server.run("git", ["ls-remote", url], {
          allowFailure: true,
          mode,
          transport,
        });
        assert.notEqual(denied.code, 0, `${transport} ${mode} must reject`);
        const causes = {
          https: {
            "wrong-credential": /authentication failed|401/i,
            "wrong-trust": /certificate|SSL/i,
          },
          ssh: {
            "wrong-credential": /permission denied/i,
            "wrong-trust": /host key verification failed/i,
          },
        };
        const cause = causes[transport][mode];
        assert.match(denied.stderr, cause);
        assert.equal(
          server.events.slice(before).filter((event) => event.kind === "backend").length,
          0,
        );
      }
      const checkout = `${transport}-checkout`;
      await server.git(".", ["clone", url, checkout], { transport });
      assert.equal(await server.git(checkout, ["rev-parse", "HEAD"]), initial);
      assert.equal(await server.git(checkout, ["remote", "get-url", "origin"]), url);
      const incoming = await server.commit("seed", "incoming");
      await server.git("seed", ["push", server.remote, "HEAD:main"]);
      await server.git(checkout, ["fetch", "origin"], { transport });
      assert.equal(await server.git(checkout, ["rev-parse", "origin/main"]), incoming);
      await server.git(checkout, ["merge", "--ff-only", "origin/main"]);
      const outgoing = await server.commit(checkout, "outgoing");
      const denied = await server.run("git", ["push", "origin", "HEAD:main"], {
        allowFailure: true,
        cwd: checkout,
        mode: "wrong-credential",
        transport,
      });
      assert.notEqual(denied.code, 0);
      assert.equal(await server.git(server.remote, ["rev-parse", "main"]), incoming);
      await server.git(checkout, ["push", "origin", "HEAD:main"], { transport });
      assert.equal(await server.git(server.remote, ["rev-parse", "main"]), outgoing);
      await server.git("seed", ["fetch", server.remote, "main"]);
      await server.git("seed", ["reset", "--hard", "FETCH_HEAD"]);
      assert.ok(
        server.events.some((event) => event.transport === transport && event.kind === "denied"),
      );
      for (const service of ["upload-pack", "receive-pack"]) {
        assert.ok(
          server.events.some(
            (event) =>
              event.transport === transport && event.service === service && event.bytes > 0,
          ),
        );
      }
    }
    assert.ok(
      server.events.some((event) => event.protocol === "TLSv1.3" || event.protocol === "TLSv1.2"),
    );
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      assert.equal(statSync(root).mode & 0o777, 0o700);
    }
    await server.assertNoSecretOutput();
  } catch (error) {
    return fixture.withCleanup(
      () => {
        throw error;
      },
      () => server.close(),
    );
  }
  await server.close();
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(root), false, "private fixture directory must be removed");
});
