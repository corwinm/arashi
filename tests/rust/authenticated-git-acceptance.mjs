// Explicit source/native acceptance, never a production runtime fallback.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { startAuthenticatedGit } from "./authenticated-git.mjs";

const [mode, binary] = process.argv.slice(2);
assert.ok(["source", "native"].includes(mode));
if (mode === "native") {
  assert.ok(binary && path.isAbsolute(binary));
}
const source = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const results = [];
for (const transport of ["https", "ssh"]) {
  const fixture = await startAuthenticatedGit();
  try {
    const url = fixture.urls[transport];
    const initial = await fixture.commit("seed", "initial");
    await fixture.git("seed", ["push", fixture.remote, "HEAD:main"]);
    await fixture.git(".", ["init", "--initial-branch=main", "workspace"]);
    const workspace = path.join(fixture.root, "workspace");
    fs.mkdirSync(path.join(workspace, ".arashi"));
    fs.mkdirSync(path.join(workspace, "repos"));
    fs.writeFileSync(
      path.join(workspace, ".arashi/config.json"),
      JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(workspace, ".gitignore"), "repos/\n.arashi/worktrees/\n");
    await fixture.git("workspace", ["add", "."]);
    await fixture.git("workspace", ["commit", "-m", "workspace"]);
    const cli = async (args, authentication = "valid", success = true) => {
      const result = await fixture.run(
        mode === "source" ? process.execPath : binary,
        mode === "source" ? [source, ...args] : args,
        { allowFailure: true, cwd: "workspace", mode: authentication, transport },
      );
      assert.equal(
        result.code === 0,
        success,
        `${mode} ${transport} ${args[0]} unexpected exit ${result.code}`,
      );
      if (success) {
        const document = JSON.parse(result.stdout);
        assert.equal(document.ok, true);
        return document;
      }
    };
    const configPath = path.join(workspace, ".arashi/config.json");
    const pristine = fs.readFileSync(configPath);
    await cli(["add", url, "--name", "child", "--json", "--force"], "wrong-credential", false);
    assert.deepEqual(fs.readFileSync(configPath), pristine);
    assert.equal(fs.existsSync(path.join(workspace, "repos/child")), false);
    await cli(["add", url, "--name", "child", "--json", "--force"]);
    const checkout = "workspace/repos/child";
    assert.equal(await fixture.git(checkout, ["rev-parse", "HEAD"]), initial);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).repos.child.gitUrl, url);
    fs.rmSync(path.join(fixture.root, checkout), { recursive: true });
    await cli(["clone", "--all", "--json"]);
    assert.equal(await fixture.git(checkout, ["rev-parse", "HEAD"]), initial);
    const persisted = fs.readFileSync(configPath);
    // Commit add's config so pull's cleanliness preflight is meaningful.
    await fixture.git("workspace", ["add", ".arashi/config.json"]);
    await fixture.git("workspace", ["commit", "-m", "register child"]);
    const incoming = await fixture.commit("seed", "incoming");
    await fixture.git("seed", ["push", fixture.remote, "HEAD:main"]);
    await cli(["pull", "--only", "child", "--json"]);
    assert.equal(await fixture.git(checkout, ["rev-parse", "HEAD"]), incoming);
    const outgoing = await fixture.commit(checkout, "outgoing");
    await cli(["push", "--only", "child", "--dry-run", "--json"]);
    assert.equal(await fixture.git(fixture.remote, ["rev-parse", "main"]), incoming);
    await cli(["push", "--only", "child", "--json"]);
    assert.equal(await fixture.git(fixture.remote, ["rev-parse", "main"]), outgoing);
    assert.equal(await fixture.git(checkout, ["remote", "get-url", "origin"]), url);
    assert.deepEqual(fs.readFileSync(configPath), persisted);
    await fixture.assertNoSecretOutput();
    results.push({
      backends: fixture.events.filter((event) => event.kind === "backend"),
      incoming,
      initial,
      mode,
      outgoing,
      transport,
    });
  } finally {
    await fixture.close();
  }
}
console.log(JSON.stringify(results));
