# Routine: llm-spend-budget

**Schedule:** `50 23 * * *` (daily 23:50 UTC)
**Runs in:** the gateway's routine runner (`services/gateway/src/services/routine-runner`, VTID-05141), once per UTC day at the time above. It records the run in `routine_runs` (`trigger = gateway-runner`) and on a breach emits the event below with `source: routine.llm-spend-budget` and hands it to the self-healing intake.

**Catalog row:** `routines.name = 'llm-spend-budget'`
**OASIS VTID for emitted events:** `VTID-05141`
**Loop:** L5 Guard (case G04, LLM spend → budget alert)

## Autonomy contract

Compares the UTC day's LLM spend with the budgets in `services/gateway/src/services/orchestrator/budgets.ts` (platform per day, per agent, per run) and reports any line over its limit. **Alert only: it never throttles or blocks a model call.** Blocking is a separate owner decision.

The budgets are per UTC day, so the routine runs just before midnight and reads that day's `llm.call.completed` events — the same read and arithmetic as `GET /api/v1/orchestrator/budgets` (`loadSpendToday` → `aggregateSpend` → `budgetLines`).

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Every budget line is within its limit. |
| 🟡 `partial` | At least one line over its limit → OASIS event emitted. |
| 🔴 `failure` | No `llm.call.completed` events today (no spend data — never a green pass), or the read failed. |

## On a breach — OASIS event

```
type: llm.spend.budget_exceeded   vtid: VTID-05141
source: routine.llm-spend-budget  status: warning
payload: { since, over_budget: [ { scope, key, spent_usd, limit_usd, used_pct } ], platform }
```
