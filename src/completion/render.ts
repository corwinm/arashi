import type { CliCommandContract, ContractCommand } from "../contracts/cli-commands.ts";
import type { SupportedCompletionShell } from "../lib/shell-integration.ts";
import { createHash } from "node:crypto";

const fingerprint = (contract: CliCommandContract): string =>
  createHash("sha256").update(JSON.stringify(contract)).digest("hex");

// Compile the contract once, at generation time. The emitted parser uses only
// shell builtins; it never loads the CLI to discover static completion metadata.
function renderLocalDispatch(
  shell: SupportedCompletionShell,
  contract: CliCommandContract,
): string {
  // A small shell syntax backend keeps ownership and parsing identical across
  // targets, including Bash 3.2 (only indexed arrays and builtin operations).
  const fish = shell === "fish";
  const ps = shell === "powershell";
  const zsh = shell === "zsh";
  const quote = (text: string): string =>
    ps
      ? `'${text.replaceAll("'", "''")}'`
      : fish
        ? `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
        : `'${text.replaceAll("'", `'"'"'`)}'`;
  const ref = (name: string) => (ps ? `$${name}` : `"$${name}"`);
  const literal = (text: string | number) => quote(String(text));
  const set = (name: string, value: string) =>
    ps ? `$${name} = ${value}\n` : fish ? `set ${name} ${value}\n` : `${name}=${value}\n`;
  const eq = (left: string, right: string) =>
    ps ? `${left} -ceq ${right}` : fish ? `test ${left} = ${right}` : `[[ ${left} == ${right} ]]`;
  const num = (left: string, op: string, right: string) =>
    ps
      ? `[int]${left} -${op} [int]${right}`
      : fish
        ? `test ${left} -${op} ${right}`
        : `[[ ${left} -${op} ${right} ]]`;
  const starts = (name: string, prefix: string) =>
    ps
      ? `${ref(name)}.StartsWith(${literal(prefix)})`
      : fish
        ? `string match -q -- ${literal(prefix + "*")} ${ref(name)}`
        : `[[ ${ref(name)} == ${literal(prefix)}* ]]`;
  const contains = (name: string, text: string) =>
    ps
      ? `${ref(name)}.Contains(${literal(text)})`
      : fish
        ? `string match -q -- ${literal("*" + text + "*")} ${ref(name)}`
        : `[[ ${ref(name)} == *${literal(text)}* ]]`;
  const when = (condition: string, body: string, otherwise = "") =>
    ps
      ? `if (${condition}) {\n${body}}${otherwise ? ` else {\n${otherwise}}` : ""}\n`
      : fish
        ? `if ${condition}\n${body}${otherwise ? `else\n${otherwise}` : ""}end\n`
        : `if ${condition}; then\n${body || ":\n"}${otherwise ? `else\n${otherwise}` : ""}fi\n`;
  const loop = (condition: string, body: string) =>
    ps
      ? `while (${condition}) {\n${body}}\n`
      : fish
        ? `while ${condition}\n${body}end\n`
        : `while ${condition}; do\n${body}done\n`;
  const cases = (value: string, branches: Array<[string[], string]>) =>
    ps
      ? `switch -CaseSensitive (${value}) {\n${branches.flatMap(([keys, body]) => keys.map((key) => `${literal(key)} {\n${body}}\n`)).join("")}}\n`
      : fish
        ? `switch ${value}\n${branches.map(([keys, body]) => `case ${keys.map(literal).join(" ")}\n${body}`).join("")}end\n`
        : `case ${value} in\n${branches.map(([keys, body]) => `${keys.map(literal).join("|")})\n${body};;\n`).join("")}esac\n`;
  const increment = (name: string) =>
    set(name, ps ? `([int]$${name} + 1)` : fish ? `(math $${name} + 1)` : `$(( ${name} + 1 ))`);
  const word = ps ? "$words[$i]" : fish ? '"$words[$i]"' : '"${words[i]}"';
  const split = (name: string, part: "name" | "value") =>
    ps
      ? `$${name}.Split('=', 2)[${part === "name" ? 0 : 1}]`
      : fish
        ? `(string split -m 1 = -- "$${name}")[${part === "name" ? 1 : 2}]`
        : `"\${${name}${part === "name" ? "%%=*" : "#*="}}"`;
  const emit = (value: string, description: string) => {
    const match = ps
      ? "$value.StartsWith($current, [StringComparison]::OrdinalIgnoreCase)"
      : fish
        ? 'string match -rqi -- \'^\'(string escape --style=regex -- "$current") "$value"'
        : zsh
          ? '[[ "${(L)value}" == "${(L)current}"* ]]'
          : '[[ "$value" == "$current"* ]]';
    return (
      set("value", value) +
      when(
        match,
        ps
          ? `$records += $assignment + $value + [char]0 + ${description} + [char]0\n`
          : `printf '%s\\0%s\\0' "$assignment$value" ${description}\n`,
      )
    );
  };
  const commands: Array<
    Pick<ContractCommand, "path" | "aliases" | "aliasPaths" | "hidden" | "arguments" | "options">
  > = [
    {
      path: "",
      aliases: [],
      aliasPaths: [],
      hidden: false,
      arguments: [],
      options: contract.root.options,
    },
    ...contract.commands,
  ];
  const dynamicKinds = new Set([
    "repository",
    "configured-repository",
    "group",
    "workspace",
    "worktree",
  ]);
  const owners: Array<[string[], string]> = [];
  const owner = (
    id: string,
    slot: { hidden: boolean; choices?: string[]; candidateKind?: string; description: string },
  ) => {
    owners.push([
      [id],
      slot.hidden
        ? "return\n"
        : slot.choices?.length
          ? slot.choices
              .toSorted()
              .map((choice) => emit(literal(choice), literal(slot.description)))
              .join("") + (ps ? "return $records\n" : "return\n")
          : dynamicKinds.has(slot.candidateKind ?? "")
            ? set("dynamic", literal(1))
            : "return\n",
    ]);
    return id;
  };
  const transitions: Array<[string[], string]> = [];
  commands.forEach((command, id) => {
    if (!id) return;
    const paths = new Set([command.path, ...command.aliasPaths]);
    const parent = command.path.split(" ").slice(0, -1).join(" ");
    for (const alias of command.aliases) paths.add(parent ? `${parent} ${alias}` : alias);
    const keys = [...paths].flatMap((path) => {
      const pieces = path.split(" ");
      const name = pieces.pop()!;
      const parentPath = pieces.join(" ");
      return commands.flatMap((candidate, parentId) =>
        candidate.path === parentPath || candidate.aliasPaths.includes(parentPath)
          ? [`${parentId}:${name}`]
          : [],
      );
    });
    if (keys.length)
      transitions.push([
        [...new Set(keys)],
        command.hidden ? "return\n" : set("next", literal(id)),
      ]);
  });
  const options: Array<[string[], string]> = [];
  const arguments_: Array<[string[], string]> = [];
  const boundaries: Array<[string[], string]> = [];
  const suggestions: Array<[string[], string]> = [];
  commands.forEach((command, commandId) => {
    let candidates = "";
    for (const child of contract.commands.filter(
      (child) => !child.hidden && child.path.split(" ").slice(0, -1).join(" ") === command.path,
    )) {
      for (const name of [child.path.split(" ").at(-1)!, ...child.aliases])
        candidates += emit(literal(name), literal(child.description));
    }
    let optionCandidates = "";
    command.options.forEach((option, index) => {
      const id = `o${commandId}_${index}`;
      const spellings = [option.short, option.long].filter((s): s is string => Boolean(s));
      owner(id, { ...option, description: `Value for ${option.long}` });
      options.push([
        spellings.map((spelling) => `${commandId}:${spelling}`),
        set("option", literal(id)) + set("takes", literal(option.valueShape === "boolean" ? 0 : 1)),
      ]);
      if (option.hidden) return;
      const blocked = command.options.flatMap((other, otherIndex) => {
        const otherSpellings = [other.long, other.short];
        return (index === otherIndex && !option.repeatable && !option.semanticPolicy?.selector) ||
          option.conflicts.some((conflict) => otherSpellings.includes(conflict)) ||
          other.conflicts.some((conflict) => spellings.includes(conflict))
          ? [`o${commandId}_${otherIndex}`]
          : [];
      });
      let body = spellings
        .map((spelling) => emit(literal(spelling), literal(option.description)))
        .join("");
      for (const block of blocked) body = when(contains("used", `|${block}|`), "", body);
      optionCandidates += body;
    });
    suggestions.push([
      [String(commandId)],
      candidates + when(eq(ref("ended"), literal(0)), optionCandidates),
    ]);
    let argumentBody = "";
    command.arguments.forEach((argument, index) => {
      const id = owner(`a${commandId}_${index}`, argument);
      argumentBody += when(
        num(ref("position"), argument.variadic ? "ge" : "eq", literal(index)),
        set("owner", literal(id)),
      );
    });
    const variadic = command.arguments.findIndex((argument) => argument.variadic);
    if (variadic >= 0)
      boundaries.push([
        [String(commandId)],
        when(num(ref("position"), "gt", literal(variadic)), "return\n"),
      ]);
    // Finite dynamic positionals must not fall back to option suggestions at
    // an empty, exhausted slot. Explicit option values still take precedence.
    if (
      dynamicKinds.has(command.arguments.at(-1)?.candidateKind ?? "") &&
      !command.arguments.at(-1)?.variadic
    )
      argumentBody += when(
        num(ref("position"), "ge", literal(command.arguments.length)),
        set("exhausted", literal(1)),
      );
    arguments_.push([[String(commandId)], argumentBody]);
  });
  const lookup = () =>
    set("option", literal("")) +
    set("takes", literal(0)) +
    set("key", ps ? '$cmd + ":" + $spelling' : '"$cmd:$spelling"') +
    cases(ref("key"), options);
  let body =
    set("cmd", literal(0)) +
    set("position", literal(0)) +
    set("ended", literal(0)) +
    set("used", literal("|")) +
    set("pending", literal("")) +
    set("assignment", literal("")) +
    set("owner", literal("")) +
    set("dynamic", literal(0)) +
    set("exhausted", literal(0)) +
    set("i", literal(ps ? 1 : zsh || fish ? 2 : 1));
  const end = zsh || fish ? ref("limit") : ref("cursor");
  // Resolve command paths first; consumed aliases transition to canonical IDs.
  body += loop(
    num(ref("i"), "lt", end),
    set("token", word) +
      set("next", literal("")) +
      set("key", ps ? '$cmd + ":" + $token' : '"$cmd:$token"') +
      cases(
        ref("key"),
        transitions.filter(([keys]) => keys.length),
      ) +
      when(eq(ref("next"), literal("")), "break\n") +
      set("cmd", ref("next")) +
      increment("i"),
  );
  // Consume option values before counting positionals or recognizing `--`.
  body += loop(
    num(ref("i"), "lt", end),
    cases(ref("cmd"), boundaries) +
      set("token", word) +
      increment("i") +
      when(eq(ref("pending"), literal("")), "", set("pending", literal("")) + "continue\n") +
      when(
        eq(ref("ended"), literal(0)),
        when(eq(ref("token"), literal("--")), set("ended", literal(1)) + "continue\n"),
      ) +
      when(
        eq(ref("ended"), literal(0)),
        when(
          starts("token", "-"),
          set("spelling", split("token", "name")) +
            lookup() +
            set("used", ps ? '$used + $option + "|"' : '"$used$option|"') +
            when(
              eq(ref("takes"), literal(1)),
              when(contains("token", "="), "", set("pending", ref("option"))),
            ) +
            "continue\n",
        ),
      ) +
      increment("position"),
  );
  body += set(
    "current",
    ps
      ? "$words[$cursor]"
      : fish
        ? '"$words[$limit]"'
        : zsh
          ? '"${words[limit]}"'
          : '"${words[cursor]}"',
  );
  // The current slot owns completion: inline/separate options override the
  // positional owner, but a consumed variadic argument ends our dispatch.
  body += cases(ref("cmd"), boundaries);
  body += cases(ref("cmd"), arguments_);
  body += when(eq(ref("pending"), literal("")), "", set("owner", ref("pending")));
  body += when(
    eq(ref("ended"), literal(0)),
    when(
      starts("current", "-"),
      when(eq(ref("pending"), literal("")), set("owner", literal(""))) +
        when(
          contains("current", "="),
          set("spelling", split("current", "name")) +
            lookup() +
            when(
              eq(ref("takes"), literal(1)),
              set("owner", ref("option")) +
                set("assignment", ps ? '$spelling + "="' : '"$spelling="') +
                set("current", split("current", "value")),
            ),
        ),
    ),
  );
  if (shell === "bash") body += "shopt -s nocasematch\n";
  body += cases(ref("owner"), owners);
  body += when(
    eq(ref("dynamic"), literal(1)),
    (ps
      ? "& arashi completion __query $cursor -- @words\n"
      : fish
        ? "command arashi completion __query $cursor -- $words\n"
        : 'command arashi completion __query "$cursor" -- "${words[@]}"\n') + "return\n",
  );
  body += when(eq(ref("exhausted"), literal(1)), when(starts("current", "-"), "", "return\n"));
  body += cases(ref("cmd"), suggestions);
  if (ps) body += "return $records\n";
  const names =
    "cmd position ended used pending assignment owner dynamic exhausted i token next key option takes spelling current value";
  const header = ps
    ? 'function __arashi_records {\nparam($cursor, $words)\n$records = ""\n'
    : fish
      ? `function __arashi_records\nset -l cursor $argv[1]\nset -l words $argv[2..-1]\nset -l limit (math $cursor + 1)\n${names
          .split(" ")
          .map((name) => `set -l ${name}\n`)
          .join("")}`
      : `_arashi_records() {\n${zsh ? "setopt localoptions no_ksharrays\n" : "shopt -u nocasematch\n"}local cursor="$1"\nshift\nlocal -a words=("$@")\nlocal ${names}${zsh ? " limit=$((cursor + 1))" : ""}\n`;
  return header + body + (fish ? "end\n" : "}\n");
}

