# Routine: learn-outcomes

**Schedule:** `0 12 * * *` (daily 12:00 UTC; the graduation step runs on Mondays only)
**Runs in:** the gateway's routine runner (`services/gateway/src/services/routine-runner/learn-outcomes.ts`, VTID-05148), once per UTC day at the time above. It records the run in `routine_runs` (`trigger = gateway-runner`) and on a breach emits the event below with `source: routine.learn-outcomes` and hands it to the self-healing intake.

**Catalog row:** `routines.name = 'learn-outcomes'`
**OASIS VTID for emitted events:** `VTID-05148`
**Loop:** L3 Learn (cases E04 outcome-driven graduation, Q02 missing-test scanner, Q05 support regression suite growth)

## Autonomy contract

Every outcome leaves one lesson in a store that already exists. The routine **never** changes `auto_exec_eligible`, `self_healing_autonomy_level` or any flag: a graduation is a proposal for a human.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Metrics recorded, no class over the repeat-failure limit. |
| 🟡 `partial` | A class's repeat-failure rate is over the limit → OASIS event emitted, self-healing notified. |
| 🔴 `failure` | A Supabase read failed (never a green pass). |

## Steps

### 1. Which tests did each fix ship? (escaped bug → test)

- Rows: `self_healing_log` with `outcome = 'fixed'`, a `diagnosis.pr_url` and no `diagnosis.tests_added`, newest first, **at most 50 PRs per run**.
- For each, the PR's changed files from the GitHub PR files API (token `GITHUB_SAFE_MERGE_TOKEN`, else `GITHUB_TOKEN`; none set → step skipped).
- Test files: `*.test.ts`, `*.test.cjs`, `*.spec.ts`, or any path under `test/` or `__tests__/` (removed files do not count).
- `diagnosis.tests_added: string[]` is written by read-modify-write: the row's whole `diagnosis` is read, `tests_added` merged in, the whole object PATCHed back.
- A GitHub error leaves the row untouched; the next run retries it. It is never written as "no tests".
- `tests_added` empty → ONE `write_test` finding through the missing-test insert (`insertMissingTestRecommendation`, `routes/test-contracts-missing.ts`: `source_type missing-test-scanner`, `spec_snapshot.repair_kind write_test`), deduped by `spec_snapshot.dedupe_key = learn-outcomes:<fix VTID>:<endpoint>`. If the insert fails, the row stays untouched.

### 2. The L3 metrics (last 30 days), stored in the run's `findings.metrics`

- **Repeat-failure rate per class:** a fix is a `self_healing_log` row with `outcome = 'fixed'`; it is repeated when a row for the same `endpoint` with `outcome` in (`pending`, `failed`, `escalated`) is created within 7 days after it. Rate = repeated / fixes, grouped by the fixed row's `failure_class`.
- **Pattern reuse:** fixes whose `diagnosis.repair_pattern_id` names a `repair_patterns` row. While no fix records one, `{ state: 'not_measured', reason }` — no number is invented.
- **Escaped bugs that became tests:** fixed rows with a non-empty `tests_added` over fixed rows that have the key. Rows without the key (before VTID-05148) are `unknown`, never counted as missing.

### 3. Graduation proposals (Mondays UTC only)

- `dev_autopilot_outcomes`, last 30 days, `exec_outcome IS NOT NULL`, grouped by `(scanner_name, risk_class)`.
- A class is proposed when: ≥ 20 executions, success rate (`exec_outcome = 'success'`) ≥ 95 %, zero `rolled_back`, zero `human_modified_plan = true`, a named scanner, no open proposal, and its recent findings in `autopilot_recommendations` are not already all `auto_exec_eligible`.
- Each proposal → OASIS `learn.graduation.proposed` (status `info`) with the class, the counts, the window and the rule that would change.
- An open proposal (latest event of its class is `proposed`) whose class now has a success rate below 90 % or any rollback → `learn.graduation.withdrawn` (status `info`).
- Open proposals show in Command Hub → Autonomy Pulse as `graduation_proposal` items (read-only, "Open" links to Dev Autopilot).

## Breach — OASIS event

A class with **more than 30 %** repeat-failure rate and **at least 5 fixes**:

```
type: learn.repeat_failure.high    vtid: VTID-05148
source: routine.learn-outcomes     status: warning
payload: { window_days: 30, follow_up_days: 7, classes: [ { failure_class, fixes, repeated, rate } ] }
```

## Where the numbers show

`GET /api/v1/autonomy/loops` → `metrics_latest.L3` (latest `success`/`partial` run's `findings.metrics`); the L3 card on Command Hub → Autonomy → Loops shows the three numbers.
