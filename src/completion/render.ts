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
  local value description quoted
  local cursor="$COMP_CWORD"
  local -a words=("\${COMP_WORDS[@]}")
  while true; do
    if (( cursor >= 1 )) && [[ "\${words[cursor]}" == "=" ]]; then
      local assignment="\${words[cursor - 1]}="
      words=("\${words[@]:0:cursor - 1}" "$assignment" "\${words[@]:cursor + 1}")
      cursor=$((cursor - 1))
    elif (( cursor >= 2 )) && [[ "\${words[cursor - 1]}" == "=" ]]; then
      local assignment="\${words[cursor - 2]}=\${words[cursor]}"
      words=("\${words[@]:0:cursor - 2}" "$assignment" "\${words[@]:cursor + 1}")
      cursor=$((cursor - 2))
    elif (( cursor >= 1 )) && [[ "\${words[cursor]}" == ":" || "\${words[cursor]}" == "@" ]]; then
      local combined_word="\${words[cursor - 1]}\${words[cursor]}"
      words=("\${words[@]:0:cursor - 1}" "$combined_word" "\${words[@]:cursor + 1}")
      cursor=$((cursor - 1))
    elif (( cursor >= 2 )) && [[ "\${words[cursor - 1]}" == ":" || "\${words[cursor - 1]}" == "@" ]]; then
      local combined_word="\${words[cursor - 2]}\${words[cursor - 1]}\${words[cursor]}"
      words=("\${words[@]:0:cursor - 2}" "$combined_word" "\${words[@]:cursor + 1}")
      cursor=$((cursor - 2))
    else
      break
    fi
  done
  local current_word="\${words[cursor]}" dequoted_word="" char
  local index
  for ((index = 0; index < \${#current_word}; index++)); do
    char="\${current_word:index:1}"
    if [[ "$char" == "\\\\" ]] && ((index + 1 < \${#current_word})); then
      index=$((index + 1))
      dequoted_word+="\${current_word:index:1}"
    else
      dequoted_word+="$char"
    fi
  done
  words[cursor]="$dequoted_word"
  COMPREPLY=()
  while IFS= read -r -d '' value && IFS= read -r -d '' description; do
    printf -v quoted '%q' "$value"
    COMPREPLY+=("$quoted")
  done < <(command arashi completion __query "$cursor" -- "\${words[@]}")
}
complete -F _arashi arashi
`;
  if (shell === "zsh")
    return `${marker}
if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit -i
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
            set -l description (string replace -ar '[\\t\\r\\n]' ' ' -- "$fields[$description_index]")
            printf '%s\\t%s\\n' (string escape --no-quoted -- "$fields[$index]") "$description"
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
