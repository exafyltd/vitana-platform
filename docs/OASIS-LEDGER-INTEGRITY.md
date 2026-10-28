# OASIS ledger integrity — false failure verdicts (VTID-03516)

**Status:** root-caused, fixed, merged (`33268ea`, PR #3056), rows repaired.
**Outstanding:** the gate must reach AWS prod (`vitana-gateway-awsdr`) via PUBLISH
before the sweeping actually stops.

This document exists because the handoff it replaces
(`docs/HANDOFF-OASIS-LEDGER-INTEGRITY.md`) was written and reportedly pushed but
never landed — the branch did not exist on the remote. That is itself worth
noting: a session's conclusions are not durable until they are on `origin`.

---

## 1. What was wrong

For six days `vtid_ledger` recorded `status='rejected'` /
`terminal_outcome='failed'` on VTIDs whose work was merged and running in
production. 25 rows at time of discovery (28 by the time of repair, because the
cause was still live).

`CLAUDE.md` rule 1 is *"always treat OASIS as the single source of truth"*.
Nothing ever asserted that the source of truth was telling it.

Independently verifiable examples: VTID-03480 (the `orb_session_state` fix,
watched flipping `ok:false` → `ok:true` on live sessions), VTID-03471,
VTID-03459, VTID-03446/03447/03448 (merged as PR #3016).

## 2. Mechanism

```
session allocates VTID, sets in_progress + spec_status=approved   (CLAUDE.md §4.1)
  → ~20-30s later worker-runner-a1846580 claims it
     …because that tuple IS the worker-runner's eligibility predicate
  → GOVERNANCE_CHECK passes 3/3
  → every worker stage fails in <1s:
       "Failed to initialize Anthropic client — ANTHROPIC_API_KEY may be missing"
  → vtid-terminalize        writes terminal_outcome='failed'
  → autopilot-controller    maps that to status='rejected'
```

The last hop is `updateLedgerTerminal()` in
`services/gateway/src/services/autopilot-controller.ts`, whose own comment reads
*"use 'rejected' for failed tasks (shows red)"*.

Two execution planes share one ledger, and until VTID-03516 they shared one
eligibility predicate:

| Plane | Executes | Marks its rows |
|---|---|---|
| Session | a Claude Code session / human, in-conversation | anything (`metadata.source` is free text) |
| Autonomous | worker-runner → worker-{backend,memory,ai,…} | `source='self-healing'` or `autonomous_execution=true` |

§4.1 instructs every session to write `in_progress` + `approved` onto its own
VTID. That is precisely what the worker-runner read as "come execute this".

### Evidence

- **24/24** affected rows in the last 80 carry *both* a `worker_runner.claimed`
  event and the ANTHROPIC error.
- The `autopilot.state.failed` event timestamp matches the ledger's `updated_at`
  to the millisecond.
- `updated_at` is **not** auto-maintained on this table — writers set it
  explicitly. That is why batch-identical values across unrelated VTIDs were
  real signal rather than coincidence.
- **Live reproduction:** VTID-03516, allocated to investigate this, was itself
  swept 66 seconds after being set `in_progress`.

### Ruled out

- **DB triggers** — only two exist on `vtid_ledger`, both benign
  (`normalize_vtid_ledger_vtid`, `sync_vtid_ledger_to_vtidledger`).
- **`self-healing-reconciler.ts`** — writes `status='failed'`, not `'rejected'`,
  and only touches rows present in `self_healing_log`.

## 3. Fix

`isAutonomousExecutionTask()` in `routes/worker-orchestrator.ts` reverses
eligibility from opt-out to opt-in, enforced on **both** the pending feed and
the claim write path — a worker can call claim with any VTID it likes, so the
ownership check has to live on the authoritative write, not only on the read
that suggested it.

**It must be an allowlist.** `metadata.source` is free text; sessions write
ad-hoc labels (`orb-voice`, `aws-sns-gchat-alerts`, `news-feed-newest-first`),
so most session-owned VTIDs carry no `claude` marker at all. A denylist would
catch three strings and keep sweeping everything else.

**Cost of the reversal: zero.** Not one VTID in 60 days carries an autopilot
execution link — every VTID the worker-runner claimed in that window was
session work it had no business touching.

### Do not "fix" this by setting ANTHROPIC_API_KEY on the worker-runner

The missing key (deliberately deferred, §1b) is the only reason each misfire
failed in one second. With a working key the worker-runner would instead have
begun autonomously editing code for a VTID a session was concurrently working —
silent concurrent writes, against *"Never run parallel VTID executions"*. The
eligibility predicate was the bug; the credential was the smoke alarm.

## 4. Detection

`ci_ledger_integrity_check(days)` (migration `20260806160000`) +
`ALERT-OASIS-LEDGER-INTEGRITY.yml`, daily.

Over **PostgREST**, not psql — the Supabase project has a network allow-list and
GitHub runner IPs are not on it, so a psql-based detector could not run at all
(VTID-03485/03486/03492). Building the detector on that transport would have
reproduced the exact failure mode being fixed.

It deliberately does **not** alarm on `terminal_outcome='failed'` in general.
Real failures must stay quiet or the check gets muted within a week. It fires
only on the false-verdict fingerprint: claimed by a worker-runner, terminalized
failed, not autonomous-plane work.

Verified against production before shipping: 25 findings over 30d, 100% carrying
the ANTHROPIC fingerprint.

## 5. Repair record (2026-08-07)

28 rows. **Not** blanket-flipped to `success` — that would replace one false
claim with another, since *"the autonomous plane had no business judging this"*
is not *"this work succeeded"*.

| Bucket | Count | Action |
|---|---|---|
| Merged-commit evidence on `origin/main` (+ PR #3016 for VTID-03448) | 15 | → `completed` / `success`, with `metadata.ledger_verdict_corrected` recording the prior value and the evidence |
| No such evidence | 13 | verdict **voided** via `metadata.ledger_verdict_disputed`; state left as-is, flagged for human adjudication |

Absence of a merged commit is **not** proof of failure — some of that work landed
in `exafyltd/vitana-v1`, some was investigation with no commit.

28 OASIS events emitted (`vtid.lifecycle.verdict_corrected` /
`vtid.lifecycle.verdict_disputed`).

**Corrected (15):** 03446, 03447, 03448, 03454, 03459, 03460, 03461, 03464,
03465, 03471, 03472, 03480, 03481, 03498, 03500

**Disputed — need a human call (13):** 03468, 03473, 03475, 03493, 03506, 03507,
03509, 03512, 03513, 03518, 03521, 03524, DEV-COMHU-03366

Correcting these rows was safe before the gate was deployed because every path
keeps `is_terminal = true`; a terminal row is not claimable, so nothing could be
re-swept. `scripts/oasis/correct-false-terminalizations.cjs` originally required
`--i-have-deployed-the-gate` on the assumption that rows might be returned to a
claimable state — they never are, and the guard has been corrected to say what
actually matters.

## 6. Still open

- **The gate is not in production.** Merging reaches staging only (§16); the
  worker-runner polls AWS prod. Until PUBLISH, new VTIDs keep being swept.
- **VTID-03526** — two worker-runners poll concurrently. No VTID has ever been
  claimed by two workers (the claim RPC is atomic), but two *different* VTIDs
  can execute at once. Needs `aws ecs describe-services` to attribute the second
  poller.
- The 13 disputed rows need adjudication.
