#!/usr/bin/env bash
# Mutation check for the GitLab operations layer (VTID-05801). Each mutant is a planted defect in a temp copy; the ops test
# suite must fail for every mutant and pass for the unmodified code. Writes nothing into the repository.
set -u
REPO="${1:?usage: mutate-ops.sh <repo root>}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -r "$REPO/scripts/eng" "$WORK/eng"
cd "$WORK/eng" || exit 2
run() { node --test gitlab-ops.test.mjs 2>/dev/null | grep -E '^# fail' | awk '{print $3}'; }
orig="$(run)"; echo "unmodified: fail=$orig (expect 0)"
mutate() { # name, sed expression
  cp gitlab-ops.mjs ops.orig
  sed -i "$2" gitlab-ops.mjs
  if cmp -s gitlab-ops.mjs ops.orig; then echo "$1: MUTANT NOT APPLIED"; cp ops.orig gitlab-ops.mjs; return; fi
  f="$(run)"; echo "$1: fail=$f (expect >0, caught=$([ "${f:-0}" -gt 0 ] && echo yes || echo NO))"
  cp ops.orig gitlab-ops.mjs
}
mutate "head-SHA check removed"           's/  if (mr.sha !== head) throw/  if (false) throw/'
mutate "merge action retried (retries:0 removed)" 's/merge`, { body, retries: 0 })/merge`, { body })/'
mutate "webhook token check removed"      's/if (!crypto.timingSafeEqual(digest(given), digest(secret)) || given.length !== secret.length)/if (false)/'
mutate "create: 409 recovery removed"     's/    if (err instanceof GitLabApiError \&\& err.status === 409) {/    if (false) {/'
echo "restored: fail=$(run) (expect 0)"
