import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";
import { executableDistributionPolicy } from "../../src/contracts/executable-distribution.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outputPath = join(root, "contracts", "executable-distribution.json");
const unformatted = `${JSON.stringify(executableDistributionPolicy, null, 2)}\n`;
const { code: expected, errors } = await format(outputPath, unformatted, {
  printWidth: 100,
  tabWidth: 2,
});
if (errors.length > 0) {
  throw new Error(
    `Unable to format executable distribution contract: ${errors.map((error) => error.message).join(", ")}`,
  );
}

if (process.argv.includes("--check")) {
  let actual = "";
  try {
    actual = readFileSync(outputPath, "utf8");
  } catch {
    // A missing generated contract is stale.
  }
  if (actual !== expected) {
    console.error(
      "Executable distribution contract is stale. Run pnpm executable-contract:generate.",
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, expected);
}
