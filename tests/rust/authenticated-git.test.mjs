import assert from "node:assert/strict";
import { test } from "node:test";

const fixture = await import("./authenticated-git.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url?.endsWith("/authenticated-git.mjs")) {
    return {};
  }
  throw error;
});

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
  } finally {
    await server.close();
  }
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(root), false, "private fixture directory must be removed");
});
