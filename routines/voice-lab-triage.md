# Routine: voice-lab-triage

**Schedule:** `30 4 * * *` (daily 04:30 UTC)
**Runs in:** the gateway's routine runner (`services/gateway/src/services/routine-runner`, VTID-05103; this routine since VTID-05141), once per UTC day at the time above — not as a claude.ai session. It records the run in `routine_runs` (`trigger = gateway-runner`) and on a breach emits the event below with `source: routine.voice-lab-triage`, `status: warning` and hands it to the self-healing intake. No token or URL is involved.

**Catalog row:** `routines.name = 'voice-lab-triage'`
**OASIS VTID for emitted events:** `VTID-01155` (canonical voice VTID)

## Autonomy contract

Compares the last 24 h of ORB voice sessions with the prior 7 days and **emits an OASIS event** (`topic = voice.live.regression.daily_triage`) when voice regressed, so the voice self-healing loop picks it up. **No briefs for human review.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | No regression, error rate within baseline. Nothing to do. |
| 🟡 `partial` | Regression detected → OASIS event emitted → self-healing notified. |
| 🔴 `failure` | The routine itself errored (the session read failed). |

## Data source

`voice_session_facts` (VTID-04776): one row per ORB voice session with `started_at`, `outcome` (`ok`, `silent`, `one_way`, `dropped`, `error`, `abandoned`, `active`) and `failure_class` (the voice failure taxonomy, `services/gateway/src/services/voice-failure-taxonomy.ts`). Loader: `auditVoiceSessionOutcomes()` in `services/gateway/src/routes/routine-audits.ts`.

`/api/v1/voice-lab/live/sessions` is not used: it has no time window and sets `error_count` to 0 for every session (why this routine was not run under VTID-05103).

## Steps

### 1. Read both windows (ended sessions only — `outcome` set and not `active`)

- yesterday: `started_at` in the last 24 h
- baseline: `started_at` from 8 days ago to 1 day ago (the prior 7 days, not including yesterday)

For each: `total_sessions`, `error_sessions` (outcome `silent`, `one_way`, `dropped` or `error`), `error_rate = error_sessions / total_sessions`, and error sessions by `failure_class` (missing class → `voice.unknown`).

### 2. Regression check

A regression is any of:
- `error_rate_spike`: `error_rate_yesterday > error_rate_baseline × 1.5` AND `error_sessions_yesterday ≥ 3`
- `novel_failure_class`: a `failure_class` seen in ≥ 3 sessions yesterday and not at all in the baseline
- `session_collapse`: `total_sessions_yesterday < (total_sessions_baseline / 7) × 0.3`

### 3. On a regression — OASIS event

```
type: voice.live.regression.daily_triage   vtid: VTID-01155
source: routine.voice-lab-triage           status: warning
payload: { yesterday, baseline, regression_kind, regression_kinds }
```

### 4. Close the run

| Outcome | status | summary |
|---|---|---|
| No regression | `success` | `✅ Voice healthy: X sessions, Y errors, error rate Z% (within baseline)` |
| Regression | `partial` | `⚠️ Voice regression: <kinds>. OASIS event emitted, self-healing notified.` |
| Read failed | `failure` | the error |

`findings` = both windows (with top failure classes and novel classes) and `regression_kinds`.
