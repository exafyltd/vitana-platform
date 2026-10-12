# F1 — Orphan reaper must not tombstone sparring-bound VTIDs

change class: light (1 source file + 1 test; no migrations/routes/auth/deploy config)
scope: services/gateway/src/services/dev-autopilot-execute.ts (allocatedOrphanReaperTick), services/gateway/test/vtid-03818-reaper-terminal-flag.test.ts (or a new sibling test)

<!-- plan:begin -->
## Problem (observed 2026-10-10)
`allocatedOrphanReaperTick()` (services/gateway/src/services/dev-autopilot-execute.ts ~4248) PATCHes every
`vtid_ledger` row with `status='allocated'`, a placeholder title (`null`, `Allocated - Pending Title`,
`Pending Title`) and `created_at` older than 10 minutes to `status='deleted'`, `is_terminal=true`.
Allocation via the direct `allocate_global_vtid` RPC is a two-step allocate→update; when the second step
is slow or times out, a deliberately allocated VTID is tombstoned. Today VTID-05045 and VTID-05046 —
allocated with `p_sparring_id` + `p_plan_hash` for an owner-approved plan — were reaped at 10:50:29 UTC,
~10 min after allocation, while their title UPDATEs were timing out. Terminal rows must not be modified
(CLAUDE.md IF-THEN 3), so both had to be re-allocated (VTID-05048/05049) and the sparring records now point at
dead VTIDs.

## Fix
1. In the reaper's candidate query, exclude rows whose `metadata` carries a Plan Sparring binding:
   PostgREST filter `metadata->>sparring_id=is.null` AND `metadata->>sparring_id_unverified=is.null`
   (both keys are written by `allocate_global_vtid` / the `plan_sparring_check` trigger when a sparring id was
   passed). Rows from the gateway allocator path without a sparring id keep today's behaviour.
2. Defence in depth: the PATCH's own filter gets the same two `is.null` conditions, so a row that gained a
   binding between SELECT and PATCH is never tombstoned.
3. No change to the grace period, the terminal fields written, or the tick schedule.

## Tests
- Extend the existing source-level regression (vtid-03818 pattern: reads the function body) — assert the
  SELECT URL and the PATCH URL both contain `metadata->>sparring_id=is.null` and
  `metadata->>sparring_id_unverified=is.null`.
- Mutation check: removing either filter fails the test.
- `npm run test:operator` (touches Dev Autopilot execute module).

## Risks
- A sparring-bound shell that is genuinely abandoned is never auto-reaped → it stays visible as
  `allocated`. Accepted: the hourly sparring reconciler already reports unbound/abandoned sparring records;
  manual delete via the Command Hub remains.
- PostgREST JSON-path filter syntax: `metadata->>sparring_id=is.null` is supported for jsonb columns.

## Out of scope
Repairing VTID-05045/05046 (terminal, untouched); the allocator taking a title atomically.

### Round-1 amendments (binding)
- (F1) Code comment notes `plan_hash` always travels with `sparring_id` (routes/vtid.ts:92-110), so filtering on the two sparring keys is sufficient.
- (F2) The reaper also counts sparring-bound placeholder shells older than 1 h and, when > 0, writes one `console.warn` per tick (`reaper: skipped N sparring-bound shell(s) older than 1h`). No OASIS event (a per-tick count is telemetry, CLAUDE.md §6).
- (Q2) Tests go in a new file `services/gateway/test/vtid-<new>-reaper-sparring-guard.test.ts` (same source-reading pattern); vtid-03818 stays unchanged.
- (Q1) Both keys protected on purpose: a `sparring_id_unverified` row is still a deliberate, sparring-referencing allocation the owner should see, not an orphan.
<!-- plan:end -->

## Planner responses — round 1
- F1 ACCEPTED (comment). F2 ACCEPTED (per-tick console.warn count, no OASIS). F3 ACKNOWLEDGED (inherited; new test file). Q1 both keys on purpose. Q2 new test file.

## Sparring verdict
Round 1: 3 minor → all accepted/acknowledged. Round 2: all closed, no new findings. **Verdict: CONVERGED** (2 rounds).
Final plan-body hash: `f12eb993ad2c54afa570b5fdb3d079dd429212f7ddc039e6e2d8fef05eaece58`

## Record
- Plan hash (sha256 of the stripped text between the plan markers, plus a trailing newline): `f12eb993ad2c54afa570b5fdb3d079dd429212f7ddc039e6e2d8fef05eaece58`
- Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.
- VTID-05061 allocated after approval.

Owner approval (Gate 1): "You decide yourself" — 2026-10-10, Claude Code session; plan hash f12eb993ad2c54afa570b5fdb3d079dd429212f7ddc039e6e2d8fef05eaece58; sparring record ee472d91-f321-404a-ba3b-7651f7ab2f9b.
