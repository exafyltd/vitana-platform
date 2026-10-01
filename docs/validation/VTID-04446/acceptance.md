# VTID-04446 — Orchestrator P4: run leases + stage-loop stall detection

Plan: docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3 ("Leases, not heartbeats-as-truth",
"Progress ledger / stall detection") and §5 P4 (exit: "a live run is never
reclaimed while stepping; a looping run stops with a `stalled` reason").

The Dev Autopilot running-watchdog reclaimed any `running` execution whose
`updated_at` was older than 20 minutes. That rule reclaimed a live agent run
once (VTID-04011), and lets a task that died two minutes in hold its slot for
another 18. With `ORCHESTRATOR_RUN_LEASE_ENABLED=true` a claimed execution gets
a lease row in the native ledger (`agent_runs`, plane `dev_autopilot`,
`idempotency_key = dev_autopilot:<execution id>`): written at claim with the
legacy 20-minute window, renewed to now + TTL (5 min) by every agent heartbeat,
released when the running phase ends. The watchdog then asks the lease: a live
lease is never reclaimed, an expired one is reclaimed as soon as it expires, and
an execution without a lease keeps the legacy 20-minute rule. A bounded sweep
closes expired leases whose execution already left `running`.

The shared stage tool loop (validator, triage, spec generator, specialists)
gets the same progress ledger the agent loop has had since VTID-04394: after
two turns of nothing but exact repeats it re-plans once, after three it goes
straight to its tool-less final answer with `stalled: true`.

Flag unset (the default): no lease is read or written and the watchdog is
unchanged. The migration (`20260923210000_vtid_04446_run_leases.sql`: a partial
index and the view filter that keeps lease mirrors out of `agent_runs_unified`)
is committed but NOT applied — apply it before enabling the flag.

## Acceptance

AC-1 With ORCHESTRATOR_RUN_LEASE_ENABLED unset nothing reads or writes a lease and the watchdog keeps the legacy 20-minute rule.
TEST: services/gateway/test/services/orchestrator/vtid-04446-run-leases.test.ts

AC-2 A live lease is never reclaimed however stale updated_at is; an expired lease is reclaimed; no lease falls back to the legacy rule.
TEST: services/gateway/test/services/orchestrator/vtid-04446-run-leases.test.ts

AC-3 The claim writes a lease with the legacy window, the heartbeat renews it to the TTL, the end of the running phase releases it; every call is fail-open.
TEST: services/gateway/test/services/orchestrator/vtid-04446-run-leases.test.ts

AC-4 The sweep closes expired leases whose execution already left running, and only those.
TEST: services/gateway/test/services/orchestrator/vtid-04446-run-leases.test.ts

AC-5 The stage tool loop re-plans once after repeated identical calls, then forces the tool-less final answer with stalled: true; new calls count as progress; stall: false restores the old behaviour.
TEST: services/gateway/test/services/orchestrator/vtid-04446-run-leases.test.ts

AC-6 The migration only adds an index and the view's mirror filter; no table is created or altered.
TEST: services/gateway/test/services/orchestrator/vtid-04446-run-leases.test.ts

OASIS_PROOF: the watchdog's existing `dev_autopilot.execution.failed` event gains one payload field, `reclaim_basis` (`legacy_stale` | `lease_expired`); topic, status and every other field unchanged. Pinned by the wiring contract test in services/gateway/test/services/orchestrator/vtid-04446-run-leases.test.ts. No new topic.

## Not verified live

- The migration is not applied (owner decision). The live `agent_runs_unified`
  was read before writing it: 17 columns, 3 UNION ALL branches, no mirror
  filter — the file re-creates exactly that shape plus the filter.
- No lease has been written anywhere: the flag is set on no stack. The first
  signal after the owner enables it on staging (gateway AND executor task) is
  an `agent_runs` row with `metadata.mirror_of` whose `lease_until` moves every
  minute while the agent runs, and closes when it ends.
