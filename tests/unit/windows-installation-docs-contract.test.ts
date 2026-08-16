import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const root = join(import.meta.dirname, "../..");
const documents = ["README.md", "docs/INSTALLATION.md"] as const;

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe.each(documents)("%s Windows installation guidance", (document) => {
  const content = read(document);

  test("keeps PowerShell canonical and documents Git Bash support", () => {
    expect(content).toContain('powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"');
    expect(content).toContain("Git Bash");
    expect(content).toContain("arashi.bin.exe");
  });

  test("documents the verified same-release seven-file manual payload", () => {
    for (const file of [
      "arashi-windows-x64.exe",
      "arashi",
      "arashi.ps1",
      "arashi.bat",
      "aw",
      "aw.ps1",
      "aw.bat",
    ]) {
      expect(content).toContain(`\`${file}\``);
    }
    expect(content).toContain("same release");
    expect(content).toContain("arashi-checksums.txt");
    expect(content).toMatch(/move or remove.*manual.*alias|manual.*alias.*move or remove/is);
  });

  test("documents persistent user PATH inheritance without profile mutation", () => {
    expect(content).toMatch(/persistent user PATH/i);
    expect(content).toMatch(/new Git Bash (window|session)/i);
    expect(content).toMatch(/does not (create|modify|edit).*(`\.bashrc`|shell profile)/i);
  });
});

test("Windows installer docs identify the policy-independent smoke targets exactly", () => {
  const content = read("docs/INSTALLATION.md");
  expect(content).toMatch(/native.*CMD.*`arashi\.bat`.*`aw\.bat`/i);
  expect(content).not.toMatch(/canonical PowerShell-wrapper.*alias PowerShell-wrapper/i);
});
