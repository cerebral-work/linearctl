#!/usr/bin/env bash
# Deny direct push to main/master. Override: "# allow-direct-push".
#
# Parses the git command line to find the actual subcommand (skipping global
# flags like -C, -c, --git-dir, etc.) and evaluates the push against the
# repository those flags target — not the session's cwd.
input=$(cat); cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
case "$cmd" in *"# allow-direct-push"*) exit 0 ;; esac

# --- Tokenize the command respecting single/double quotes and backslash escapes.
tokens=()
i=0; n=${#cmd}
while (( i < n )); do
  ch="${cmd:$i:1}"
  case "$ch" in
    ' '|$'\t') ((i++));;
    "'"*)
      j=$((i+1))
      while (( j < n )) && [[ "${cmd:$j:1}" != "'" ]]; do ((j++)); done
      tokens+=("${cmd:$((i+1)):$((j-i-1))}")
      i=$((j+1))
      ;;
    '"'*)
      j=$((i+1)); tok=""
      while (( j < n )) && [[ "${cmd:$j:1}" != '"' ]]; do
        if [[ "${cmd:$j:1}" == '\' ]] && (( j+1 < n )); then
          tok+="${cmd:$((j+1)):1}"; j=$((j+2))
        else
          tok+="${cmd:$j:1}"; ((j++))
        fi
      done
      tokens+=("$tok"); i=$((j+1))
      ;;
    \\*)
      tokens+=("${cmd:$((i+1)):1}"); i=$((i+2))
      ;;
    *)
      j=$i
      while (( j < n )) && [[ "${cmd:$j:1}" != ' ' && "${cmd:$j:1}" != $'\t' ]]; do
        ((j++))
      done
      tokens+=("${cmd:$i:$((j-i))}"); i=$j
      ;;
  esac
done

# --- Walk tokens to find the git invocation ---------------------------------
# Skip leading env vars (FOO=bar) and wrappers (sudo, env, nice, etc.)
ti=0
while (( ti < ${#tokens[@]} )); do
  t="${tokens[$ti]}"
  if [[ "$t" =~ ^[A-Za-z_][A-Za-z_0-9]*= ]]; then ((ti++)); continue; fi
  case "$t" in
    sudo|env|nice|ionice|nohup|timeout|command|builtin) ((ti++)); continue;;
  esac
  break
done

# Must be git
[[ "${tokens[$ti]:-}" != git ]] && exit 0
((ti++))

# --- Parse git global flags to find -C <path> and the subcommand ------------
repo_dir=""
subcmd=""
while (( ti < ${#tokens[@]} )); do
  t="${tokens[$ti]}"
  case "$t" in
    -C)
      ((ti++)); repo_dir="${tokens[$ti]:-}"; ((ti++));;
    --git-dir=*)  ((ti++));;
    --work-tree=*) ((ti++));;
    -c)           ((ti+=2));;
    --config-env=*) ((ti++));;
    -p|--paginate|--no-pager|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)
      ((ti++));;
    --exec-path=*) ((ti++));;
    --html-path|--man-path|--info-path) ((ti++));;
    -*)
      ((ti++));;
    *)
      subcmd="$t"; ((ti++)); break;;
  esac
done

[[ "$subcmd" != push ]] && exit 0

# --- Parse push arguments ----------------------------------------------------
remote_seen=""
dest_refs=()
while (( ti < ${#tokens[@]} )); do
  t="${tokens[$ti]}"
  case "$t" in
    -*) ((ti++)); continue;;
  esac
  if [[ -z "$remote_seen" ]]; then
    remote_seen="$t"; ((ti++)); continue
  fi
  dest="${t#*:}"
  dest_refs+=("$dest")
  ((ti++))
done

# --- Decide ------------------------------------------------------------------
deny_reason="Direct push to main is blocked — open a PR. Override: # allow-direct-push and surface why."

for ref in ${dest_refs[@]+"${dest_refs[@]}"}; do
  bare="${ref#refs/heads/}"
  if [[ "$bare" == main || "$bare" == master ]]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$deny_reason"
    exit 0
  fi
done

if (( ${#dest_refs[@]} == 0 )); then
  if [[ -n "$repo_dir" ]]; then
    branch=$(git -C "$repo_dir" branch --show-current 2>/dev/null)
  else
    branch=$(git branch --show-current 2>/dev/null)
  fi
  if [[ "$branch" == main || "$branch" == master ]]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$deny_reason"
    exit 0
  fi
fi

exit 0
