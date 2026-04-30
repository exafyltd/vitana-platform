# Routine: self-healing-triage

**Schedule:** `0 4 * * *` (daily 04:00 UTC, scheduler jitter pads to ~04:08)
**Trigger ID:** `trig_01TS53Lb7QjjMBePGYfNdRSa` (claude.ai/code/routines)
**Catalog row:** `routines.name = 'self-healing-triage'`

## Autonomy contract

Every sub-0.8 row in the self-healing pending-approval queue MUST be cleared by this run. The routine auto-decides APPROVE or REJECT and immediately calls the matching gateway endpoint. **No briefs for human review. No row left pending.** Either everything is green or self-healing's reconciler is already fixing it.

This is the first instance of the project-wide rule: every daily routine has exactly two terminal states — green pass or self-heal handoff. See `feedback_routines_no_human_briefs.md` in user memory.

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN` (matches the gateway env var; embedded in the routine prompt as a constant — no env-var support in CCR sandboxes today)

## Steps

### 1. Open the run record

```
POST $GATEWAY_URL/api/v1/routines/self-healing-triage/runs
H: X-Routine-Token: $ROUTINE_INGEST_TOKEN
B: { "trigger": "cron" }
→ { ok: true, run: { id: "<run_id>", ... } }
```

If non-2xx: ABORT (the gateway is the only thing the sandbox can talk to).

### 2. Fetch the queue

```
GET $GATEWAY_URL/api/v1/self-healing/pending-approval?limit=50
→ { ok: true, items: [ { id, vtid, endpoint, failure_class, confidence, diagnosis, attempt_number, created_at } ], count }
```

If `items.length === 0`: skip to step 4 with `summary: "✅ Queue empty — nothing to triage"` and `findings: { queue_size: 0, decisions: [], approved: 0, rejected: 0, errors: [] }`.

Otherwise sort by `created_at desc` and process the first 10.

### 3. Auto-decide every row, then dispatch

Classification (deterministic — no LLM judgement):

**APPROVE** if ALL:
- `attempt_number ≤ 2`
- `confidence ≥ 0.5`
- `diagnosis.spec_quarantined !== true`
- `diagnosis.human_decision` is unset

→ `POST $GATEWAY_URL/api/v1/self-healing/approve` with `{ id: <row.id>, operator: "self-healing-triage-routine" }`

**REJECT** otherwise (routes the row to the existing escalation/tombstone path):
- `attempt_number ≥ 3` → reason `"attempt limit reached (≥3) — escalating to architecture investigator"`
- `diagnosis.spec_quarantined === true` → reason `"spec quarantined by Memory Gate — escalating"`
- else → reason `"insufficient confidence (<0.5) — escalating"`

→ `POST $GATEWAY_URL/api/v1/self-healing/reject` with `{ id: <row.id>, operator: "self-healing-triage-routine", reason: "<reason>" }`

Capture HTTP status of every call.

### 4. Close the run

`PATCH $GATEWAY_URL/api/v1/routines/self-healing-triage/runs/{run_id}` with `X-Routine-Token: $ROUTINE_INGEST_TOKEN`.

| Outcome | status | summary |
|---|---|---|
| Every dispatch 2xx | `success` | `"✅ Cleared queue: A approved (dispatched), R rejected (escalated)"` |
| Some dispatch errors | `partial` | `"⚠️ Cleared X of N — Y dispatch errors. Self-healing reconciler will pick up the rest on next tick."` |
| Couldn't fetch queue or open run | `failure` | `"❌ Routine failed before any decisions — see error."` |

`findings` is an audit log, not a brief queue:
```json
{
  "queue_size": <int>,
  "cap": 10,
  "decisions": [
    { "vtid", "endpoint", "confidence", "attempt_number", "action": "approve"|"reject", "reason", "dispatch_http_status" }
  ],
  "approved": <int>,
  "rejected": <int>,
  "errors": [ { "id", "vtid", "dispatch_http_status", "error_text" } ]
}
```

## Hard rules

- Never produce 'briefs' for human review. The `findings.decisions` array is an audit log of decisions the routine already made and dispatched — nobody is going to read it row-by-row.
- Never leave a row pending. Every row touched is either /approve'd or /reject'ed.
- Never invoke an LLM. Classification is the deterministic heuristic above.
- Never write code, open PRs, or comment on GitHub. Only side-effects allowed are gateway HTTP calls.
- Plain `curl` only. No Python, no Node. Wall-clock cap 5 minutes.
- If the queue has more than 10 rows, the rest stay until the next cron tick (or a manual `run` from the routines web UI).

## Where output lands

- **Catalog tile** (Command Hub → Routines → Catalog): green pill = success/queue cleared. Anything else = look at History.
- **History** (per-routine drill-down): full `findings` JSON for forensics. Not a thing the user has to read every day — only when investigating.
- **Self-healing reconciler**: receives the /approve and /reject calls and dispatches/escalates the actual fixes. The routine's job is done the moment it has cleared the queue.
