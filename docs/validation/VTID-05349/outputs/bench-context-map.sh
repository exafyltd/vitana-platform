#!/usr/bin/env bash
# Benchmark: representative context questions, today's way vs scripts/dev/context.mjs (plan context-map).
# Read-only. Run from the vitana-platform checkout with vitana-v1 as a sibling (or VITANA_V1_DIR).
# For each task: number of commands, wall time, bytes printed (what lands in the agent's context), and whether the
# expected answer (a file:line or path) is in the output.
set -u
P=$(git rev-parse --show-toplevel); V1=${VITANA_V1_DIR:-$(dirname "$P")/vitana-v1}; G=$P/services/gateway
CTX="node $P/scripts/dev/context.mjs"
ms() { date +%s%N; }
run() { # run <label> <expect-regex> <cmd...>; each cmd is one string, one agent tool call
  local label=$1 expect=$2; shift 2; local s=$(ms) out="" n=0
  for c in "$@"; do out+=$(bash -c "$c" 2>&1); out+=$'\n'; n=$((n+1)); done
  local t=$(( ($(ms)-s)/1000000 )) b=${#out} hit=no
  grep -qE "$expect" <<<"$out" && hit=yes
  printf '| %s | %d | %d | %d | %s |\n' "$label" "$n" "$t" "$b" "$hit"
}
echo "| task / method | commands | ms | bytes | answer found |"
echo "|---|---|---|---|---|"
# T1 gateway route → handler + tests
run "T1 route, grep" 'routes/vtid.ts:144' \
  "grep -rn 'vtid/allocate' $G/src --include=*.ts" \
  "grep -n 'vtidRouter' $G/src/index.ts" \
  "grep -n \"'/allocate'\\|\\\"/allocate\\\"\" $G/src/routes/vtid.ts | sed 's#^#services/gateway/src/routes/vtid.ts:#'" \
  "grep -rln 'vtid/allocate' $G/test"
run "T1 route, context.mjs" 'routes/vtid.ts:144' "$CTX route 'POST /api/v1/vtid/allocate'"
# T2 vitana-v1 path → page component + registrations
run "T2 screen, grep" 'pages/Messages' \
  "grep -n 'path=\"/inbox\"' $V1/src/App.tsx" \
  "sed -n 1352,1357p $V1/src/App.tsx" \
  "grep -n 'const Messages ' $V1/src/App.tsx" \
  "grep -n '\"route\": \"/inbox\"' $V1/src/navigation/registry/screens.json" \
  "grep -n '\"path\": \"/inbox\"' $V1/src/design/screen-manifest.json" \
  "grep -n '\"web_path\": \"/inbox\"' $V1/apps/mobile/parity/ledger.json"
run "T2 screen, context.mjs" 'pages/Messages' "$CTX screen /inbox"
# T3 area map: which route files, tables and flags make up "autopilot"
run "T3 area, grep" 'dev_autopilot_executions' \
  "ls $G/src/routes | grep -i autopilot" \
  "grep -rl -i autopilot $G/src --include=*.ts" \
  "grep -rhoE 'dev_autopilot_[a-z_]+' $G/src | sort -u"
run "T3 area, context.mjs" 'dev_autopilot_executions' "$CTX domain autopilot"
# T4 dependencies: who imports assistant-profile.ts (code vs tests)
run "T4 deps, grep" 'session-profile.ts' "grep -rn \"assistant-profile'\" $G/src $G/test"
run "T4 deps, context.mjs" 'session-profile.ts:14' "$CTX uses services/gateway/src/orb/profile/assistant-profile.ts"
# T5 decision: why the worker-runner claims only autonomous rows
run "T5 why, grep" 'CLAUDE.md:5(56|65|73)' "grep -rn 'worker-runner' $P/CLAUDE.md $P/.claude/rules $P/docs/CHANGELOG.md $P/docs/CHANGELOG-ARCHIVE.md"
run "T5 why, context.mjs" 'CLAUDE.md:5(56|65|73)' "$CTX why worker-runner"
# T6 prior work for a VTID
run "T6 vtid, git+grep" 'acceptance.md' \
  "bash $P/scripts/dev/resume-vtid.sh VTID-05300" \
  "git -C $P log --all --oneline --grep VTID-05300" \
  "ls $P/docs/validation/VTID-05300" \
  "grep -rl VTID-05300 $P/.kiro/specs $V1/.kiro/specs 2>/dev/null | sed 's#.*/\\.kiro#.kiro#'" \
  "git -C $V1 log --all --oneline --grep VTID-05300"
run "T6 vtid, context.mjs" 'acceptance.md' "$CTX vtid VTID-05300"
# T7 stale pointers in the atlas and rule files (no command exists today)
run "T7 stale, context.mjs" 'services/stripe' "$CTX check"
