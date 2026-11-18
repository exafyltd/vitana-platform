---
change_class: standard
---
# Plan: lane handoff between Kiro seats and Claude Code, both directions

change class: standard (governance docs and collab tooling)
scope:
- `vitana-v1/.claude/rules/collaboration.md` §3a (lane fields, executor), §7 (building and accepting).
- `vitana-v1/.kiro/steering/vitana-owner-autonomy.md`: no change expected; checked for consistency only.
- `vitana-platform/scripts/collab/queue.mjs` and its tests: accept a Claude builder on a lane whose `executor` was
  handed off, and a Kiro builder on a lane handed back. `scripts/collab/protected-gate-files.json` lists `queue.mjs`, so the
  change needs a Claude review on the current head or an owner instruction naming this plan (owner instruction given
  2026-11-14, to be cited in the PR).
- No change to the reviewer rule: a builder never accepts its own lane, and a lane's reviewer is never its seat.

<!-- plan:begin -->
## Problem
A lane's `executor` (`kiro` or `claude`, collaboration.md §3a) is set when the lane is created. §3a says a Kiro lane is
built by its seat, and §7 routes `executor: claude` lanes to Claude Code when it is available, else to the exceptions
seat `exafyltd` (§7, routing override). The routing override does not change the `executor` field. Nothing lets a lane
move between executors deliberately, in either direction, while it is in progress.

