#!/usr/bin/env bash
# Demo (plan §4 item 4, passing case): same `commit && push` command; preflight is a stand-in that passes and logs its
# arguments (the real preflight fails on a demo branch that is no lane, see demo-commit-push.txt). Shows the pre-push
# hook checks the NEW sha and that after the push `git ls-remote` equals it. Throwaway clone and throwaway remote only.
set -u
WT=/projects/sandbox/vitana-platform/.agents/wt/session-reliability
D=/projects/sandbox/vitana-platform/.agents/tasks/pipeline-kiro-exafy-202610271051-d636/sr-scratch/demo
C="$D/clone"
FP="$D/fake-platform"; rm -rf "$FP"; mkdir -p "$FP/scripts/collab"
cat > "$FP/scripts/collab/preflight.mjs" <<EOF
import { appendFileSync } from 'node:fs';
appendFileSync('$D/fake-preflight-args.txt', process.argv.slice(2).join(' ') + '\n');
console.log('preflight: every check passed (stand-in)');
EOF
rm -f "$D/fake-preflight-args.txt"
export VITANA_KIRO_WEB_CACHE="$D/cache-pass" VITANA_KIRO_WEB_PLATFORM="$FP"
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.invalid GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.invalid
R="$D/throwaway-remote-pass.git"; rm -rf "$R"; git init -q --bare "$R"
echo demo3 >> "$C/docs-demo-3.md"; git -C "$C" add docs-demo-3.md
OLD=$(git -C "$C" rev-parse HEAD)
CMD="git -C $C commit -q -m 'demo 3' && PR_TITLE='VTID-05361 (kiro-web-reliability/session-reliability): demo' PR_BODY_FILE=$D/body.md git -C $C push -q $R HEAD:refs/heads/kiro/x/y && git ls-remote $R refs/heads/kiro/x/y"
echo "== HEAD before: $OLD"
bash -c "$CMD"; echo "   command exit=$?"
NEW=$(git -C "$C" rev-parse HEAD)
echo "== HEAD after the commit: $NEW"
echo "== stand-in preflight was called with: $(cat "$D/fake-preflight-args.txt" | sed "s#$D#<demo>#g")"
grep -q -- "--head $NEW" "$D/fake-preflight-args.txt" && echo "   --head is the NEW commit" || echo "   --head is NOT the new commit"
[ "$(git ls-remote "$R" refs/heads/kiro/x/y | cut -f1)" = "$NEW" ] && echo "RESULT: ls-remote equals the new commit $NEW" || echo "RESULT: ls-remote differs"
