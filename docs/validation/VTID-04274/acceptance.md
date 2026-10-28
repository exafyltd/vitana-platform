# VTID-04274 — Dev Autopilot finding dedup excludes activated findings

## Report

Investigated the platform owner's question directly: "does every new
finding get processed, and does the backlog ever converge to zero, on an
ongoing basis, not just today's batch?" Root-caused a real, confirmed
duplication bug while verifying this.

Live evidence: `autopilot_recommendations` rows `9e1bdb97-d4ec-449d-a00b-
5ec70428cada` (status `activated`, VTID-04250, created 2026-09-21 15:21:19)
and `7a93bca4-d753-428d-a24e-229c164df723` (status `new`, VTID-04261,
created 2026-09-22 12:22:02 — ~21 hours later) share the **identical**
`signal_fingerprint` (`42c32f9e7e689576`). The same underlying npm-audit
signal spawned a second, fully duplicate finding — with its own VTID and
its own agent-executor run — while the first was still being worked.

Root cause: both dedup lookups in this codebase — `ingestScan()` in
`services/dev-autopilot-synthesis.ts` (the main scan pipeline) and the
`/impact-ingest` handler in `routes/dev-autopilot.ts` (the companion
impact-findings pipeline) — queried for an existing live finding with
`status=in.(new,snoozed)`, which **excludes `activated`**. A finding that
already has a VTID and an in-flight execution is exactly the state that
happened here (`9e1bdb97` was `activated` when the next scan ran), and it
is still the *same* live problem, not a resolved one — so the lookup
missed it and a fresh row was inserted instead of bumping `seen_count`/
`last_seen_at` on the existing one.

This is the concrete, confirmed answer to "does a recurring finding ever
converge to zero, or does it keep spawning duplicates while being worked":
before this fix, it could spawn a duplicate on every scan that ran while
the original was still `activated` — real backlog growth with no bound,
independent of whether the fix itself ever lands.

## Fix

Both dedup lookups now filter `status=in.(new,snoozed,activated)`.
Deliberately does **not** add `completed`/`rejected`/`auto_archived` —
those are genuinely terminal; if the identical signal reappears after a
finding is closed, that is either a real regression (worth a fresh
finding) or a coincidental fingerprint collision, not something to
silently re-merge into an already-closed record.

## Acceptance Criteria

AC-1 — `ingestScan()`'s dedup GET query includes `activated` alongside
`new`/`snoozed`.
TEST: services/gateway/test/dev-autopilot-synthesis.test.ts

AC-2 — `ingestScan()` bumps `seen_count` on an existing `activated`
finding instead of inserting a duplicate.
TEST: services/gateway/test/dev-autopilot-synthesis.test.ts

AC-3 — `ingestScan()` still inserts a new finding when no live match
(new/snoozed/activated) exists at all — the widened filter does not
suppress genuinely new findings.
TEST: services/gateway/test/dev-autopilot-synthesis.test.ts

AC-4 — the `/impact-ingest` route's dedup lookup includes `activated`
alongside `new`/`snoozed`, and correctly bumps `seen_count` on such a row.
TEST: services/gateway/test/routes/dev-autopilot.test.ts

## Route evidence

No route is added, removed, or mounted — `/impact-ingest` (`POST
/api/v1/dev-autopilot/impact-ingest`) already exists and is unchanged;
only its dedup query's status filter changed. The Route Mount Evidence
Gate does not apply.

## Live remediation

The two live duplicate rows this bug produced were closed directly from
this session (see `commands.log`): `9e1bdb97` and `7a93bca4` are both now
`status='completed'` (their underlying npm-audit findings were separately
fixed — see VTID-04272 and VTID-04261's own evidence packs — this VTID
fixes the mechanism that let the duplicate happen, not those two findings'
content).

## Not yet independently confirmed live

The next scheduled scan (cron `0 7,19 * * *`) while a `dev_autopilot`
finding is `status='activated'` is the real exercise: `seen_count`/
`last_seen_at` should advance on the existing row and no second VTID
should be allocated for the same `signal_fingerprint`.
