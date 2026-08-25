#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${ARASHI_INSTALL_DIR:-}"
HOME_DIR="${HOME:-}"
DRY_RUN=false
YES=false
PARENT_PID=""
TEMPORARY_SELF=false

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: uninstall.sh [--install-dir <path>] [--home-dir <path>] [--dry-run|-n] [--yes|-y] [--parent-pid <pid>]'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) shift; [ "$#" -gt 0 ] || fail "Missing --install-dir value"; INSTALL_DIR="$1" ;;
    --home-dir) shift; [ "$#" -gt 0 ] || fail "Missing --home-dir value"; HOME_DIR="$1" ;;
    --dry-run|-n) DRY_RUN=true ;;
    --yes|-y) YES=true ;;
    --parent-pid) shift; [ "$#" -gt 0 ] || fail "Missing --parent-pid value"; PARENT_PID="$1" ;;
    --temporary-self) TEMPORARY_SELF=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

if [ -z "$INSTALL_DIR" ]; then
  [ -n "$HOME_DIR" ] || fail "HOME is required when --install-dir is omitted"
  INSTALL_DIR="$HOME_DIR/.arashi/bin"
fi
if [ -n "$HOME_DIR" ]; then
  case "$HOME_DIR" in /*) ;; *) fail "--home-dir must be an absolute path" ;; esac
fi

cleanup_self() {
  if [ "$TEMPORARY_SELF" = true ]; then
    self_path="${BASH_SOURCE[0]}"
    self_dir="$(dirname "$self_path")"
    case "$(basename "$self_dir"):$(basename "$self_path")" in
      arashi-uninstall-*:uninstall.sh)
        rm -f -- "$self_path"
        rmdir "$self_dir" 2>/dev/null || true
        ;;
    esac
  fi
}
trap cleanup_self EXIT

case "$PARENT_PID" in
  "") ;;
  *[!0-9]*) fail "Invalid parent PID" ;;
  *)
    waited=0
    while kill -0 "$PARENT_PID" 2>/dev/null; do
      [ "$waited" -lt 120 ] || fail "Timed out waiting for parent process $PARENT_PID"
      sleep 1
      waited=$((waited + 1))
    done
    ;;
esac

normalize_absolute_path() {
  local input="$1" part output="" index
  local parts=() normalized=()
  case "$input" in /*) ;; *) input="$(pwd)/$input" ;; esac
  IFS='/' read -r -a parts <<< "$input"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|.) ;;
      ..) if [ "${#normalized[@]}" -gt 0 ]; then index=$((${#normalized[@]} - 1)); unset "normalized[$index]"; fi ;;
      *) normalized+=("$part") ;;
    esac
  done
  for index in "${!normalized[@]}"; do output="$output/${normalized[$index]}"; done
  printf '%s\n' "${output:-/}"
}

INSTALL_DIR="$(normalize_absolute_path "$INSTALL_DIR")"
[ ! -L "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR" ] || fail "install directory is not a regular non-link directory"
MANIFEST_PATH="$INSTALL_DIR/.arashi-managed-entrypoints.json"
[ ! -L "$MANIFEST_PATH" ] && [ -f "$MANIFEST_PATH" ] && [ -r "$MANIFEST_PATH" ] || fail "ownership manifest is not a regular non-link file"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else fail "No SHA-256 tool found (tried shasum, sha256sum, and openssl)"
  fi
}

decode_hex() {
  LC_ALL=C awk -v value="$1" 'function d(c){return index("0123456789abcdef",c)-1} BEGIN{for(i=1;i<=length(value);i+=2)printf "%c",d(substr(value,i,1))*16+d(substr(value,i+1,1))}'
}

parse_manifest() {
  LC_ALL=C awk '
  function bad(message) { print "error: " message > "/dev/stderr"; exit 2 }
  function ws() { while (p <= n && substr(s,p,1) ~ /[ \t\r\n]/) p++ }
  function take(c) { ws(); if (substr(s,p,1) != c) bad("malformed ownership manifest"); p++ }
  function string(    out,c,e) {
    ws(); if (substr(s,p,1) != "\"") bad("expected manifest string"); p++; out=""
    while (p <= n) {
      c=substr(s,p++,1)
      if (c == "\"") return out
      if (c == "\\") {
        if (p > n) bad("malformed string escape"); e=substr(s,p++,1)
        if (e == "\"" || e == "\\" || e == "/") c=e
        else if (e == "b") c=sprintf("%c",8)
        else if (e == "f") c=sprintf("%c",12)
        else if (e == "n") c="\n"
        else if (e == "r") c="\r"
        else if (e == "t") c="\t"
        else bad("unsupported manifest string escape")
      } else if (c ~ /[\001-\037]/) bad("control byte in manifest string")
      out=out c
    }
    bad("unterminated manifest string")
  }
  function hex(value,    i,c,out) { out=""; for(i=1;i<=length(value);i++){c=substr(value,i,1); out=out sprintf("%02x",ord[c])} return out }
  function scalar_number(    start) { ws(); start=p; while(substr(s,p,1) ~ /[0-9]/)p++; if(start==p)bad("expected manifest number"); return substr(s,start,p-start) }
  function file_record(idx,    key,path,role,digest,count) {
    take("{"); count=0; delete file_seen
    while (1) {
      ws(); if (substr(s,p,1)=="}"){p++;break}
      if(count++)take(","); key=string(); if(file_seen[key]++)bad("duplicate payload property"); take(":")
      if(key=="relativePath")path=string(); else if(key=="role")role=string(); else if(key=="digest")digest=string(); else bad("payload property set is not closed")
    }
    if(count!=3 || path!=expected_path[idx] || role!=expected_role[idx] || digest !~ /^[a-f0-9]{64}$/)bad("invalid payload record")
    print "FILE " idx " " digest
  }
  function files(    count) {
    take("["); count=0
    while (1) { ws(); if(substr(s,p,1)=="]"){p++;break}; if(count)take(","); if(count>=4)bad("payload file set mismatch"); file_record(count); count++ }
    if(count!=4)bad("payload file set mismatch")
  }
  function mutation(    key,profile,inserted,count) {
    take("{"); count=0; delete mutation_seen
    while(1){ws();if(substr(s,p,1)=="}"){p++;break};if(count++)take(",");key=string();if(mutation_seen[key]++)bad("duplicate pathMutation property");take(":");if(key=="profilePath")profile=string();else if(key=="insertedBytes")inserted=string();else bad("pathMutation property set is not closed")}
    if(count!=2 || profile=="" || substr(profile,1,1)!="/" || inserted=="")bad("invalid POSIX pathMutation")
    print "PROFILE " hex(profile); print "INSERT " hex(inserted)
  }
  BEGIN {
    for(i=0;i<256;i++)ord[sprintf("%c",i)]=i
    expected_path[0]="arashi.bin"; expected_role[0]="native-executable"
    expected_path[1]="arashi"; expected_role[1]="canonical-wrapper"
    expected_path[2]="aw"; expected_role[2]="alias-wrapper"
    expected_path[3]="uninstall.sh"; expected_role[3]="uninstall-helper"
    while((getline line)>0){if(seen_line++)s=s"\n";s=s line} n=length(s);p=1;take("{");count=0
    while(1){ws();if(substr(s,p,1)=="}"){p++;break};if(count++)take(",");key=string();if(top_seen[key]++)bad("duplicate manifest property");take(":")
      if(key=="schemaVersion"){if(scalar_number()!="2")bad("unsupported schema; refresh this direct install first")}
      else if(key=="installationChannel"){if(string()!="official-direct")bad("unsupported installation ownership")}
      else if(key=="platform"){if(string()!="posix")bad("unsupported installation ownership")}
      else if(key=="installDirectory")print "INSTALL " hex(string())
      else if(key=="files")files()
      else if(key=="pathMutation")mutation()
      else bad("manifest property set is not closed")
    }
    ws();if(p<=n)bad("trailing manifest data")
    if(!top_seen["schemaVersion"]||!top_seen["installationChannel"]||!top_seen["platform"]||!top_seen["installDirectory"]||!top_seen["files"]||count<5||count>6)bad("manifest property set is not closed")
  }' "$MANIFEST_PATH"
}

PARSED_MANIFEST="$(mktemp "${TMPDIR:-/tmp}/arashi-manifest.XXXXXX")" || fail "Unable to stage manifest validation"
INSERTED_FILE="$(mktemp "${TMPDIR:-/tmp}/arashi-inserted.XXXXXX")" || fail "Unable to stage PATH provenance"
cleanup_work_files() { rm -f -- "$PARSED_MANIFEST" "$PARSED_MANIFEST.recheck" "$INSERTED_FILE"; }
trap 'cleanup_work_files; cleanup_self' EXIT
parse_manifest > "$PARSED_MANIFEST" || fail "ownership manifest validation failed"

MANIFEST_INSTALL=""
PROFILE_PATH=""
FILE_DIGESTS=()
while IFS=' ' read -r kind first second; do
  case "$kind" in
    INSTALL) MANIFEST_INSTALL="$(decode_hex "$first")" ;;
    FILE) FILE_DIGESTS[$first]="$second" ;;
    PROFILE) PROFILE_PATH="$(decode_hex "$first")" ;;
    INSERT) decode_hex "$first" > "$INSERTED_FILE" ;;
    *) fail "invalid parsed manifest record" ;;
  esac
done < "$PARSED_MANIFEST"
[ "$MANIFEST_INSTALL" = "$INSTALL_DIR" ] || fail "installDirectory mismatch"

file_occurrences() {
  local haystack="$1" needle="$2" haystack_size needle_size offset count=0 first=-1 candidate first_byte
  haystack_size="$(wc -c < "$haystack" | tr -d '[:space:]')"
  needle_size="$(wc -c < "$needle" | tr -d '[:space:]')"
  [ "$needle_size" -gt 0 ] || { printf '0 -1\n'; return; }
  candidate="$(mktemp "${TMPDIR:-/tmp}/arashi-match.XXXXXX")" || fail "Unable to stage byte comparison"
  first_byte="$(od -An -N1 -t u1 "$needle" | tr -d '[:space:]')"
  while read -r offset; do
    [ "$offset" -le $((haystack_size - needle_size)) ] || continue
    dd if="$haystack" of="$candidate" bs=1 skip="$offset" count="$needle_size" 2>/dev/null
    if cmp -s "$candidate" "$needle"; then count=$((count + 1)); [ "$first" -ge 0 ] || first="$offset"; fi
  done < <(od -An -v -t u1 "$haystack" | awk -v wanted="$first_byte" '{for(i=1;i<=NF;i++){if($i==wanted)print offset;offset++}}')
  rm -f -- "$candidate"
  printf '%s %s\n' "$count" "$first"
}

marker_state() {
  LC_ALL=C awk -v begin='# >>> arashi shell integration >>>' -v end='# <<< arashi shell integration <<<' '
    function occurrences(line,needle,  at,count,rest){rest=line;while((at=index(rest,needle))>0){count++;rest=substr(rest,at+length(needle))}return count}
    { raw_begin+=occurrences($0,begin);raw_end+=occurrences($0,end);if($0==begin || $0==begin "\r"){exact_begin++;begin_offset=offset}if($0==end || $0==end "\r"){exact_end++;end_offset=offset+length(end)}offset+=length($0)+1 }
    END{print raw_begin+0,raw_end+0,exact_begin+0,exact_end+0,begin_offset+0,end_offset+0}' "$1"
}

copy_without_range() {
  local path="$1" start="$2" end="$3" size temporary
  size="$(wc -c < "$path" | tr -d '[:space:]')"
  temporary="$(mktemp "$(dirname "$path")/.arashi-uninstall.XXXXXX")" || fail "Unable to stage profile rewrite"
  cp -p "$path" "$temporary" || { rm -f -- "$temporary"; fail "Unable to preserve profile metadata"; }
  : > "$temporary"
  if [ "$start" -gt 0 ]; then dd if="$path" of="$temporary" bs=1 count="$start" 2>/dev/null; fi
  if [ "$end" -lt "$size" ]; then dd if="$path" of="$temporary" bs=1 skip="$end" seek="$start" 2>/dev/null; fi
  mv -f -- "$temporary" "$path"
}

EXPECTED_NAMES=("arashi.bin" "arashi" "aw" "uninstall.sh")
FILE_ACTIONS=()
SHELL_PATHS=()
SHELL_STARTS=()
SHELL_ENDS=()
SHELL_DIGESTS=()
SHELL_PRESERVED=()
SHELL_PRESERVED_COUNT=0
PROFILE_ACTION=""
PROFILE_OFFSET=-1

preflight() {
  local blockers="" index name path actual state raw_begin raw_end exact_begin exact_end begin_offset end_offset count offset normalized_profile
  FILE_ACTIONS=(); SHELL_PATHS=(); SHELL_STARTS=(); SHELL_ENDS=(); SHELL_DIGESTS=(); SHELL_PRESERVED=(); SHELL_PRESERVED_COUNT=0; PROFILE_ACTION=""; PROFILE_OFFSET=-1
  [ ! -L "$MANIFEST_PATH" ] && [ -f "$MANIFEST_PATH" ] || fail "ownership manifest changed after preflight"
  parse_manifest > "$PARSED_MANIFEST.recheck" || fail "ownership manifest changed after preflight"
  cmp -s "$PARSED_MANIFEST" "$PARSED_MANIFEST.recheck" || fail "ownership manifest changed after preflight"
  rm -f -- "$PARSED_MANIFEST.recheck"
  for index in 0 1 2 3; do
    name="${EXPECTED_NAMES[$index]}"; path="$INSTALL_DIR/$name"
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then FILE_ACTIONS[$index]="absent"
    elif [ -L "$path" ]; then blockers="${blockers}\n- $name is a symbolic link"
    elif [ ! -f "$path" ]; then blockers="${blockers}\n- $name is not a regular file"
    else actual="$(sha256_file "$path")"; if [ "$actual" != "${FILE_DIGESTS[$index]}" ]; then blockers="${blockers}\n- $name digest mismatch (modified)"; else FILE_ACTIONS[$index]="remove"; fi
    fi
  done
  if [ -n "$PROFILE_PATH" ]; then
    case "$PROFILE_PATH" in /*) ;; *) fail "invalid POSIX pathMutation" ;; esac
    if [ ! -e "$PROFILE_PATH" ] && [ ! -L "$PROFILE_PATH" ]; then PROFILE_ACTION="absent"
    elif [ -L "$PROFILE_PATH" ] || [ ! -f "$PROFILE_PATH" ] || [ ! -r "$PROFILE_PATH" ]; then PROFILE_ACTION="preserved"
    else
      normalized_profile="$(normalize_absolute_path "$PROFILE_PATH")"
      [ "$normalized_profile" = "$PROFILE_PATH" ] || fail "invalid POSIX pathMutation"
      read -r count offset < <(file_occurrences "$PROFILE_PATH" "$INSERTED_FILE")
      if [ "$count" -eq 1 ]; then PROFILE_ACTION="remove"; PROFILE_OFFSET="$offset"
      elif [ "$count" -eq 0 ]; then PROFILE_ACTION="absent"
      else PROFILE_ACTION="preserved"
      fi
    fi
  fi
  if [ -n "$HOME_DIR" ]; then
    local candidates=("$HOME_DIR/.zshrc" "$HOME_DIR/.config/fish/config.fish")
    if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then candidates+=("$HOME_DIR/.bash_profile" "$HOME_DIR/.bashrc" "$HOME_DIR/.profile"); else candidates+=("$HOME_DIR/.bashrc" "$HOME_DIR/.bash_profile" "$HOME_DIR/.profile"); fi
    for path in "${candidates[@]}"; do
      [ -e "$path" ] || [ -L "$path" ] || continue
      if [ -L "$path" ] || [ ! -f "$path" ] || [ ! -r "$path" ]; then SHELL_PRESERVED[$SHELL_PRESERVED_COUNT]="$path"; SHELL_PRESERVED_COUNT=$((SHELL_PRESERVED_COUNT + 1)); continue; fi
      read -r raw_begin raw_end exact_begin exact_end begin_offset end_offset < <(marker_state "$path")
      if [ "$raw_begin" -eq 0 ] && [ "$raw_end" -eq 0 ]; then continue; fi
      if [ "$raw_begin" -ne 1 ] || [ "$raw_end" -ne 1 ] || [ "$exact_begin" -ne 1 ] || [ "$exact_end" -ne 1 ] || [ "$begin_offset" -ge "$end_offset" ]; then blockers="${blockers}\n- ambiguous shell integration markers in $path"; continue; fi
      index="${#SHELL_PATHS[@]}"; SHELL_PATHS[$index]="$path"; SHELL_STARTS[$index]="$begin_offset"; SHELL_ENDS[$index]="$end_offset"; SHELL_DIGESTS[$index]="$(sha256_file "$path")"
    done
  fi
  [ -z "$blockers" ] || fail "preflight refused:$(printf '%b' "$blockers")"
}

preflight
printf 'Installation channel: official-direct\nInstall directory: %s\n' "$INSTALL_DIR"
for index in 0 1 2 3; do printf -- '- %s: %s\n' "${FILE_ACTIONS[$index]}" "${EXPECTED_NAMES[$index]}"; done
[ -z "$PROFILE_ACTION" ] || printf -- '- PATH state: %s\n' "$PROFILE_ACTION"
if [ "${#SHELL_PATHS[@]}" -gt 0 ]; then
  for path in "${SHELL_PATHS[@]}"; do printf -- '- remove exact managed shell block: %s\n' "$path"; done
fi
if [ "$SHELL_PRESERVED_COUNT" -gt 0 ]; then
  for path in "${SHELL_PRESERVED[@]}"; do printf -- '- preserved unsafe shell startup target: %s (not a readable regular non-link file)\n' "$path"; done
fi
printf '%s\n' 'Preserved: projects, Git data, configuration, unrelated profile bytes, install-directory neighbors, and the install directory.'
[ "$DRY_RUN" = false ] || exit 0
if [ "$YES" = false ]; then
  [ -t 0 ] && [ -t 1 ] || fail "Non-interactive uninstall requires --yes"
  read -r -p 'Remove this proven Arashi direct installation? [y/N] ' answer
  case "$answer" in y|Y|yes|YES) ;; *) printf '%s\n' 'Uninstall declined.'; exit 0 ;; esac
fi

preflight
for index in "${!SHELL_PATHS[@]}"; do
  [ "$(sha256_file "${SHELL_PATHS[$index]}")" = "${SHELL_DIGESTS[$index]}" ] || fail "shell target changed after preflight"
  copy_without_range "${SHELL_PATHS[$index]}" "${SHELL_STARTS[$index]}" "${SHELL_ENDS[$index]}"
done
if [ "$PROFILE_ACTION" = "remove" ]; then
  read -r current_count current_offset < <(file_occurrences "$PROFILE_PATH" "$INSERTED_FILE")
  [ "$current_count" -eq 1 ] && [ "$current_offset" -eq "$PROFILE_OFFSET" ] || fail "PATH profile changed after preflight"
  copy_without_range "$PROFILE_PATH" "$PROFILE_OFFSET" "$((PROFILE_OFFSET + $(wc -c < "$INSERTED_FILE" | tr -d '[:space:]')))"
fi
for index in 0 1 2 3; do [ "${FILE_ACTIONS[$index]}" != "remove" ] || rm -f -- "$INSTALL_DIR/${EXPECTED_NAMES[$index]}"; done
rm -f -- "$MANIFEST_PATH"