export function renderCompletion(
  shell: SupportedCompletionShell,
  contract: CliCommandContract,
): string {
  const localDispatch = renderLocalDispatch(shell, contract);
  const marker = `# arashi-completion-contract-v7:${fingerprint(contract)}`;
  if (shell === "bash")
    return `${marker}
${localDispatch}_arashi() {
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
  local current_word="\${words[cursor]}" dequoted_word="" char next_char quote_state=""
  local index
  for ((index = 0; index < \${#current_word}; index++)); do
    char="\${current_word:index:1}"
    if [[ "$quote_state" == "single" ]]; then
      if [[ "$char" == "'" ]]; then
        quote_state=""
      else
        dequoted_word+="$char"
      fi
    elif [[ "$quote_state" == "double" ]]; then
      if [[ "$char" == '"' ]]; then
        quote_state=""
      elif [[ "$char" == "\\\\" ]] && ((index + 1 < \${#current_word})); then
        next_char="\${current_word:index+1:1}"
        if [[ "$next_char" == '$' || "$next_char" == '"' || "$next_char" == "\\\\" || "$next_char" == $'\\x60' ]]; then
          index=$((index + 1))
          dequoted_word+="$next_char"
        elif [[ "$next_char" == $'\\n' ]]; then
          index=$((index + 1))
        else
          dequoted_word+="$char"
        fi
      else
        dequoted_word+="$char"
      fi
    elif [[ "$char" == "'" ]]; then
      quote_state="single"
    elif [[ "$char" == '"' ]]; then
      quote_state="double"
    elif [[ "$char" == "\\\\" ]] && ((index + 1 < \${#current_word})); then
      index=$((index + 1))
      next_char="\${current_word:index:1}"
      if [[ "$next_char" != $'\\n' ]]; then
        dequoted_word+="$next_char"
      fi
    else
      dequoted_word+="$char"
    fi
  done
  words[cursor]="$dequoted_word"
  COMPREPLY=()
  while IFS= read -r -d '' value && IFS= read -r -d '' description; do
    printf -v quoted '%q' "$value"
    COMPREPLY+=("$quoted")
  done < <(_arashi_records "$cursor" "\${words[@]}")
}
complete -F _arashi arashi
if ! alias aw >/dev/null 2>&1 && { ! declare -F aw >/dev/null 2>&1 || declare -f aw | grep -Fq 'arashi-managed-shell-wrapper:aw:v1'; }; then
  complete -F _arashi aw
fi
`;
  if (shell === "zsh")
    return `${marker}
${localDispatch}if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit -i
fi
_arashi() {
  local value description display
  local -a values displays
  while IFS= read -r -d $'\\0' value && IFS= read -r -d $'\\0' description; do
    values+=("$value")
    display="$value"
    [[ -n "$description" ]] && display+=" -- $description"
    displays+=("$display")
  done < <(_arashi_records "$((CURRENT - 1))" "\${words[@]}")
  compadd -d displays -- "\${values[@]}"
}
compdef _arashi arashi
if (( ! \${+aliases[aw]} )); then
  if (( ! \${+functions[aw]} )) || [[ "\${functions[aw]}" == *'arashi-managed-shell-wrapper:aw:v1'* ]]; then
    compdef _arashi aw
  fi
fi
`;
  if (shell === "powershell")
    return `${marker}
${localDispatch}Register-ArgumentCompleter -Native -CommandName arashi, aw -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  if ($words.Count -eq 0) { $words = @('arashi') }
  $lastElementEnd = $commandAst.CommandElements[-1].Extent.EndOffset
  if ($cursorPosition -gt $lastElementEnd) { $words += $wordToComplete }
  $cursor = $words.Count - 1
  $fields = ((__arashi_records $cursor $words) -join "\n") -split [char]0
  for ($index = 0; $index + 1 -lt $fields.Count; $index += 2) {
    $value = $fields[$index]
    $description = $fields[$index + 1]
    if ($value -like "$wordToComplete*") {
      $completionText = "'" + $value.Replace("'", "''") + "'"
      [System.Management.Automation.CompletionResult]::new($completionText, $value, 'ParameterValue', $description)
    }
  }
}
`;
  return `${marker}
${localDispatch}function __arashi_complete
    set -l words (commandline -opc)
    set -l current (commandline -ct)
    set -a words "$current"
    set -l cursor (math (count $words) - 1)
    set -l fields (__arashi_records $cursor $words | string split0)
    if test (count $fields) -ge 2
        set -l index 1
        while test $index -lt (count $fields)
            set -l description_index (math $index + 1)
            set -l description (string replace -ar '[\\t\\r\\n]' ' ' -- "$fields[$description_index]")
            printf '%s\\t%s\\n' (string escape --no-quoted -- "$fields[$index]") "$description"
            set index (math $index + 2)
        end
    end
end
complete -c arashi -f -a '(__arashi_complete)'
if not functions -q aw; or functions aw | string match -q '*arashi-managed-shell-wrapper:aw:v1*'
    complete -c aw -f -a '(__arashi_complete)'
end
`;
}

export function renderAllCompletions(
  contract: CliCommandContract,
): Record<SupportedCompletionShell, string> {
  return {
    bash: renderCompletion("bash", contract),
    fish: renderCompletion("fish", contract),
    powershell: renderCompletion("powershell", contract),
    zsh: renderCompletion("zsh", contract),
  };
}
