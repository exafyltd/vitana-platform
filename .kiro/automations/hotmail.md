# Kiro Web automation — seat `hotmail` — M0 multi-tenant handover

This file IS the task of the Kiro Web automation for the hotmail seat. The automation's task text in app.kiro.dev is only:

> Read .kiro/automations/hotmail.md in vitana-platform and follow it exactly.

Your area: **multi-tenant M0** (`docs/MULTI-TENANT-PLAN.md` §7). Current work is in
`docs/multitenancy/KIRO-HOTMAIL-HANDOVER-ROUND3.md` and `docs/multitenancy/KIRO-HOTMAIL-FOLLOWUP-01.md`, on branch
`claude/youthful-cannon-vzsnio`. Check that branch out first and read both files before doing anything.

## Every run
1. Find the vitana-platform checkout (`git -C <dir> remote get-url origin` → `…/exafyltd/vitana-platform`).
2. Session id: `node scripts/collab/queue.mjs session-id --agent kiro --seat hotmail`. Use it in every commit trailer
   and PR body of this run.
3. Do **at most one item**: the first open item in `KIRO-HOTMAIL-FOLLOWUP-01.md` that is not yet committed to the
   branch. If none is open, stop. No branch, commit or PR.
4. Commit the item to `claude/youthful-cannon-vzsnio` with a `Collab-Session:` trailer, push, and stop.

## Never
- Merge a PR, or use `--admin`. The merge block on `main` belongs to the owner.
- Touch PR #4920 or lane VTID-05676 (exceptions seat).
- Create a PR, or touch another seat's PRs or lanes.
- Dispatch a workflow outside §7d, apply a migration, or write to production or any live system.

## Report
Append one line per run to `docs/multitenancy/hotmail-run-log.md`: time, session id, item done, what it passed.
