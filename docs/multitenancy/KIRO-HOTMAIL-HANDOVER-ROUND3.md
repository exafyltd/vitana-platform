# Handover to a fresh Kiro session (seat hotmail): continue the multi-tenant M0 build

Read this file in full before doing anything. It is the handover from the previous hotmail session, which ran
the M0 streams and got stuck at the GitHub merge step. It replaces that session's chat. Nothing in the chat is
available to you.

Repo: `exafyltd/vitana-platform`. Branch: `claude/youthful-cannon-vzsnio` (not `main`). Plan: `docs/MULTI-TENANT-PLAN.md`
§7 (M0). Directive from 2026-11-10: `docs/multitenancy/KIRO-HOTMAIL-DIRECTIVE-M0.md` (PR #4919, draft). Rules:
`.claude/rules/collaboration.md` §3a, §5, §7, §7a, §7b, §8a.

## Where things stand (checked 2026-11-10)
- Main's last merge is #4714 (2026-11-08 18:27Z). Merges into main have returned HTTP 405 since, even on PRs that
  show checks green. The cause is not known. Do not retry merges in a loop, and never use `--admin`.
- Done and merged: VTID-05576, 05575, 05569, 05506, 05573, 05579, 05609/05610/05611, 05504, 05520, 05445, 05673,
  05446, 05491, 05493.
- Track S: VTID-05452 and VTID-05453 are superseded by v2 lanes VTID-05528 (ec7f45ccb7) and VTID-05529 (29b639da4b),
  both already on main. Owner decision 2026-11-10: close both v1 lanes as superseded. Do not move or build them.
- Lane VTID-05676 (`queue.mjs` superseded-close, plan `mt-queue-superseded-close`, PR #4920): protected gate file,
  so `executor: claude`. Owner decision 2026-11-10: the exafyltd exceptions seat builds it. Do not build it, do not
  push more commits to its branch, do not merge #4920.
- Seat move (plan `mt-guardrails-r2`, `seat-move`, PR #4935): approved. Merge under §7b once the merge block clears.
- Six migrations are held, and the owner must approve each with its behaviour change before any apply:
  050200 (breaks writers that send no scope), 052300 (drops tables still read by v1 and the gateway), 053200 (narrows
  Find-a-Match), 070350 (changes `switch_to_tenant_by_slug`), 141000 (changes provisioning), 05491 (adds triggers).
  No migration is applied. Nothing has gone to production.
- Dispatching a workflow outside §7d is not allowed. Re-dispatching failed STAGING-VERIFY runs is not allowed.
- Open PRs from the previous session stay as they are. Do not create new PRs until the merge block clears.

## Your instructions, in order
1. **Check the merge block (read-only).** Use the GitHub tools to read a green PR's `mergeable_state`, its required
   reviews, and any branch protection you can read on `main`. Write what you found into
   `docs/multitenancy/merge-block-findings.md`. Do not try to remove the block.
2. **Stop and report if the block persists.** The owner must clear it. Send one message: what you checked, what it
   shows, and the question "what is blocking merges to main?". Then continue with step 3.
3. **Keep the work that needs no merge moving.**
   - S2 audit: re-run each listed VTID's suites on current `main` and record one line per VTID in its lane log
     (VTIDs 05576, 05575, 05579, 05573, 05569, 05506, 05504, 05491, 05493). Commit the lines to this branch.
   - S1 owner packets: for migrations in queue rows 12–13 (VTID-05465), rows 17–18 (VTID-05464) and 043000
     (VTID-05569), write `docs/validation/<VTID>/owner-packet.md` with file, target DB, behaviour change, PGlite dry-run
     result, pre-check, post-check, rollback id, and apply window. Include the six held migrations with their
     behaviour changes. Nothing is applied.
   - S3 STAGING-VERIFY: record the result for each recent merge commit. Write "no result yet" where there is none.
4. **When the block clears, merge in this order, one at a time, under §7b:** #4935 (seat move), then the S2 lane-log
   commit, then the S1 packets after review. Each needs a reviewer-agent accept on its current head and green checks.
5. **Report** (one message, every 4 hours while work runs): the merge-block status, a stream table, and the M0 table
   from `docs/MULTI-TENANT-PLAN.md` §7.

## Do not
- Retry merges in a loop, use `--admin`, or override a red check.
- Build, push to, or merge the `queue.mjs` lane (VTID-05676, PR #4920).
- Move or build the Track S v1 lanes.
- Dispatch any workflow outside §7d, apply any migration, or send any request to production.
- Create new PRs until the merge block clears.
