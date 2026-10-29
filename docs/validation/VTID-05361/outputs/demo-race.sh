#!/usr/bin/env bash
# Demo (plan kiro-web-reliability §4 item 3): the P23 race, reproduced in a throwaway clone with the REAL gateway tsc.
# A background writer edits a gateway file after the PreToolUse check ran and before `git add`; the installed
# pre-commit hook still blocks. Nothing is pushed anywhere.
set -u
WT=/projects/sandbox/vitana-platform/.agents/wt/session-reliability
D=/projects/sandbox/vitana-platform/.agents/tasks/pipeline-kiro-exafy-202610271051-d636/sr-scratch/demo
rm -rf "$D"; mkdir -p "$D"
export VITANA_KIRO_WEB_CACHE="$D/cache" VITANA_KIRO_WEB_PLATFORM="$WT"
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.invalid GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.invalid
C="$D/clone"
echo "== $(date -u +%FT%TZ) throwaway clone of $(git -C "$WT" rev-parse origin/main) (origin/main) at $C"
git clone -q --no-hardlinks "$WT" "$C" && git -C "$C" checkout -q -b kiro/x/y
echo "== install the git hooks (installGitHooks, script = this lane's kiro-web-session.mjs)"
node --input-type=module -e "
import { installGitHooks } from '$WT/scripts/collab/kiro-web-session.mjs';
console.log(JSON.stringify(installGitHooks({ repos: [{ dir: '$C' }], script: '$WT/scripts/collab/kiro-web-session.mjs' })));"
head -3 "$C/.git/hooks/pre-commit"; ls -l "$C/.git/hooks/pre-commit" "$C/.git/hooks/pre-push" | awk '{print $1, $NF}'
F=services/gateway/src/routes/health.ts
echo "// demo: a harmless comment" >> "$C/$F"
CMD="git -C $C add -A && git -C $C commit -q -m 'demo: race'"
echo "== background writer starts (injects a type error into $F in 2 s)"
( sleep 2; echo 'export const __raceDemo: number = "not a number";' >> "$C/$F"; echo "   writer: injected at $(date -u +%T.%N)" ) &
W=$!
echo "== PreToolUse guard on: $CMD"
printf '%s' "{\"tool_name\":\"execute_bash\",\"tool_input\":{\"command\":\"$CMD\",\"cwd\":\"$C\"}}" | node "$WT/scripts/collab/kiro-web-session.mjs" guard
echo "   guard exit=$? at $(date -u +%T.%N) (clean tree: nothing to block yet)"
wait $W
BEFORE=$(git -C "$C" rev-parse HEAD)
echo "== the command runs now (git add picks up the writer's edit); the pre-commit hook typechecks (npm ci first: no node_modules in the clone)"
s=$(date +%s)
bash -c "$CMD"; RC=$?
echo "   commit exit=$RC after $(( $(date +%s)-s )) s"
AFTER=$(git -C "$C" rev-parse HEAD)
[ "$BEFORE" = "$AFTER" ] && echo "RESULT: commit BLOCKED — HEAD unchanged ($BEFORE)" || echo "RESULT: commit CREATED $AFTER (unexpected)"
