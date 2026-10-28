#!/usr/bin/env bash
# Demo (plan kiro-web-reliability §4 item 4): `git commit … && git push …` in ONE command. The PreToolUse guard lets it
# through without checking; the pre-push hook runs the real preflight on the NEW commit. Throwaway clone; the only
# "remote" is a throwaway local bare repo (a nonexistent remote fails in git before any hook runs — shown first).
set -u
WT=/projects/sandbox/vitana-platform/.agents/wt/session-reliability
D=/projects/sandbox/vitana-platform/.agents/tasks/pipeline-kiro-exafy-202610271051-d636/sr-scratch/demo
C="$D/clone"
export VITANA_KIRO_WEB_CACHE="$D/cache" VITANA_KIRO_WEB_PLATFORM="$WT"
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.invalid GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.invalid
git -C "$C" reset -q --hard HEAD && echo "clone reset to HEAD (the race demo left its type error staged)"
O="$D/throwaway-origin.git"; rm -rf "$O"; git init -q --bare "$O"
git -C "$WT" push -q "$O" "$(git -C "$WT" rev-parse origin/main):refs/heads/main" && git -C "$C" remote set-url origin "$O" && git -C "$C" fetch -q origin main
echo "clone origin = throwaway bare repo whose main = origin/main $(git -C "$C" rev-parse origin/main)"
node "$WT/scripts/collab/kiro-web-session.mjs" pr-body --vtid VTID-05361 --scope 'docs-demo-*.md' --acceptance docs/validation/VTID-05361/acceptance.md --payload 'demo. Deploys nothing.' > "$D/body.md"
echo "PR body written by pr-body: $(grep -cE '^(VALIDATION_PROFILE|SCOPE_ALLOWLIST|ACCEPTANCE|MERGE_PAYLOAD_PREVIEW|OASIS_IMPACT):' "$D/body.md") of 5 declarations"
echo "== 1. nonexistent remote: git fails before connecting, so no hook can run (shown for completeness)"
echo demo >> "$C/docs-demo-1.md"; git -C "$C" add docs-demo-1.md
git -C "$C" commit -q -m 'demo 1' && PR_TITLE='VTID-05361 (kiro-web-reliability/session-reliability): demo' git -C "$C" push nonexistent-remote HEAD:refs/heads/kiro/x/y; echo "   exit=$?"
R="$D/throwaway-remote.git"; rm -rf "$R"; git init -q --bare "$R"
echo "== 2. throwaway local bare remote $R"
echo demo2 >> "$C/docs-demo-2.md"; git -C "$C" add docs-demo-2.md
OLD=$(git -C "$C" rev-parse HEAD)
CMD="git -C $C commit -q -m 'demo 2' && PR_TITLE='VTID-05361 (kiro-web-reliability/session-reliability): demo' PR_BODY_FILE=$D/body.md git -C $C push $R HEAD:refs/heads/kiro/x/y"
echo "== PreToolUse guard on: $CMD"
printf '%s' "{\"tool_name\":\"execute_bash\",\"tool_input\":{\"command\":\"$CMD\",\"cwd\":\"$C\"}}" | node "$WT/scripts/collab/kiro-web-session.mjs" guard
echo "   guard exit=$? (HEAD before the command: $OLD)"
echo "== the command runs (commit, then push → pre-push hook → preflight on the new commit)"
s=$(date +%s)
bash -c "$CMD" 2>&1 | grep -vE '^\s*\|' | head -60; RC=${PIPESTATUS[0]}
NEW=$(git -C "$C" rev-parse HEAD)
echo "   command exit=$RC after $(( $(date +%s)-s )) s; HEAD after the commit: $NEW"
echo "== which commit did preflight judge? (head shown in its header line)"
grep -hE "^preflight |  base |preflight (failed|passed) on" "$VITANA_KIRO_WEB_CACHE/last-block.txt" 2>/dev/null | head -4
echo "== remote ref: $(git ls-remote "$R" refs/heads/kiro/x/y)"
[ "$NEW" = "$OLD" ] && echo "RESULT: no new commit" || { [ -n "$(git ls-remote "$R" refs/heads/kiro/x/y)" ] && echo "RESULT: pushed — pre-push preflight passed on the new commit $NEW" || echo "RESULT: push BLOCKED by pre-push — preflight judged the new commit $NEW (not $OLD)"; }
