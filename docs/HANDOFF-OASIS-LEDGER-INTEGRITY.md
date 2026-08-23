# HANDOFF — OASIS ledger is marking successful work as `rejected`/`failed`

**For: a fresh session.** Written 2026-08-06. Investigation only so far; nothing
has been changed in the ledger to "fix" this, deliberately.

---

## The symptom

`vtid_ledger` is terminalizing VTIDs as `status='rejected'`,
`terminal_outcome='failed'`, `is_terminal=true` — within **1–4 minutes of
creation** — for work that is real, merged, and verified working in production.

CLAUDE.md rule 1 calls OASIS "the single source of truth for task state,
lifecycle, and governance." Right now it asserts that essentially all recent
work failed. Any human or automation reading the ledger to decide what shipped
is being misinformed.

### Evidence — four VTIDs whose real outcome is independently verifiable

| VTID | what actually happened | ledger says | minutes open |
|---|---|---|---|
| `VTID-03480` | merged; `orb_session_state` migration applied, `ok:false` → `ok:true` confirmed on live sessions | rejected / failed | 2.6 |
| `VTID-03481` | merged in PR #3038 | rejected / failed | 2.0 |
| `VTID-03498` | merged in PR #3040 (data-access seam) | rejected / failed | 90.6 |
| `VTID-03512` | architecture assessment, doc committed | rejected / failed | 2.3 |

Scale: of the **last 80 VTIDs, 25 are `rejected`/`failed`.**

Reproduce:

```sql
select vtid, status, terminal_outcome,
       round(extract(epoch from (updated_at-created_at))/60,1) as mins_open, title
from vtid_ledger
where status='rejected' and updated_at > now() - interval '7 days'
order by vtid desc limit 20;
```

---

## Already ruled out — don't redo this

**1. Database triggers.** Only two exist on `vtid_ledger`, neither changes
status:

```sql
select t.tgname, p.proname, pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid=t.tgrelid
join pg_proc p on p.oid=t.tgfoid
where c.relname='vtid_ledger' and not t.tgisinternal;
```
→ `trg_normalize_vtid_ledger_vtid` (name normalisation) and
`trg_sync_vtid_ledger_to_vtidledger` (mirror to the deprecated PascalCase
table). Neither is the writer.

**2. `self-healing-reconciler.ts` — probably not it, but not fully excluded.**
It *does* terminalize ledger rows (see its line ~225 and the comment "ALSO
terminalize the vtid_ledger row so the dedup check stops"), but:
- it writes `status='failed'`, **not** `'rejected'` — the observed value;
- it only iterates VTIDs present in `self_healing_log`.

Confirm by checking whether the affected VTIDs appear there:
```sql
select vtid, count(*) from self_healing_log
where vtid in ('VTID-03480','VTID-03481','VTID-03498','VTID-03512')
group by vtid;
```
If that returns nothing, the reconciler is excluded and you can stop
considering it.

---

## Where to look next

The writer sets **`status='rejected'` AND `terminal_outcome='failed'`
together**. Grep for that pair rather than either alone — that combination is
the fingerprint.

Candidates, in rough order:

1. **`services/gateway/src/services/autopilot-controller.ts`** — has
   "Update vtid_ledger to terminal state" (~line 945) and "Also update
   vtid_ledger status" (~line 699). Runs on a loop, which fits the 1–4 minute
   latency.
2. **`services/oasis-projector/`** — the projector reconciles OASIS events into
   ledger state. If it derives terminal state from the *absence* of an expected
   event, a VTID created outside its normal flow (e.g. self-allocated by a
   Claude session, per CLAUDE.md §4.1) would look like a task that never
   started and could be marked failed.
3. **`services/worker-runner/`** — claims and terminalizes tasks.
4. **`services/gateway/src/routes/vtid-terminalize.ts`** — the explicit
   terminalize endpoint; check whether something calls it with a default of
   rejected/failed.

Useful narrowing: correlate with OASIS events around the flip.

```sql
select o.created_at, o.topic, o.service, o.source, o.status, o.message
from oasis_events o
where o.vtid = 'VTID-03512'
order by o.created_at;
```

The `service`/`source` on the event nearest the `updated_at` timestamp should
name the culprit directly.

Also check the governance rules table — this may be intended behaviour
misfiring rather than a bug:
```sql
select * from governance_rules where lower(coalesce(description,'')||coalesce(name,'')) like '%reject%';
select * from governance_evaluations order by created_at desc limit 20;
```

---

## The likely shape of the bug (hypothesis, unverified)

CLAUDE.md §4.1 made Claude sessions **self-allocate** VTIDs
(`allocate_global_vtid`) and set `status='in_progress'` +
`spec_status='approved'` directly. Those VTIDs never pass through the
allocate → claim → execute → complete lifecycle that a worker drives.

If some reconciler treats "in_progress with no claim and no worker heartbeat"
as a stalled/invalid task, it would terminalize exactly these — which matches
the observed set: they are all self-allocated session VTIDs, and the ones open
longest (03498 at 90 min) are the ones that took longest before the sweep
caught them.

**Test it:** allocate a throwaway VTID, set `status='in_progress'`, and watch
`updated_at` for five minutes without touching it further.

```sql
select allocate_global_vtid('handoff-probe','INFRA','oasis-integrity-test');
-- then set in_progress, wait, and poll:
select vtid, status, terminal_outcome, created_at, updated_at
from vtid_ledger where vtid = '<the new one>';
```

If it self-rejects untouched, you have a reproducible case and the OASIS events
on that VTID will name the writer.

---

## What NOT to do

- **Do not bulk-UPDATE the 25 rows back to `completed`.** Until the writer is
  identified it will just re-reject them, and you will have destroyed the
  timestamps that identify it.
- **Do not modify terminal rows ad hoc** — CLAUDE.md: `IF is_terminal=true →
  THEN DO NOT MODIFY TASK`. Fix the writer first; backfill once, deliberately,
  afterwards.
- **Do not assume the reconciler is guilty** because it is the most obvious
  candidate. It writes a different status value. Confirm with evidence.

---

## Definition of done

1. The writer is identified by name and file, with evidence (an OASIS event or
   a log line tying it to a specific flip).
2. Either the writer stops terminalizing self-allocated VTIDs, or self-allocation
   is changed to satisfy whatever invariant it enforces — decided deliberately,
   not patched around.
3. A regression test or health check that would catch a recurrence. The lesson
   from VTID-03480 applies directly here: *this went unnoticed because nothing
   asserts the ledger tells the truth.* A check comparing merged PRs carrying a
   VTID against that VTID's `terminal_outcome` would have caught it.
4. The historical rows are corrected **once**, after the writer is fixed, with
   the corrected set recorded.

## Context you will want

- `CLAUDE.md` §4.1 — self-service VTID allocation (the standing rule that
  likely creates the mismatch)
- `CLAUDE.md` §5 — governance gates, `EXECUTION_DISARMED`,
  `AUTOPILOT_LOOP_ENABLED`
- `CLAUDE.md` §6 — OASIS event taxonomy; note "polling ≠ progress"
- `CLAUDE.md` §7 — worker orchestrator API, including `/terminalize`
- **Known schema drift:** CLAUDE.md §3 documents `claimed_until`; the real
  column is `claim_expires_at` (+ `claim_started_at`). Do not trust that table
  blindly.

## Allocate a VTID for this before starting

Per CLAUDE.md §4.1 — and note the irony: the VTID you allocate for this
investigation may itself get rejected within a couple of minutes. **If it does,
that is your reproduction case.** Capture the OASIS events on it immediately.
