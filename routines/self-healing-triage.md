# Routine: self-healing-triage

**Schedule:** `0 4 * * *` (daily 04:00 UTC)

**Purpose:** Pre-digest every sub-0.8 quarantined fix from the self-healing reconciler into a 6-line Approval Brief — recommendation, rationale, risk note, similar-fix history. Cuts review time per row from ~5 minutes to <30 seconds.

**Required environment:**
- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN` (matches the gateway's `ROUTINE_INGEST_TOKEN` env var; set as a routine secret)
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE` for direct table reads

---

## Steps

### 1. Open the run record

```
POST $GATEWAY_URL/api/v1/routines/self-healing-triage/runs
H: X-Routine-Token: $ROUTINE_INGEST_TOKEN
B: { "trigger": "cron" }
→ { ok: true, run: { id: "<run_id>", ... } }
```

Capture `run.id`. If this fails (network/auth/server), abort the routine — do not proceed.

### 2. Fetch the queue

```
GET $GATEWAY_URL/api/v1/self-healing/pending-approval?limit=50
→ { ok: true, items: [ { id, vtid, endpoint, failure_class, confidence, diagnosis, created_at, attempt_number }, ... ] }
```

If `items.length === 0`, skip to step 6 with `summary: "✅ Queue empty — nothing to triage"` and `findings: { briefs: [] }`.

Cap at the first **10** rows by `created_at desc` (the rest will roll into tomorrow's run).

### 3. For each pending row — gather context

For row `{ id, vtid, endpoint, failure_class, confidence, diagnosis, attempt_number }`:

a. **Snapshots** — `GET $GATEWAY_URL/api/v1/self-healing/snapshots/$vtid` for pre/post endpoint state.

b. **OASIS recent activity** — query `oasis_events` directly via Supabase REST for the last 7 days on this endpoint:
   ```
   GET $SUPABASE_URL/rest/v1/oasis_events?service=eq.gateway&payload->>endpoint=eq.$endpoint&created_at=gte.<7d_ago>&select=type,topic,status,created_at&order=created_at.desc&limit=100
   ```
   Count: total events, errors, novel topics (topics not seen in the prior 7d window).

c. **Similar-fix history** — same endpoint or same `failure_class` in `self_healing_log`:
   ```
   GET $SUPABASE_URL/rest/v1/self_healing_log?or=(endpoint.eq.$endpoint,failure_class.eq.$failure_class)&select=outcome,confidence,created_at&order=created_at.desc&limit=50
   ```
   Count outcomes: `resolved`, `regressed`, `tombstoned`.

d. **Spec Memory Gate / quarantine** — check if the proposed spec is currently quarantined. The Spec Memory Gate state lives alongside self_healing_log; if the row's `diagnosis.spec_quarantined === true` or attempt_number ≥ 3, flag for escalation, not approval.

### 4. Compose an Approval Brief per row

Format each as:

```
VTID-XXXXX  •  endpoint $endpoint  •  confidence $confidence  •  attempt $attempt_number
Recommendation: APPROVE | REJECT | ESCALATE
Why: <1-2 sentences citing similar-fix counts and OASIS topic burn rate>
Risk: <1 sentence — what to watch in the next 24h>
History: $resolved resolved / $regressed regressed / $tombstoned tombstoned
```

Heuristics for the recommendation:
- **APPROVE** if `resolved >= 2 && regressed === 0 && !spec_quarantined && attempt_number <= 2 && novel_topics === 0`.
- **ESCALATE** if `attempt_number >= 3 || spec_quarantined === true || regressed >= 1`.
- **REJECT** otherwise.

### 5. Post a single PATCH with all briefs

```
PATCH $GATEWAY_URL/api/v1/routines/self-healing-triage/runs/<run_id>
H: X-Routine-Token: $ROUTINE_INGEST_TOKEN
B: {
  "status": "success",
  "summary": "Triaged $N pending fixes — $A APPROVE, $R REJECT, $E ESCALATE",
  "findings": {
    "queue_size": <items.length>,
    "triaged": $N,
    "skipped_overflow": <items.length - 10>,
    "briefs": [ { vtid, endpoint, confidence, recommendation, why, risk, history: { resolved, regressed, tombstoned } }, ... ]
  },
  "artifacts": {}
}
```

### 6. On any failure mid-routine

If steps 2–4 throw, still PATCH the run with `status: "failure"` and `error: <message>` so the Catalog tile shows the failed status. **Never leave a run stuck in `running`.**

### 7. On empty queue

If step 2 returned 0 items, PATCH with:
```
{ "status": "success", "summary": "✅ Queue empty — nothing to triage", "findings": { "queue_size": 0, "briefs": [] } }
```

---

## Cost / token budget

- Cap at 10 briefs per day so the routine stays well under 5 minutes wall-clock and under one cache window.
- All gathering work is plain HTTP — no LLM calls inside this routine. Recommendations are heuristic.

## Output goes to

Command Hub → **Routines** → **Catalog** (status pill + summary on the routine tile) and **History** (full briefs JSON in the expandable run row).
