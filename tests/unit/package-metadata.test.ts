import { describe, expect, test } from "vitest";
import pkg from "../../package.json";

describe("npm package metadata", () => {
  test("does not define a postinstall lifecycle script", () => {
    expect(pkg.scripts).not.toHaveProperty("postinstall");
  });

  test("publishes the npm entrypoint, wrappers, and runtime installer module", () => {
    expect(pkg.bin.arashi).toBe("./bin/arashi.js");
    expect(pkg.files).toContain("bin/arashi");
    expect(pkg.files).toContain("bin/arashi.js");
    expect(pkg.files).toContain("bin/arashi.bat");
    expect(pkg.files).toContain("bin/arashi.ps1");
    expect(pkg.files).toContain("bin/install-binary.js");
    expect(pkg.files).not.toContain("scripts/postinstall.js");
  });
});
