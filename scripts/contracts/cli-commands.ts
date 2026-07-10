import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { buildProgram } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  serializeCommandContract,
} from "../../src/contracts/cli-commands.ts";

const outputPath = resolve(import.meta.dir, "../../contracts/cli-commands.json");
const generated = serializeCommandContract(
  generateCommandContract(buildProgram({ includeHelpBanner: false }), commandSemantics),
);

if (process.argv.includes("--check")) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== generated) {
    console.error(
      "contracts/cli-commands.json is stale. Run `bun run contract:generate` and commit the result.",
    );
    process.exit(1);
  }
  console.log("CLI command contract is current.");
} else {
  writeFileSync(outputPath, generated);
  console.log("Generated contracts/cli-commands.json.");
}
