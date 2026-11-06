#!/bin/bash
# VTID-05563 (agentic-delivery/nav-paths): positive and negative proof for lane gateway-delivery's four extra paths.
# Scratch only: detached worktrees under /projects/sandbox/.scratch/navp/ (no branch ref), local commits that are never
# pushed, removed at the end.
# The commit under test (C) is the change lane gateway-delivery needs outside its old paths, with
#   Collab-Session: kiro-exafy-202611021438-cff7 (seat exafy, the session that holds the gateway-delivery claim)
#   Collab-Lane:    agentic-delivery/gateway-delivery
# It changes exactly the four files: command-hub-screens.json and command-hub-ownership-guard.js through the builder's
# own patch (docs/validation/VTID-05547/outputs/outside-lane-paths.patch at kiro/backup/gateway-delivery 594ab32a51), and
# placeholder bytes in nav-embeddings.bin/.json (the real vectors come from one Bedrock call run by the owner or by CI,
# never from a session; Lane scope reads only the changed paths).
#   negative: C on today's origin/main                                        → Lane scope must refuse it.
#   positive: C on S = this PR's tree squashed onto origin/main, as GitHub would → Lane scope must pass it;
#             control on S: the same change under another lane (agentic-delivery/cutover) → still refused.
# Usage: nav-paths-proof.sh negative <origin/main sha> | nav-paths-proof.sh positive <origin/main sha> <this PR's head sha>
set -u
MODE=${1:?negative|positive}
MAIN=${2:?origin/main sha}
PRHEAD=${3:-}
P=/projects/sandbox/vitana-platform
W=/projects/sandbox/.scratch/navp/wt-$MODE
BACKUP=594ab32a511cd183496db5c78333571ecbaefbc0
BUILDER=kiro-exafy-202611021438-cff7
D=services/gateway/src/navigation/data
export GIT_AUTHOR_NAME='kiro-agent[bot]' GIT_COMMITTER_NAME='kiro-agent[bot]'
export GIT_AUTHOR_EMAIL='245459735+kiro-agent[bot]@users.noreply.github.com' GIT_COMMITTER_EMAIL='245459735+kiro-agent[bot]@users.noreply.github.com'
# validate prints the whole queue table after its verdict; keep the verdict lines only.
check() { echo "\$ node scripts/collab/queue.mjs $*"; node scripts/collab/queue.mjs "$@" > /tmp/navp-out.$$ 2>&1; rc=$?; sed '/<details>/,$d' /tmp/navp-out.$$ | sed '/^$/d'; echo "[exit $rc]"; echo; rm -f /tmp/navp-out.$$; }
# The four-file change of lane gateway-delivery, committed under the lane named in $1.
four_file_commit() {
  git show "$BACKUP:docs/validation/VTID-05547/outputs/outside-lane-paths.patch" > /tmp/navp-patch.$$
  git apply /tmp/navp-patch.$$ || { echo "patch does not apply: stop"; exit 1; }
  rm -f /tmp/navp-patch.$$
  head -c 2048 /dev/zero >> $D/nav-embeddings.bin   # placeholder: one zero 512-dim float32 vector
  printf '\n' >> $D/nav-embeddings.json             # placeholder: trailing newline
  git add $D/command-hub-screens.json $D/nav-embeddings.bin $D/nav-embeddings.json scripts/ci/command-hub-ownership-guard.js
  git commit -q -F - <<MSG
scratch: the four files lane gateway-delivery needs (never pushed)

Collab-Session: $BUILDER
Collab-Lane: $1
MSG
  echo "commit $(git rev-parse HEAD) (parent $(git rev-parse HEAD^ | cut -c1-10)), Collab-Lane $1, Collab-Session $BUILDER:"
  git diff --numstat HEAD^ HEAD | sed 's/^/  /'
  echo "  patch-id $(git diff --binary HEAD^ HEAD | git patch-id --stable | cut -c1-16); sha256(diff --binary) $(git diff --binary HEAD^ HEAD | sha256sum | cut -c1-16)"
}

echo "mode $MODE; origin/main $MAIN${PRHEAD:+; this PR head $PRHEAD}; gateway-delivery builder patch from $BACKUP"
git -C "$P" worktree remove --force "$W" 2>/dev/null
mkdir -p "$(dirname "$W")"
git -C "$P" worktree add -q --detach "$W" "$MAIN"
cd "$W" || exit 1
L=.kiro/specs/agentic-delivery/lanes/gateway-delivery.md
if [ "$MODE" = positive ]; then
  [ -n "$PRHEAD" ] || { echo "positive mode needs this PR's head"; exit 2; }
  git merge -q --squash "$PRHEAD" || { echo "squash of $PRHEAD onto origin/main failed"; exit 1; }
  git commit -q -m "scratch: squash of this PR (VTID-05563) onto origin/main, as GitHub would"
  echo "squash S = $(git rev-parse HEAD) (parent $MAIN); S differs from origin/main in:"
  git diff --name-only "$MAIN" HEAD | sed 's/^/  /'
fi
BASE=$(git rev-parse HEAD)
echo "base $BASE: lane gateway-delivery paths on the base ($(grep -c '^  - ' $L) entries; the four files listed: $(grep -cE '^  - (services/gateway/src/navigation/data/(command-hub-screens\.json|nav-embeddings\.bin|nav-embeddings\.json)|scripts/ci/command-hub-ownership-guard\.js)$' $L))"
echo
echo "################ $MODE: lane gateway-delivery changes the four files ################"
four_file_commit agentic-delivery/gateway-delivery
echo
check scope-check --repo . --base "$BASE" --head HEAD --branch kiro/agentic-delivery/gateway-delivery
check validate --repo . --base "$BASE" --head HEAD --branch kiro/agentic-delivery/gateway-delivery
if [ "$MODE" = positive ]; then
  echo "################ control on the same base S: another lane (agentic-delivery/cutover) makes the same change ################"
  git checkout -q --detach "$BASE"
  four_file_commit agentic-delivery/cutover
  echo
  check scope-check --repo . --base "$BASE" --head HEAD --branch kiro/agentic-delivery/cutover
fi
cd /projects/sandbox || exit 1
git -C "$P" worktree remove --force "$W" && echo "scratch worktree removed; no branch was created and nothing was pushed"
