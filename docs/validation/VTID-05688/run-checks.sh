#!/usr/bin/env bash
# VTID-05688: reproduces every check in commands.log. Read-only: local git, node tests, GitHub REST GET.
# Run from the vitana-platform worktree root:
#   V1=<vitana-v1 checkout> STRAT=<vitanaland-strategy checkout> bash docs/validation/VTID-05688/run-checks.sh > docs/validation/VTID-05688/commands.log
# E-mail addresses are masked in this log (sed) so the evidence file never reproduces one.
set -u
PIN=6dc6e1ba0c18252ec2f3fbf5651d245e200f9835
V1PIN=e31bf4627ff3c705c20f8e6b718ce4dd03353b7f
STRATPIN=fb77090e1ffc7d1ef3c250b0aa721768c3df9425
V1="${V1:-/projects/sandbox/vitana-v1}"
STRAT="${STRAT:-/projects/sandbox/vitanaland-strategy}"
D=docs/programs/strategy-execution/delivery-capacity.md
MASK='s/[][A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<address>/g'
PREFIX='s/^kiro-[0-9].*/kiro-<no seat>/; s/^(kiro-ide)-.*/\1-*/; s/^(kiro-[a-z]+)-[0-9].*/\1/; s/^agent-vitana-lane-reviewer.*/agent-vitana-lane-reviewer/; s/.*session_.*/claude session_/'
run() { echo "\$ $*"; bash -c "$*" 2>&1 | sed -E "$MASK"; echo "exit=${PIPESTATUS[0]}"; echo; }
export PREFIX
echo "# VTID-05688 commands.log (strategy-execution-wave1/delivery-capacity)"
echo "# worktree $(pwd), run $(date -u +%FT%TZ)"
echo "# vitana-platform pin $PIN, vitana-v1 pin $V1PIN, strategy commit $STRATPIN (no newer origin/main used)"
echo
run "git rev-parse HEAD origin/main; git -C $V1 rev-parse origin/main; git -C $STRAT rev-parse HEAD"
run "git status --porcelain --untracked-files=all; git diff --quiet HEAD -- CLAUDE.md docs/programs/areas.yaml .kiro/automations && echo protected-and-governance-files-unchanged"
echo "## AC-2 / AC-3 citation check, em dash and e-mail checks (full output)"
run "node docs/validation/VTID-05688/citation-check.mjs --repo . --pin $PIN --doc $D --alias vitana-v1/=$V1@$V1PIN --alias vitanaland-strategy/=$STRAT@$STRATPIN --no-emdash --no-email"
echo "## AC-4 seats (names only)"
run "sed -n '12p;14,18p' docs/programs/areas.yaml | sed -E 's/account: [^,]+,/account: <not reproduced>,/'"
run "ls .kiro/automations/"
echo "## AC-4 sessions in commit trailers, last 30 days (task command, then grouped)"
run "git log --since=2026-10-12 --format=%B origin/main | grep Collab-Session | wc -l"
run "git log --since=2026-10-12 --format=%B origin/main | grep -oE 'Collab-Session: *[^ ]+' | sed 's/Collab-Session: *//' | sort -u | wc -l"
run "git log --since=2026-10-12 --format=%B origin/main | grep -oE 'Collab-Session: *[^ ]+' | sed 's/Collab-Session: *//' | sort -u | sed -E \"\$PREFIX\" | sort | uniq -c | sort -rn"
run "git -C $V1 log --since=2026-10-12 --format=%B origin/main | grep -oE 'Collab-Session: *[^ ]+' | sed 's/Collab-Session: *//' | sort -u | sed -E \"\$PREFIX\" | sort | uniq -c | sort -rn"
run "for p in kiro-exafyltd- kiro-exafy- kiro-hotmail- kiro-jtadic- kiro-dstev- 'kiro-[0-9]{12}-' kiro-ide session_ agent-vitana-lane-reviewer- pm-agent ci-plan-spar; do echo \"\$p latest=\$(git log --since=2026-10-12 --format='%h %cI' -E --grep=\"Collab-Session: *(https://claude.ai/code/)?\$p\" origin/main | head -1) earliest=\$(git log --since=2026-10-12 --format='%h %cI' -E --grep=\"Collab-Session: *(https://claude.ai/code/)?\$p\" origin/main | tail -1)\"; done"
run "git log -1 --format='%h %cI' origin/main"
echo "## AC-4 sessions in lane and handoff logs since 2026-10-12"
run "grep -h -E '^### 20[0-9-]+T[^ ]* · [^ ]+ · ' .kiro/specs/*/lanes/*.md .kiro/specs/*/handoff.md | awk -F' · ' '{d=substr(\$1,5,10); if (d>=\"2026-10-12\") print \$2}' | sort -u | sed -E \"\$PREFIX\" | sort | uniq -c | sort -rn"
run "grep -h '^author_seat:' .kiro/specs/*/handoff.md | sort | uniq -c | sort -rn"
echo "## AC-4 open lanes by state and seat (lane front matter at the pin)"
run "for f in .kiro/specs/*/lanes/*.md; do awk 'NR==1&&/^---\$/{f=1;next} f&&/^---\$/{exit} f' \$f | awk '/^state:/{s=\$2} /^next_actor:/{n=\$2} /^seat:/{t=\$2} END{print s\"|\"n\"|\"t}'; done > /tmp/lanes-05688.tmp; echo lanes=\$(wc -l < /tmp/lanes-05688.tmp) done=\$(grep -c '^done|' /tmp/lanes-05688.tmp); awk -F'|' '\$1==\"ready\"||\$1==\"executing\"||\$1==\"in-review\"{print (\$3==\"\"?\"(none)\":\$3)}' /tmp/lanes-05688.tmp | sort | uniq -c; echo next_actor_claude_not_done:; awk -F'|' '\$1!=\"done\" && \$2==\"claude\"{print \$1}' /tmp/lanes-05688.tmp | sort | uniq -c; rm -f /tmp/lanes-05688.tmp"
echo "## AC-4 GitHub commit authors, last 30 days (addresses masked)"
run "git log --since=2026-10-12 --format='%an <%ae>' origin/main | sort | uniq -c | sort -rn"
echo "## AC-4 claim refs, driver heartbeats (GitHub REST GET)"
run "for r in vitana-platform vitana-v1; do for p in collab-claim collab-driver; do echo \"\$r \$p \$(gh api --paginate repos/exafyltd/\$r/git/matching-refs/heads/\$p/ --jq '.[].ref' | wc -l)\"; done; done"
run "for r in vitana-platform vitana-v1; do gh api --paginate repos/exafyltd/\$r/git/matching-refs/heads/collab-driver/ --jq '.[].object.sha' | while read s; do gh api repos/exafyltd/\$r/commits/\$s --jq '.commit.committer.date + \" \" + ((.commit.message | capture(\"Collab-Session: *(?<s>[^\\\\s]+)\").s) // \"none\")'; done; done | sort > /tmp/hb-05688.tmp; echo tips=\$(wc -l < /tmp/hb-05688.tmp) newest=\$(tail -1 /tmp/hb-05688.tmp); awk '{s=\$2; if (s ~ /^kiro-[0-9]/) s=\"kiro-<no seat>\"; else sub(/-[0-9]{12}-.*/,\"\",s); print s}' /tmp/hb-05688.tmp | sort | uniq -c | sort -rn; rm -f /tmp/hb-05688.tmp; date -u +now=%FT%TZ"
echo "## AC-4 sessions on PR heads updated since 2026-11-09 (GitHub REST GET)"
run "for r in vitana-platform vitana-v1; do gh api \"repos/exafyltd/\$r/pulls?state=all&sort=updated&direction=desc&per_page=40\" --jq '.[] | select(.updated_at >= \"2026-11-09\") | \"\\(.number) \\(.head.sha)\"' | while read n s; do echo \"\$r #\$n \$(gh api repos/exafyltd/\$r/commits/\$s --jq '.commit.committer.date + \" \" + ((.commit.message | capture(\"Collab-Session: *(?<s>[^\\\\s]+)\").s) // \"none\")')\"; done; done | awk '{print \$1, \$4}' | sed -E 's/ (kiro-[a-z]+-[0-9]{12}-[0-9a-f]{4})\$/ \\1/' | sort | uniq -c | sort -rn"
echo "## AC-4 Claude Code status"
run "grep -n 'Claude Code is retired' CLAUDE.md .kiro/steering/vitana-owner-autonomy.md .kiro/pipeline/common-rules.md .claude/rules/collaboration.md; git -C $V1 grep -n 'Claude Code is retired' $V1PIN -- CLAUDE.md"
run "git log -1 --format='%h %cI %s' 7fd4106862"
run "gh api repos/exafyltd/vitana-platform/actions/variables/CLAUDE_AVAILABLE"
echo "## AC-4 GitLab identities (strategy evidence EV-089, GitLab not called)"
run "git -C $STRAT show $STRATPIN:11-EVIDENCE/evidence-register.md | sed -n 93p | cut -c1-420"
echo "## AC-6 proposed wording blocks"
run "grep -n '^\\*\\*P[1-4]\\.' $D"
echo "## AC-8 collab tests and preflight"
run "node --test scripts/collab/*.test.mjs 2>&1 | tail -8"
run "node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/strategy-execution-wave1/delivery-capacity --title 'VTID-05688 (strategy-execution-wave1/delivery-capacity): delivery capacity inventory' --no-tests"