Lane administration (`lane_admin`, kiro-lane-admin) is a separate mechanism: a trusted admin lane changes the permission
fields of a TARGET lane through a reviewed PR; a lane never administers its own file (round 1, R1-F3; queue.mjs scopeCheck
comment). The executor transfer is a new, self-transfer carve-out. It does not extend `lane_admin`, and the reseat lane
(PR #4703) is cited only as the existing admin precedent, not as a model for the transfer.

## Change
1. **Two mechanisms, kept apart.**
   a. *Routing override (unchanged):* when Claude is unavailable, §7 sends a `claude` lane to the exceptions seat. The
      `executor` field stays `claude`; the log records the override. Nothing in this plan changes it.
   b. *Executor transfer (new):* a deliberate change of the `executor` field, from `kiro` to `claude` or back, by a
      builder or the owner. Call it an **executor transfer**, not a handoff, so it does not collide with the CI check
      "Collab handoff" (F6).
2. **Transfer sequence (exact).** While still holding `claimed_by`, the current builder commits one commit on the lane's
   branch that (i) sets `executor` to the new value, (ii) sets `next_actor` to the same value (or `owner`), (iii) adds
   the log entry `transfer: <from>→<to>, by <session id>, reason <text>, at <ISO time>`. The commit is pushed, then the
   builder releases `claimed_by`. The target executor claims the lane under §3a. A session without the claim never
   edits the lane file (collaboration.md §5, "Claim before you touch anything", line 164), so the step order above is the only valid one.
3. **Seat.** `seat` is kept for attribution and is not changed by a transfer. A transfer to `claude` does not need a Kiro
   seat; a transfer back to `kiro` keeps the original seat.
4. **Branch name stays** as created (`<kiro|claude>/<slug>/<lane-id>`). The trailers `Collab-Session` and `Collab-Lane`
   identify the session and the lane, so no rename is needed.
5. **Reviewer rule unchanged.** A builder never accepts a lane it built or transferred. The reviewer agent accepts on the
   current head.
6. **queue.mjs, both enforcement points (round 1, R1-F1, R1-F2).**
   a. *Collab handoff (`validate`):* accepts a claim by a session of the new executor only when the latest `transfer:` entry
      names that executor and its `next_actor` matches. Without that entry the current refusal stays.
   b. *Lane scope (`scopeCheck`):* a change to `executor` and `next_actor` in the lane file is allowed only when the same
      commit range holds a `transfer:` entry committed by the claim holder. The carve-out covers those two fields only;
      `paths`, `seat`, `reviewer_seat` and every other permission field stay refused.
   c. *Multi-builder seat check (`validateRange`):* after a transfer entry, a builder session of the new executor is accepted
      on the same PR. Sessions before the transfer keep the lane's seat rule, so a Claude session cannot appear on a kiro lane
      without the transfer.
7. **Tests first.** `scripts/collab/queue.test.mjs`: (a) a `kiro` lane with a `claude` transfer accepts a Claude claim;
   (b) without the transfer entry the claim is refused; (c) a transfer by a session that does not hold the claim is refused;
   (d) a transfer back to `kiro` works the same way; (e) the reviewer check still refuses a builder accepting its own lane;
   (f) the routing override (§7) still validates with `executor` unchanged;
   (g) `scopeCheck`: a lane with a `transfer:` entry and a changed `executor` passes Lane scope;
   (h) `scopeCheck`: a changed `executor` without a transfer entry is rejected by Lane scope;
   (i) `scopeCheck`: a transfer entry not committed by the claim holder is rejected by Lane scope;
   (j) `validateRange`: a PR with pre-transfer kiro sessions and post-transfer Claude sessions passes the seat check, and the same
   PR without the transfer entry fails it.
   Recorded red on `origin/main` before the change.
8. **Rollback.** Revert the commit. Lanes that were transferred keep `executor` as transferred and their `transfer:` entries.
   The reverted `queue.mjs` must accept any `executor` value without a transfer check; verify this against the code before
   the rollback is used (F7).

## Cross-repo sync (F1)
`.claude/rules/collaboration.md` says it is identical in `vitana-platform` and `vitana-v1`, and the Kiro twin in vitana-v1
(`.kiro/steering/vitana-collaboration.md`) is a pointer to the vitana-v1 file. The change lands as a linked pair: the
vitana-v1 copy and the vitana-platform copy, in the same PR window, with vitana-v1 authoritative for the text and
vitana-platform's `queue.mjs` change in its own PR. Both PRs cite the other.

## Not in scope
- Changing which seat owns an area (`areas.yaml`).
- Changing the reviewer agent or its model chain.
- Changing the protected gate list.
- Any GitLab or GitHub setting, token or access change.

## Problem 2 (identity, for the owner)
This session authenticates to GitLab as the `root` administrator. A dedicated bot account with Maintainer on
`vitana/vitana-platform` and `vitana/vitana-v1` is the recommended replacement. Owner decision; not changed by this plan.

## Verification of the change
- `node --test scripts/collab/` green; the new cases red before the change.
- Dry run: a fixture lane transferred `kiro` to `claude` and back; `queue.mjs validate` passes at each step and refuses
  the claim without the transfer entry.
- `git diff --stat`: only the files in scope change, in both repos.
<!-- plan:end -->

## Planner responses (round 1)
- **F1 cross-repo sync (major) — ACCEPTED.** Linked pair; vitana-v1 authoritative for the text (see Cross-repo sync).
- **F2 routing override vs field change (major) — ACCEPTED.** Two mechanisms kept apart; the override does not change `executor` (Change 1a).
- **F3 handoff sequence contradiction (major) — ACCEPTED.** Exact sequence: commit while holding the claim, push, release, target claims (Change 2).
- **F4 next_actor and seat (minor) — ACCEPTED.** `next_actor` set in the transfer commit; `seat` kept (Change 2, 3).
- **F5 branch naming (minor) — ACCEPTED.** Branch name stays (Change 4).
- **F6 "Collab handoff" name collision (minor) — ACCEPTED.** Renamed to "executor transfer" throughout.
- **F7 rollback orphaned state (minor) — ACCEPTED, verify before use.** Rollback step now requires the reverted queue.mjs to accept any executor value; verification stated.
- **F8 "reseat" premise (minor) — PARTLY REJECTED.** The reference is real in vitana-platform: lane `reseat` (agentic-delivery, `lane_admin: true`, done, PR #4703) changed the `seat` field of eight lanes. Cited in the Problem section. The partner's grep covered vitana-v1 only.
