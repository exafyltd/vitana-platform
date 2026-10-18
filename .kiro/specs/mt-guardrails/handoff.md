---
slug: mt-guardrails
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-18T21:09Z
---
# Handoff — mt-guardrails (WS0 guardrails and test tooling)
WS0 of the multi-tenant program (`docs/MULTI-TENANT-PLAN.md` §6 "Guard rails & test env", the M0
blocker): the local test stack, generated inventories, DB and gateway lints, the isolation suite,
contract tests, Maxina golden suite and the MIGRATION-QUEUE CI check that every later isolation slice
depends on. Plan: `plan.md`. Requirements, design and successor rules: `requirements.md`, `design.md`,
`tasks.md`. Nothing here deploys or writes to a live system; the only production signal reused is the
already-live read-only `ci_tenant_isolation_health()` (VTID-05149).
Lanes:
- `local-test-stack` — kiro (seat hotmail), repo vitana-platform, `ready`.
- `generated-inventories` — kiro (seat hotmail), repo vitana-platform, `ready` (depends on
  local-test-stack).
- `isolation-suite` — kiro (seat hotmail), repo vitana-platform, `ready` (depends on
  local-test-stack, generated-inventories).
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
### 2026-10-18T10:00Z · kiro-hotmail-202610151618-b437 · spar round-1 → answered
Answered a PLAN-SPAR round 1 (both findings accepted). It chose the repo's existing raw-psql + RAISE
harness, not pgTAP/`pg_prove`; the lane `pgtap-isolation-suite` was renamed to `isolation-suite`.
Superseded by the 2026-10-18T16:20Z round below.
### 2026-10-18T14:58Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-18T15:12Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-18T16:20Z · kiro-hotmail-202610151618-b437 · spar round-1 (fresh session e7f1e151) → answered, pgTAP reinstated
Answered the fresh PLAN-SPAR round 1 (session e7f1e151) in `sparring/responses-1.md`; three findings,
all accepted. R1-F2 (major) REVERSES the earlier raw-psql decision: the hash-stamped parent plan
`docs/MULTI-TENANT-PLAN.md` §4.2 (`:51`) and §4.9 (`:61`) explicitly MANDATE pgTAP for these isolation
assertions (parent body hash `869182cc6aef344b107c6a8915fe2271bbd1bc982febb198f09027e7eb451326`), so
pgTAP is **reinstated** via path (a): `local-test-stack` installs the `pgtap` extension + `pg_prove`
(first introduction into the repo, which the parent already assumed WS0 would do — no parent
amendment), the isolation suite uses pgTAP, and ci-wiring installs/runs `pg_prove`. R1-F1 (major): there
are TWO SQL harnesses (self-contained `test-vtid-05147-s-m-lockdown.sh` with `initdb`/`pg_ctl`, and the
external-psql `scripts/ci/sql-tests/` runners where the VTID-05149 tenant tests live); the isolation
suite now connects to lane 1's running stack over external `psql` via `pg_prove`, specs under
`supabase/tests/mt/**`, runner `scripts/ci/sql-tests/run-mt-isolation-test.sh` — NOT `initdb`/`pg_ctl`.
R1-F3 (minor): the generated-inventories lane now references `scripts/ci/aurora-migration-inventory.cjs`
(VTID-03494) for output-format reuse. plan.md, tasks.md, the isolation-suite/local-test-stack/
generated-inventories/ci-wiring lanes updated accordingly. Push fires round 2.
### 2026-10-18T18:40Z · kiro-hotmail-202610151618-b437 · spar round-2 → answered (3 findings, all accepted)
Answered PLAN-SPAR round 2 (session e7f1e151) in `sparring/responses-2.md`; three findings, all
accepted. R2-F1 (major): named one concrete, pinned install mechanism shared verbatim by lane 1 and
lane 6 — the `supabase/postgres` image pinned by exact tag (ships `pgtap`; stock `postgres:16` does
not) for the server + `pg_prove` from a pinned `libtap-parser-sourcehandler-pgtap-perl` apt version on
the host. R2-F2 (major): chose path B — the new checks are standalone workflows (`MT-GUARDRAILS.yml` +
a dedicated `SQL-MT-ISOLATION.yml`), not PR-GATE steps, so they land report-only via their own
`scripts/ci/mt/config.json` `report_only` flag (warn-and-exit-0 while true), flipped by a later
governance PR to `report_only=false`; PR-GATE's `enforce` gates only the Verdict `OUTCOMES` checks and
cannot gate them. R2-F3 (minor): moved the pgTAP spec from `supabase/tests/mt/**` to
`scripts/ci/sql-tests/mt-isolation.test.sql`, beside the runner, matching the VTID-05149 layout so
`SQL-MT-ISOLATION.yml`'s `paths:` stays on `scripts/ci/sql-tests/**`; isolation-suite `paths` and its
tasks.md Allowed paths updated to the two co-located files, and `SQL-MT-ISOLATION.yml` added to
ci-wiring's `paths`. plan.md, tasks.md and the three lanes updated. Push fires round 3.

### 2026-10-18T21:09Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
