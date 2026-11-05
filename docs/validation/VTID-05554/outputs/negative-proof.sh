#!/bin/bash
# VTID-05554 (agentic-delivery/reseat) negative proof: the same seat edit from a lane WITHOUT lane_admin is refused.
# Scratch only: a detached worktree outside the repo, local commits that are never pushed, removed at the end.
#   N1: lane reseat with `lane_admin: true` removed from its trusted (base) revision makes the eight seat edits.
#   N2: the target lane prerequisites (no lane_admin) makes its own seat edit under its own key, as #4690's builder
#       session would.
# Usage: negative-proof.sh <origin/main sha> <session id of this lane>
set -u
MAIN=${1:?origin/main sha}
SID=${2:?session id}
P=/projects/sandbox/vitana-platform
Q=/projects/sandbox/.rv/reseat/scripts/collab/queue.mjs
W=/projects/sandbox/.scratch/reseat/wt-neg
D=.kiro/specs/agentic-delivery/lanes
TARGETS="prerequisites pipelines deploy-path verify-on-gitlab merge-queue github-bridge gateway-delivery cutover"
export GIT_AUTHOR_NAME='kiro-agent[bot]' GIT_COMMITTER_NAME='kiro-agent[bot]'
export GIT_AUTHOR_EMAIL='245459735+kiro-agent[bot]@users.noreply.github.com' GIT_COMMITTER_EMAIL='245459735+kiro-agent[bot]@users.noreply.github.com'
# validate prints the whole queue table after its verdict; keep the verdict lines only.
check() { echo "\$ node queue.mjs $*"; node "$Q" "$@" > out.txt 2>&1; rc=$?; sed '/<details>/,$d' out.txt | sed '/^$/d'; echo "[exit $rc]"; echo; }
git -C "$P" worktree remove --force "$W" 2>/dev/null
git -C "$P" worktree add -q --detach "$W" "$MAIN"
cd "$W" || exit 1
echo "scratch worktree $W, detached at origin/main $(git rev-parse HEAD) (never pushed)"
echo "origin/main: reseat lane_admin lines=$(grep -c '^lane_admin: true$' $D/reseat.md); prerequisites lane_admin lines=$(grep -c '^lane_admin' $D/prerequisites.md); prerequisites $(grep '^seat:' $D/prerequisites.md)"
echo

echo "################ N1: lane reseat WITHOUT lane_admin (removed in the trusted base) makes the eight seat edits ################"
sed -i '/^lane_admin: true$/d' $D/reseat.md
git add $D/reseat.md
git commit -q -m "scratch base: reseat is an ordinary lane (lane_admin removed)"
B1=$(git rev-parse HEAD)
echo "scratch base $B1: reseat lane_admin lines=$(grep -c '^lane_admin' $D/reseat.md)"
for l in $TARGETS; do sed -i 's/^seat: exafyltd$/seat: exafy/' $D/$l.md; git add $D/$l.md; done
git commit -q -F - <<MSG
scratch: the eight seat edits from lane reseat without lane_admin

Collab-Session: $SID
Collab-Lane: agentic-delivery/reseat
MSG
echo "scratch head $(git rev-parse HEAD): $(git diff --numstat $B1 HEAD | wc -l) files, $(git diff $B1 HEAD | grep -c '^+seat: exafy$') seat lines exafyltd -> exafy"
echo
check scope-check --repo . --base "$B1" --head HEAD --branch kiro/agentic-delivery/reseat
check validate --repo . --base "$B1" --head HEAD --branch kiro/agentic-delivery/reseat

echo "################ N2: target lane prerequisites (no lane_admin) changes its own seat under its own key ################"
git checkout -q --detach "$MAIN"
sed -i 's/^seat: exafyltd$/seat: exafy/' $D/prerequisites.md
git add $D/prerequisites.md
git commit -q -F - <<MSG
scratch: prerequisites changes its own seat in an ordinary lane PR

Collab-Session: kiro-exafy-202611050324-2956
Collab-Lane: agentic-delivery/prerequisites
MSG
echo "scratch head $(git rev-parse HEAD) on origin/main: $(git diff --numstat "$MAIN" HEAD | wc -l) file, seat line exafyltd -> exafy, session kiro-exafy-202611050324-2956 (seat exafy)"
echo
check scope-check --repo . --base "$MAIN" --head HEAD --branch kiro/agentic-delivery/prerequisites
check validate --repo . --base "$MAIN" --head HEAD --branch kiro/agentic-delivery/prerequisites

rm -f out.txt
cd /projects/sandbox || exit 1
git -C "$P" worktree remove --force "$W" && echo "scratch worktree removed; no branch was created and nothing was pushed"
