#!/bin/bash
set -u
P=/projects/sandbox/vitana-platform
W=/projects/sandbox/.ev/scratch
PR_HEAD=6f3524f775
export GIT_AUTHOR_NAME="kiro-agent[bot]" GIT_COMMITTER_NAME="kiro-agent[bot]"
export GIT_AUTHOR_EMAIL="245459735+kiro-agent[bot]@users.noreply.github.com"; export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
cd $P
git worktree remove --force $W 2>/dev/null
git branch -D scratch/neg-base scratch/neg-a1 scratch/neg-a2 scratch/neg-b scratch/neg-base2 scratch/neg-a3 >/dev/null 2>&1
git worktree add -q -b scratch/neg-base $W origin/main
cd $W
ADM=.kiro/specs/say-hello-lane-reassign/lanes/reassign.md
T1=.kiro/specs/new-member-welcome/lanes/say-hello-composer.md
T2=.kiro/specs/new-member-welcome/lanes/new-member-card-optin.md
T3=.kiro/specs/new-member-welcome/lanes/grouped-welcome-notifications.md
CLI="node $P/scripts/collab/queue.mjs"
run() { echo "\$ $*"; "$@"; echo "[exit $?]"; echo; }

echo "################ (b) seat ownership BEFORE reassignment ################"
git checkout -q -b scratch/neg-b origin/main
echo "base (origin/main) lane seat: $(grep '^seat:' $T1)"
printf '\n### 2026-10-29T18:00Z · kiro-jtadic-202610291040-a0e6 · note\nScratch edit by seat jtadic before reassignment.\n' >> $T1
git add $T1
git commit -q -F - <<MSG
scratch: seat jtadic edits say-hello-composer before reassignment

Collab-Session: kiro-jtadic-202610291040-a0e6
Collab-Lane: new-member-welcome/say-hello-composer
MSG
run $CLI scope-check --base origin/main --head HEAD --repo . --branch kiro/new-member-welcome/say-hello-composer
run $CLI validate --base origin/main --head HEAD --repo . --branch kiro/new-member-welcome/say-hello-composer

echo "################ (a1) same PERM edit, lane WITHOUT lane_admin ################"
git checkout -q -b scratch/neg-base2 origin/main
sed -i '/^lane_admin: true$/d' $ADM
git add $ADM
git commit -q -m "scratch base: ordinary lane (lane_admin removed)"
BASE=$(git rev-parse HEAD)
echo "base lane file has lane_admin: $(grep -c '^lane_admin' $ADM)"
git checkout -q -b scratch/neg-a1
git checkout $PR_HEAD -- $T1 $T2 $T3
git commit -q -F - <<MSG
scratch: PERM edit from ordinary lane

Collab-Session: kiro-jtadic-202610291040-a0e6
Collab-Lane: say-hello-lane-reassign/reassign
MSG
run $CLI scope-check --base $BASE --head HEAD --repo . --branch kiro/say-hello-lane-reassign/reassign
run $CLI validate --base $BASE --head HEAD --repo . --branch kiro/say-hello-lane-reassign/reassign

echo "################ (a2) lane_admin: true written only in the PR head ################"
git checkout -q -b scratch/neg-a2 $BASE
sed -i 's/^executor: kiro$/executor: kiro\nlane_admin: true/' $ADM
echo "head lane file has lane_admin: $(grep -c '^lane_admin' $ADM); base has: $(git show $BASE:$ADM | grep -c '^lane_admin')"
git checkout $PR_HEAD -- $T1 $T2 $T3
git add $ADM
git commit -q -F - <<MSG
scratch: PERM edit with lane_admin self-granted in head

Collab-Session: kiro-jtadic-202610291040-a0e6
Collab-Lane: say-hello-lane-reassign/reassign
MSG
run $CLI scope-check --base $BASE --head HEAD --repo . --branch kiro/say-hello-lane-reassign/reassign
run $CLI validate --base $BASE --head HEAD --repo . --branch kiro/say-hello-lane-reassign/reassign

echo "################ (a3) PERM edit committed under the TARGET lane's own key (ordinary lane PR, no lane_admin) ################"
git checkout -q -b scratch/neg-a3 origin/main
git checkout $PR_HEAD -- $T1
git commit -q -F - <<MSG
scratch: PERM edit to say-hello-composer from an ordinary lane PR

Collab-Session: kiro-jtadic-202610291040-a0e6
Collab-Lane: new-member-welcome/say-hello-composer
MSG
run $CLI scope-check --base origin/main --head HEAD --repo . --branch kiro/new-member-welcome/say-hello-composer
run $CLI validate --base origin/main --head HEAD --repo . --branch kiro/new-member-welcome/say-hello-composer
