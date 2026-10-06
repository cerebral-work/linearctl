#!/usr/bin/env bash
# Deny direct push to main/master. Override: "# allow-direct-push".
#
# Splits the command line on shell control operators, evaluates every segment,
# tracks cd to resolve bare pushes against the right repository, and recurses
# into bash -c / sh -c / eval string arguments.
#
# Fail-closed: when a segment contains "git" followed by "push" and the parser
# cannot fully resolve it, DENY.
# No set -e: ((i++)) from 0 is a non-zero status, and a killed parser would
# silently ALLOW. Errors are handled explicitly.
set -uo pipefail
# Byte-oriented string ops: in a UTF-8 locale ${s:i:1} rescans from the start
# each time (O(n²)); LC_ALL=C makes indexing constant-time.
export LC_ALL=C

input=$(cat); cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
case "$cmd" in *"# allow-direct-push"*) exit 0 ;; esac

# Fast exit: every case this hook can decide contains both "git" and "push".
case "$cmd" in *git*push*) ;; *) exit 0 ;; esac

# Join backslash-newline continuations into spaces BEFORE the line filter —
# otherwise `git \⏎ push origin main` loses its parts to the filter.
cmd="${cmd//\\$'\n'/ }"

# Second-stage filter: only lines containing both substrings can hold a git
# push.  Keep `cd` lines too so directory context survives.  A 16 KiB heredoc
# body without them costs one `case` per line, not a tokenize pass.
cmd_filtered=()
while IFS= read -r line; do
  case "$line" in
    *git*push*|*push*git*|*cd\ *|cd)
      cmd_filtered+=("$line")
      ;;
  esac
