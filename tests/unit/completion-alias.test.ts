import { describe, expect, test } from "vitest";
import { buildProgram } from "../../src/cli-program.ts";
import { renderAllCompletions } from "../../src/completion/render.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
} from "../../src/contracts/cli-commands.ts";

const contract = generateCommandContract(
  buildProgram({ includeHelpBanner: false }),
  commandSemantics,
  optionAuditPolicies,
);
const completions = renderAllCompletions(contract);

describe("dual-name generated completion", () => {
  test("registers one Bash model for arashi and aw with canonical backend queries", () => {
    expect(completions.bash).toContain("complete -F _arashi arashi aw");
    expect(completions.bash.match(/command arashi completion __query/g)).toHaveLength(1);
    expect(completions.bash).not.toContain("command aw completion __query");
  });

  test("registers one Zsh model for arashi and aw without resetting initialized state", () => {
    expect(completions.zsh).toContain("compdef _arashi arashi aw");
    expect(completions.zsh.match(/command arashi completion __query/g)).toHaveLength(1);
    expect(completions.zsh).not.toContain("command aw completion __query");
  });

  test("registers one Fish model for arashi and aw", () => {
    expect(completions.fish).toContain("complete -c arashi -c aw -f -a '(__arashi_complete)'");
    expect(completions.fish.match(/command arashi completion __query/g)).toHaveLength(1);
    expect(completions.fish).not.toContain("command aw completion __query");
  });

  test.each(["bash", "zsh", "fish"] as const)(
    "accepts aw as the root token in %s without a second candidate model",
    (shell) => {
      expect(completions[shell]).toContain("aw");
      expect(completions[shell]).toContain("_arashi");
      expect(completions[shell]).not.toContain("_aw()");
    },
  );
});
