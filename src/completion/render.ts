import type { CliCommandContract } from "../contracts/cli-commands.ts";
import type { SupportedShell } from "../lib/shell-integration.ts";
import { createHash } from "node:crypto";

const fingerprint = (contract: CliCommandContract): string =>
  createHash("sha256").update(JSON.stringify(contract)).digest("hex");

export function renderCompletion(shell: SupportedShell, contract: CliCommandContract): string {
  const marker = `# arashi-completion-contract-v6:${fingerprint(contract)}`;
  if (shell === "bash")
    return `${marker}
_arashi() {
  local value description
  COMPREPLY=()
  while IFS= read -r -d '' value && IFS= read -r -d '' description; do
    COMPREPLY+=("$value")
  done < <(command arashi completion __query "$COMP_CWORD" -- "\${COMP_WORDS[@]}")
}
complete -F _arashi arashi
`;
  if (shell === "zsh")
    return `${marker}
if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit
fi
_arashi() {
  local value description
  local -a values descriptions
  while IFS= read -r -d $'\\0' value && IFS= read -r -d $'\\0' description; do
    values+=("$value")
    descriptions+=("$description")
  done < <(command arashi completion __query "$((CURRENT - 1))" -- "\${words[@]}")
  compadd -d descriptions -- "\${values[@]}"
}
compdef _arashi arashi
`;
  return `${marker}
function __arashi_complete
    set -l words (commandline -opc)
    set -l current (commandline -ct)
    set -a words "$current"
    set -l cursor (math (count $words) - 1)
    set -l fields (command arashi completion __query $cursor -- $words | string split0)
    if test (count $fields) -ge 2
        for index in (seq 1 2 (count $fields))
            set -l description_index (math $index + 1)
            printf '%s\\t%s\\n' (string escape -- $fields[$index]) (string escape -- $fields[$description_index])
        end
    end
end
complete -c arashi -f -a '(__arashi_complete)'
`;
}

export function renderAllCompletions(contract: CliCommandContract): Record<SupportedShell, string> {
  return {
    bash: renderCompletion("bash", contract),
    fish: renderCompletion("fish", contract),
    zsh: renderCompletion("zsh", contract),
  };
}
