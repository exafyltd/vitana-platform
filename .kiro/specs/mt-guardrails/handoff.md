---
slug: mt-guardrails
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-18T08:28Z
---
# Handoff — mt-guardrails (WS0 guardrails and test tooling)

WS0 of the multi-tenant program (`docs/MULTI-TENANT-PLAN.md` §6 "Guard rails & test env", the M0
blocker): the local test stack, generated inventories, DB and gateway lints, pgTAP isolation suite,
contract tests, Maxina golden suite and the MIGRATION-QUEUE CI check that every later isolation slice
depends on. Plan: `plan.md`. Requirements, design and successor rules: `requirements.md`, `design.md`,
`tasks.md`. Nothing here deploys or writes to a live system; the only production signal reused is the
already-live read-only `ci_tenant_isolation_health()` (VTID-05149).

Lanes:
- `local-test-stack` — kiro (seat hotmail), repo vitana-platform, `ready`.
- `generated-inventories` — kiro (seat hotmail), repo vitana-platform, `ready` (depends on
  local-test-stack).
- `pgtap-isolation-suite` — kiro (seat hotmail), repo vitana-platform, `ready` (depends on
  local-test-stack).
- `gateway-scope-lint-contract` — kiro (seat jtadic), repo vitana-platform, `ready` (depends on
  generated-inventories).
- `maxina-golden-suite` — kiro (seat jtadic), repo vitana-platform, `ready`.
- `ci-wiring` — claude (governance paths), repo vitana-platform, `ready`, `next_actor: claude` (depends
  on the five kiro lanes).

Lanes are held at `next_actor: owner` (kiro lanes) until PLAN-SPAR allocates their VTIDs and flips them;
`ci-wiring` is a governance lane held at `next_actor: claude`. CROSS-SPEC: `isHealthTable()` is
mt-identity's (O1); the `v1-golden-edge` golden fixture is owned by `maxina-golden-suite` and mt-packs
P4 regenerates it (O3).

## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → drafted
Authored the WS0 guardrails spec. Premises re-verified read-only against platform `origin/main` (latest
migration `20261015180000`; `ci_tenant_isolation_health()` applied and wired report-only into
MORNING-SYSTEM-HEALTH-CHECK row 21b; no pgTAP, inventories, gateway scope lint, golden suite or
MIGRATION-QUEUE CI check present today) and vitana-v1 (What's New entries/drafter). Six lanes: five kiro
(two seat hotmail DB/stack, two seat jtadic gateway, split so DB and gateway work never share a lane),
one claude governance lane for the CI/workflow wiring. No migration (reserved range 20261101020000–
025959 unused). Next: PLAN-SPAR spars this plan; on convergence it allocates one VTID per lane and flips
the kiro lanes to `next_actor: kiro`.

### 2026-10-17T10:53Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:29Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T18:37Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T18:45Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T19:32Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T20:11Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T07:57Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T08:28Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
