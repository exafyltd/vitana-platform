# Requirements — kiro-lane-admin

Owner authorization (2026-10-29, this conversation, Kiro Web seat `jtadic`). Verbatim intent: update the obsolete
Claude-only governance rule so authorized Kiro sessions can perform lane administration through a reviewed, auditable
process; update steering, documentation AND enforcement consistently; preserve seat ownership, scope checks and
independent review; Claude Code is retired — do not route governance changes to Claude.

## R1 — A reviewed, auditable Kiro lane-administration path
As the platform owner, I want an authorized Kiro session to reassign a lane's `seat` and add/narrow its `paths`
through a reviewed process, so that lane administration no longer depends on the retired Claude Code.
- A lane-administration change is permitted only from an `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`
  lane carrying `lane_admin: true`, and only when that lane's permissions come from a trusted source (merge-base, a
  qualifying open `plan(` PR, or the other repo's main).
- The change is auditable: it is in a lane PR reviewed by the independent reviewer agent, recorded in the lane log.

## R2 — Preserve seat ownership
A session must still be unable to silently edit another seat's lane outside the reviewed lane-admin path. The existing
seat-ownership refusal keeps working for ordinary lanes; only a `lane_admin` lane legitimately reassigns `seat`.

## R3 — Preserve scope checks
Narrow `paths` stay enforced. The lane-admin lane must declare the target lane file(s) in its own `paths`; the target
lane's narrowed `paths` are enforced on the target lane's own PRs.

## R4 — Preserve independent review
`lane_admin: true` requires `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer`; a builder never accepts its
own admin lane.

## R5 — Protected gate files stay owner-gated, Claude removed
A protected gate file never merges on a reviewer-agent accept alone. With Claude Code retired, the surviving authority
is the owner's instruction naming the plan plus a reviewer-agent accept on the current head. The "legacy claude review"
option is removed from enforcement, the JSON description, the PM mirror and every rule/steering/doc file, consistently.
A `lane_admin` lane never unlocks a protected gate file.

## R6 — Consistency across enforcement, docs, steering
The enforcement (`queue.mjs`, `protected-gate-files.json`, `governance.ts`) and the human-facing rules
(`collaboration.md`, `CLAUDE.md` in both repos, `common-rules.md`, `vitana-owner-autonomy.md`) all say the same thing.
Byte-identical files stay byte-identical (platform/vitana-v1 `CLAUDE.md`; JSON globs ↔ builtin list).

## R7 — Unblock VTID-05207 against the updated base
This governance change lands first and separately. Once on `main`, lane `say-hello-composer` (VTID-05207) can be
reassigned to seat `jtadic` with accurate narrow `paths` through the new lane-admin mechanism and re-validated against
the updated base revision. (The reassignment itself is the owner's authorized follow-up, not part of this plan's code.)

## Non-goals
- No change to the feature implementation (VTID-05207 code is done and untouched here).
- No migration; no live-system writes; no production deploy.
- No revival or edit of the dormant `retire-claude-code` spec.
