#!/bin/bash
# VTID-05554 (agentic-delivery/reseat) positive proof: after this lane lands, lane prerequisites (#4690) can take
# main and Lane scope still passes for its builder's lane-file commits (session kiro-exafy-202611050324-2956, seat exafy).
# Scratch only: detached worktrees outside the repo, local commits that are never pushed, removed at the end.
#   control: merge origin/main as it is today (seat exafyltd, no reseat) into #4690's head.
#   lane:    squash this PR's tree onto origin/main as GitHub would (S), then merge S into #4690's head.
# The lane-file conflict is resolved as the builder would: #4690's front matter with the merged seat (git's 3-way
# result: #4690 never changed the seat, so main's side wins), log = main-side entries, then #4690's entries, each once.
# Usage: positive-proof.sh control|lane <origin/main sha> <#4690 head sha> [<this PR's head sha> (lane mode)]
set -u
MODE=${1:?control|lane}
MAIN=${2:?origin/main sha}
PREREQ=${3:?#4690 head sha}
PRHEAD=${4:-}
P=/projects/sandbox/vitana-platform
Q=/projects/sandbox/.rv/reseat/scripts/collab/queue.mjs
S_WT=/projects/sandbox/.scratch/reseat/wt-squash
M_WT=/projects/sandbox/.scratch/reseat/wt-merge-$MODE
F=.kiro/specs/agentic-delivery/lanes/prerequisites.md
BUILDER=kiro-exafy-202611050324-2956
export GIT_AUTHOR_NAME='kiro-agent[bot]' GIT_COMMITTER_NAME='kiro-agent[bot]'
export GIT_AUTHOR_EMAIL='245459735+kiro-agent[bot]@users.noreply.github.com' GIT_COMMITTER_EMAIL='245459735+kiro-agent[bot]@users.noreply.github.com'
check() { echo "\$ node queue.mjs $*"; node "$Q" "$@" > /tmp/reseat-out.$$ 2>&1; rc=$?; sed '/<details>/,$d' /tmp/reseat-out.$$ | sed '/^$/d'; echo "[exit $rc]"; echo; rm -f /tmp/reseat-out.$$; }

echo "mode $MODE; origin/main $MAIN; #4690 head $PREREQ${PRHEAD:+; this PR head $PRHEAD}"
if [ "$MODE" = lane ]; then
  [ -n "$PRHEAD" ] || { echo "lane mode needs this PR's head"; exit 2; }
  git -C "$P" worktree remove --force "$S_WT" 2>/dev/null
  git -C "$P" worktree add -q --detach "$S_WT" "$MAIN"
  git -C "$S_WT" merge -q --squash "$PRHEAD" || { echo "squash of $PRHEAD onto origin/main failed"; exit 1; }
  git -C "$S_WT" commit -q -m "scratch: squash of this PR (VTID-05554) onto origin/main, as GitHub would"
  THEIRS=$(git -C "$S_WT" rev-parse HEAD)
  echo "squash S = $THEIRS (parent $MAIN); S differs from origin/main in $(git -C "$S_WT" diff --name-only "$MAIN" "$THEIRS" | wc -l) files:"
  git -C "$S_WT" diff --name-only "$MAIN" "$THEIRS" | sed 's/^/  /'
  git -C "$P" worktree remove --force "$S_WT"
else
  THEIRS=$MAIN
fi
echo "main side of the merge: $THEIRS ($(git -C "$P" show "$THEIRS:$F" | grep '^seat:'))"
echo

git -C "$P" worktree remove --force "$M_WT" 2>/dev/null
git -C "$P" worktree add -q --detach "$M_WT" "$PREREQ"
cd "$M_WT" || exit 1
echo "\$ git merge --no-ff --no-commit $THEIRS   (in a scratch worktree of #4690's head)"
git merge --no-ff --no-commit "$THEIRS" > /tmp/reseat-merge.$$ 2>&1; echo "[exit $?]"; grep -E '^(CONFLICT|Auto-merging)' /tmp/reseat-merge.$$; rm -f /tmp/reseat-merge.$$
UNMERGED=$(git diff --name-only --diff-filter=U)
echo "unmerged files: ${UNMERGED:-none}"
for u in $UNMERGED; do [ "$u" = "$F" ] || { echo "unexpected conflict in $u: stop"; exit 1; }; done
# Resolve the lane file: #4690's front matter with the merged seat; main-side log, then #4690's entries, each once.
git show "$PREREQ:$F" > /tmp/reseat-ours.$$
git show "$THEIRS:$F" > /tmp/reseat-theirs.$$
node - /tmp/reseat-ours.$$ /tmp/reseat-theirs.$$ "$F" <<'JS'
const fs = require('fs');
const [ours, theirs, out] = process.argv.slice(2).map((p, i) => (i < 2 ? fs.readFileSync(p, 'utf8') : p));
const split = (t) => { const m = /^(---\n[\s\S]*?\n---\n)([\s\S]*?)(^## Log[ \t]*\n[\s\S]*)$/m.exec(t); if (!m) throw new Error('unexpected lane file shape'); return { fm: m[1], body: m[2], log: m[3] }; };
const o = split(ours); const t = split(theirs);
const seat = /^seat: .*$/m.exec(t.fm)[0];
const fm = o.fm.replace(/^seat: .*$/m, seat);
const entries = (log) => { const out = []; for (const line of log.split('\n').slice(1)) { if (line.startsWith('### ')) out.push([line]); else if (out.length) out[out.length - 1].push(line); } return out; };
const have = new Set(entries(t.log).map((e) => e[0]));
const add = entries(o.log).filter((e) => !have.has(e[0])).map((e) => e.join('\n').replace(/\n+$/, ''));
const log = `${t.log.replace(/\n+$/, '')}\n${add.map((e) => `\n${e}`).join('\n')}\n`;
fs.writeFileSync(out, fm + o.body + log);
console.log(`resolved ${out}: front matter from #4690 with "${seat}"; log = ${entries(t.log).length} main-side entries, then ${add.length} #4690 entries (${add.map((e) => e.split('\n')[0].slice(4, 21)).join(', ')})`);
JS
rm -f /tmp/reseat-ours.$$ /tmp/reseat-theirs.$$
git add "$F"
git commit -q -F - <<MSG
scratch: merge main into lane prerequisites ($MODE)

Collab-Session: $BUILDER
Collab-Lane: agentic-delivery/prerequisites
MSG
M=$(git rev-parse HEAD)
echo "trial merge M = $M (parents $(git rev-parse HEAD^1 | cut -c1-10) #4690, $(git rev-parse HEAD^2 | cut -c1-10) main side)"
echo "resolved front matter seat: $(grep '^seat:' $F); state: $(grep '^state:' $F | cut -d' ' -f2); claimed_by: $(grep '^claimed_by:' $F | cut -d' ' -f2)"
echo "lane-file commits the checks judge ($THEIRS..M, merges excluded as queue.mjs does):"
git log --no-merges --format='  %h %(trailers:key=Collab-Session,valueonly,separator=%x2C) %(trailers:key=Collab-Lane,valueonly,separator=%x2C) %s' "$THEIRS..$M" -- "$F"
echo "\$ git diff <main side> M -- $F   (the resolved lane file against the main side)"
git diff "$THEIRS" "$M" -- "$F"
echo
check scope-check --repo . --base "$THEIRS" --head "$M" --branch kiro/agentic-delivery/prerequisites
check validate --repo . --base "$THEIRS" --head "$M" --branch kiro/agentic-delivery/prerequisites
cd /projects/sandbox || exit 1
git -C "$P" worktree remove --force "$M_WT" && echo "scratch worktrees removed; no branch was created and nothing was pushed"
