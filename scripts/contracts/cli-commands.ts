import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { buildProgram } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
  serializeCommandContract,
} from "../../src/contracts/cli-commands.ts";

const outputPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../contracts/cli-commands.json",
);
const generated = serializeCommandContract(
  generateCommandContract(
    buildProgram({ includeHelpBanner: false }),
    commandSemantics,
    optionAuditPolicies,
  ),
);

if (process.argv.includes("--check")) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== generated) {
    console.error(
      "contracts/cli-commands.json is stale. Run `pnpm run contract:generate` and commit the result.",
    );
    process.exit(1);
  }
  console.log("CLI command contract is current.");
} else {
  writeFileSync(outputPath, generated);
  console.log("Generated contracts/cli-commands.json.");
}
