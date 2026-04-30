# Routine: agents-heartbeat

**Schedule:** `30 5 * * *` (daily 05:30 UTC, scheduler jitter pads to ~05:38)
**Catalog row:** `routines.name = 'agents-heartbeat'`
**OASIS VTID for emitted events:** `VTID-02004`

## Autonomy contract

Calls `/api/v1/agents/registry`, derives the live status of every agent (the registry decays heartbeat freshness at read time), and **emits an OASIS event** (`topic = agents.registry.degraded`) listing any agent that is not `healthy`. Self-healing already watches that topic and will spawn an investigation per affected service.

Silent-agent-death is otherwise the single class of failure we cannot detect quickly. This routine closes that gap without adding any human queue.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | All registered agents are healthy. Nothing to do. |
| 🟡 `partial` | One or more agents degraded/down → OASIS event emitted → self-healing now investigating. |
| 🔴 `failure` | Routine itself errored (registry endpoint down, gateway 5xx). |

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN` (embedded)

## Steps

### 1. Open the run record

```
POST $GATEWAY_URL/api/v1/routines/agents-heartbeat/runs
H: X-Routine-Token: $ROUTINE_INGEST_TOKEN
B: { "trigger": "cron" }
→ { ok: true, run: { id: "<run_id>" } }
```

### 2. Read the registry

```
GET $GATEWAY_URL/api/v1/agents/registry
→ {
  ok: true,
  counts: { total, by_tier:{service,embedded,scheduled}, by_status:{healthy,degraded,down,unknown}, ... },
  agents: [ { agent_id, display_name, tier, status, derived_status, last_heartbeat_at, heartbeat_age_ms, ... } ]
}
```

### 3. Filter for problems

A "problem agent" is any row where `derived_status !== 'healthy'`. Two known caveats baked into the registry:
- `tier === 'embedded'` agents do not heartbeat individually — they live or die with the gateway. Skip them when computing problems (the gateway's own /alive covers them).
- `tier === 'scheduled'` agents have a 6h/24h decay window; they're allowed to be quieter than service-tier.

So `problems = agents.filter(a => a.tier !== 'embedded' && a.derived_status !== 'healthy')`.

### 4. If problems detected — emit OASIS event

```
POST $GATEWAY_URL/api/v1/events/ingest
B: {
  "vtid": "VTID-02004",
  "type": "agents.registry.degraded",
  "source": "routine.agents-heartbeat",
  "status": "warning",
  "message": "N agent(s) not healthy: <comma-separated agent_ids>",
  "payload": {
    "problems": [ { agent_id, tier, derived_status, last_heartbeat_at, heartbeat_age_ms, last_error } ],
    "totals": { total, by_status }
  }
}
```

### 5. Close the run

`PATCH $GATEWAY_URL/api/v1/routines/agents-heartbeat/runs/{run_id}` with `X-Routine-Token`.

| Outcome | status | summary |
|---|---|---|
| Zero problems | `success` | `"✅ All N agents healthy across service / embedded / scheduled tiers"` |
| Problems detected | `partial` | `"⚠️ N agents not healthy: <ids>. OASIS event emitted, self-healing notified."` |
| Registry endpoint down | `failure` | `"❌ Could not read /api/v1/agents/registry — see error"` |

`findings`:
```json
{
  "agents_total": <int>,
  "agents_problem": <int>,
  "by_status": { "healthy": <int>, "degraded": <int>, "down": <int>, "unknown": <int> },
  "problems": [ { "agent_id", "tier", "derived_status", "last_heartbeat_at", "heartbeat_age_ms" } ],
  "oasis_event_id": "<uuid or null>"
}
```

## Hard rules

- Skip `tier === 'embedded'` agents when computing problems (they don't heartbeat).
- Never restart, redeploy, or otherwise touch the agents — that's self-healing's job. The routine only emits the event.
- Plain `curl` only. Wall-clock cap 2 minutes — this should be fast.