done <<< "$cmd"
(( ${#cmd_filtered[@]} == 0 )) && exit 0
# Join filtered lines for a single check_command call — the segment splitter
# handles the newlines.
cmd=$(printf '%s\n' "${cmd_filtered[@]}")

deny_reason="Direct push to main is blocked — open a PR. Override: # allow-direct-push and surface why."

emit_deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$deny_reason"
  exit 0
}

# --- Tokenizer ---------------------------------------------------------------
tokenize() {
  local str="$1"
  tokens=()
  local i=0 n=${#str}
  while (( i < n )); do
    local ch="${str:$i:1}"
    case "$ch" in
      ' '|$'\t') ((i++));;
      "'")
        local j=$((i+1))
        while (( j < n )) && [[ "${str:$j:1}" != "'" ]]; do ((j++)); done
        tokens+=("${str:$((i+1)):$((j-i-1))}")
        i=$((j+1))
        ;;
      '"')
        local j=$((i+1)) tok=""
        while (( j < n )) && [[ "${str:$j:1}" != '"' ]]; do
          if [[ "${str:$j:1}" == '\' ]] && (( j+1 < n )); then
            tok+="${str:$((j+1)):1}"; j=$((j+2))
          else
            tok+="${str:$j:1}"; ((j++))
          fi
        done
        tokens+=("$tok"); i=$((j+1))
        ;;
      \\)
        if (( i+1 < n )); then
          tokens+=("${str:$((i+1)):1}"); i=$((i+2))
        else
          ((i++))
        fi
        ;;
      *)
        # Unquoted word: use pattern removal to find the end (C-speed).
        local rest="${str:$i}"
        local word="${rest%%[[:space:]]*}"
        tokens+=("$word")
        i=$((i + ${#word}))
        ;;
    esac
  done
}

# --- Segment splitter ---------------------------------------------------------
split_segments() {
  local str="$1"
  segments=()

  # Fast path: no special characters → the whole string is one segment.
  case "$str" in
    *"'"*|*'"'*|*'`'*|*'$('*|*';'*|*'&'*|*'|'*|*$'\n'*|*'('*|*')'*|*'\\'*) ;;
    *) segments+=("$str"); return;;
  esac

  local i=0 n=${#str} cur=""
  while (( i < n )); do
    local ch="${str:$i:1}"
    case "$ch" in
      "'")
        local j=$((i+1))
        while (( j < n )) && [[ "${str:$j:1}" != "'" ]]; do ((j++)); done
        cur+="${str:$i:$((j-i+1))}"
        i=$((j+1))
        ;;
      '"')
        local j=$((i+1))
        while (( j < n )) && [[ "${str:$j:1}" != '"' ]]; do
          if [[ "${str:$j:1}" == '\' ]] && (( j+1 < n )); then
            j=$((j+2))
          else
            ((j++))
          fi
        done
        cur+="${str:$i:$((j-i+1))}"
        i=$((j+1))
        ;;
      \\)
        if (( i+1 < n )); then
          cur+="${str:$i:2}"; i=$((i+2))
        else
          cur+="$ch"; ((i++))
        fi
        ;;
      $'\n'|';'|'('|')'|'`')
        if [[ -n "$cur" ]]; then segments+=("$cur"); cur=""; fi
        ((i++))
        ;;
      '$')
        if (( i+1 < n )) && [[ "${str:$((i+1)):1}" == '(' ]]; then
          if [[ -n "$cur" ]]; then segments+=("$cur"); cur=""; fi
          local j=$((i+2)) depth=1
          while (( j < n && depth > 0 )); do
            case "${str:$j:1}" in
              '(') ((depth++));;
              ')') ((depth--));;
            esac
            ((j++))
          done
          local interior="${str:$((i+2)):$((j-i-3))}"
          if [[ -n "$interior" ]]; then segments+=("$interior"); fi
          i=$j
        else
          cur+="$ch"; ((i++))
        fi
        ;;
      '&'|'|')
        if [[ -n "$cur" ]]; then segments+=("$cur"); cur=""; fi
        if (( i+1 < n )) && [[ "${str:$((i+1)):1}" == "$ch" ]]; then
          i=$((i+2))
        else
          ((i++))
        fi
        ;;
      *)
        # Fast-forward through plain text: grab everything up to the next
        # special character in one shot (C-speed pattern removal).
        # Special = quote backtick dollar paren semicolon amp pipe backslash
        # newline tab — everything that triggers a case branch above.
        local rest="${str:$i}"
        local plain="${rest%%[!a-zA-Z0-9 _.:,/+~=_@#%-]*}"
        if [[ -n "$plain" ]]; then
          cur+="$plain"
          i=$((i + ${#plain}))
        else
          cur+="$ch"; ((i++))
        fi
        ;;
    esac
  done
  if [[ -n "$cur" ]]; then segments+=("$cur"); fi
}

# --- Helpers ------------------------------------------------------------------
is_main_ref() {
  local ref="$1"
  ref="${ref#+}"
  local bare="${ref#refs/heads/}"
  [[ "$bare" == main || "$bare" == master ]]
}

# Cache: the session branch doesn't change during hook execution.
_session_branch=""
_session_branch_done=0
session_branch() {
  (( _session_branch_done )) || {
    _session_branch=$(git branch --show-current 2>/dev/null || true)
    _session_branch_done=1
  }
  printf '%s' "$_session_branch"
}

repo_branch() {
  git -C "$1" branch --show-current 2>/dev/null || true
}

# --- Segment evaluation -------------------------------------------------------
# Returns 0 = deny, 1 = allow, 2 = unresolved (contains git+push but can't
# classify — the caller decides whether to fail closed).
eval_segment() {
  local segment="$1"
  local eff_dir="$2"

  tokenize "$segment"
  local -a toks=("${tokens[@]+"${tokens[@]}"}")
  (( ${#toks[@]} == 0 )) && return 1

  # Quick check: does this segment contain both "git" and "push" as tokens?
  # Use substring match on the segment text first (C-speed), then confirm
  # with the token array only if both substrings are present.
  local has_git=0 has_push=0
  case "$segment" in
    *git*push*|*push*git*)
      for t in ${toks[@]+"${toks[@]}"}; do
        [[ "$t" == git ]] && has_git=1
        [[ "$t" == push ]] && has_push=1
        (( has_git && has_push )) && break
      done
      ;;
  esac

  # --- Strip wrappers with their arguments ---
  local ti=0
  # Fast path: first token is not a wrapper/env-var → skip the loop entirely.
  case "${toks[0]}" in
    timeout|nice|env|sudo|rtk|ionice|nohup|command|builtin|*=*)
      while (( ti < ${#toks[@]} )); do
        local t="${toks[$ti]}"
        if [[ "$t" =~ ^[A-Za-z_][A-Za-z_0-9]*= ]]; then ((ti++)); continue; fi
        case "$t" in
          timeout)
            ((ti++))
            if (( ti < ${#toks[@]} )) && [[ "${toks[$ti]}" =~ ^[0-9] ]]; then ((ti++)); fi
            continue;;
          nice)
            ((ti++))
            if (( ti < ${#toks[@]} )) && [[ "${toks[$ti]}" == "-n" ]]; then ((ti+=2)); fi
            continue;;
          env)
            ((ti++))
            while (( ti < ${#toks[@]} )); do
              case "${toks[$ti]}" in
                -u) ((ti+=2));;
                -*) ((ti++));;
                *=*) ((ti++));;
                *) break;;
              esac
            done
            continue;;
          sudo)
            ((ti++))
            while (( ti < ${#toks[@]} )) && [[ "${toks[$ti]}" == -* ]]; do
              case "${toks[$ti]}" in
                -u|-g|-h|-p) ((ti+=2));;
                *) ((ti++));;
              esac
            done
            continue;;
          rtk|ionice|nohup|command|builtin)
            ((ti++)); continue;;
          *)
            break;;
        esac
      done
      ;;
  esac

  (( ti >= ${#toks[@]} )) && {
    # Wrappers consumed everything — if git+push were among them, fail closed
    (( has_git && has_push )) && return 2
    return 1
  }
  local first="${toks[$ti]}"

  # --- Recurse into bash -c / sh -c / eval ---
  case "$first" in
    bash|sh)
      ((ti++))
      while (( ti < ${#toks[@]} )); do
        case "${toks[$ti]}" in
          -c)
            ((ti++))
            if (( ti < ${#toks[@]} )); then
              check_command "${toks[$ti]}" "$eff_dir"
              return $?
            fi
            # -c with no argument — can't resolve
            (( has_git && has_push )) && return 2
            return 1;;
          -*) ((ti++));;
          *)  ((ti++));;
        esac
      done
      (( has_git && has_push )) && return 2
      return 1;;
    eval)
      ((ti++))
      local eval_str=""
      while (( ti < ${#toks[@]} )); do
        eval_str+="${toks[$ti]} "; ((ti++))
      done
      if [[ -n "$eval_str" ]]; then
        check_command "$eval_str" "$eff_dir"
        return $?
      fi
      (( has_git && has_push )) && return 2
      return 1;;
  esac

  # --- cd is handled by the caller ---
  [[ "$first" == cd ]] && return 1

  # --- Not git: allow unless git+push tokens are present (fail closed) ---
  if [[ "$first" != git ]]; then
    (( has_git && has_push )) && return 2
    return 1
  fi
  ((ti++))

  # --- Parse git global flags ---
  local repo_dir=""
  local subcmd=""
  while (( ti < ${#toks[@]} )); do
    local t="${toks[$ti]}"
    case "$t" in
      -C)
        ((ti++))
        if (( ti < ${#toks[@]} )); then
          repo_dir="${toks[$ti]}"; ((ti++))
        fi
        ;;
      --git-dir=*|--work-tree=*|--namespace=*)
        ((ti++));;
      --git-dir|--work-tree|--namespace)
        ((ti+=2));;
      -c)
        ((ti+=2));;
      --config-env=*)
        ((ti++));;
      -p|--paginate|--no-pager|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)
        ((ti++));;
      --exec-path=*)
        ((ti++));;
      --html-path|--man-path|--info-path)
        ((ti++));;
      -*)
        ((ti++));;
      *)
        subcmd="$t"; ((ti++)); break;;
    esac
  done

  [[ "$subcmd" != push ]] && return 1

  # --- Parse push arguments ---
  local remote_seen=""
  local -a dest_refs=()
  while (( ti < ${#toks[@]} )); do
    local t="${toks[$ti]}"
    case "$t" in
      --mirror|--all)
        # Pushes every ref, main included — always deny.
        return 0;;
      -*) ((ti++)); continue;;
    esac
    if [[ -z "$remote_seen" ]]; then
      remote_seen="$t"; ((ti++)); continue
    fi
    local dest="${t#*:}"
    dest_refs+=("$dest")
    ((ti++))
  done

  # --- Decide ---
  for ref in ${dest_refs[@]+"${dest_refs[@]}"}; do
    ref="${ref#+}"
    if [[ "$ref" == HEAD || "$ref" == @ || -z "$ref" ]]; then
      local resolved_dir="${repo_dir:-$eff_dir}"
      local branch
      if [[ -n "$resolved_dir" ]]; then
        branch=$(repo_branch "$resolved_dir")
      else
        branch=$(session_branch)
      fi
      if [[ "$branch" == main || "$branch" == master ]]; then
        return 0
      fi
      continue
    fi
    if is_main_ref "$ref"; then
      return 0
    fi
  done

  if (( ${#dest_refs[@]} == 0 )); then
    local resolved_dir="${repo_dir:-$eff_dir}"
    local branch
    if [[ -n "$resolved_dir" ]]; then
      branch=$(repo_branch "$resolved_dir")
    else
      branch=$(session_branch)
    fi
    if [[ "$branch" == main || "$branch" == master ]]; then
      return 0
    fi
  fi

  return 1
}

# --- Check a full command string (may contain multiple segments) --------------
check_command() {
  local cmd_str="$1"
  local eff_dir="$2"
  local -a unresolved=()

  split_segments "$cmd_str"

  local seg
  for seg in ${segments[@]+"${segments[@]}"}; do
    # Trim whitespace
    seg="${seg#"${seg%%[![:space:]]*}"}"
    seg="${seg%"${seg##*[![:space:]]}"}"
    [[ -z "$seg" ]] && continue

    # Track cd for subsequent segments
    tokenize "$seg"
    if (( ${#tokens[@]} >= 2 )) && [[ "${tokens[0]}" == cd ]]; then
      eff_dir="${tokens[1]}"
      continue
    fi

    eval_segment "$seg" "$eff_dir"
    local rc=$?
    if (( rc == 0 )); then
      return 0  # deny
    elif (( rc == 2 )); then
      # Collect unresolved segments; check them all at once after the loop.
      unresolved+=("$seg")
    fi
  done

  # Fail closed on unresolved git+push segments, but only when they plausibly
  # target main/master: the segment names main, master, HEAD, or @, or the
  # resolved branch is main/master.  This matches what the old regex enforced —
  # a heredoc body line of prose like "note: we will git push origin feat later"
  # is not a risk.
  if (( ${#unresolved[@]} > 0 )); then
    local seg
    for seg in "${unresolved[@]}"; do
      case "$seg" in
        *main*|*master*|*HEAD*|*@*) return 0;;
      esac
    done
    # None named main/master/HEAD/@ — check the resolved branch once.
    local branch
    if [[ -n "$eff_dir" ]]; then
      branch=$(repo_branch "$eff_dir")
    else
      branch=$(session_branch)
    fi
    [[ "$branch" == main || "$branch" == master ]] && return 0
  fi

  return 1
}

# --- Main ---------------------------------------------------------------------
if check_command "$cmd" ""; then
  emit_deny
fi

exit 0
