---
slug: native-g1-wiring
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-20T08:41Z
sparring_record: .kiro/specs/native-g1-wiring/sparring/verdict.md
vtids: [VTID-05247, VTID-05248, VTID-05249, VTID-05250, VTID-05251, VTID-05252, VTID-05253]
---
# Handoff — Point dev/QA native builds at the G1 test backend (Wave 1 exit)
Native app program VTID-05021 (`docs/programs/native-app/NATIVE-APP-PLAN.md`), Wave 1 exit (§5 row at
`:214`). Follow-up to the health-native handover (`.kiro/specs/health-native/handoff.md`, "What Kiro does
next" → first native backlog item `native-g1-wiring`). Plan block: `plan.md`. Lanes: `lanes/*.md` (5, all
`ready`, disjoint `paths`).

Builds the per-profile env + build-profile scaffolding and a local **fixture-gateway** smoke that proves
the Wave 1 exit path (navigate the shell + receive a push + open its deep link) offline, because the G1
isolated test backend is an **owner-only gate that does not exist yet** (program §2a
`NATIVE-APP-PLAN.md:95`; health-native handoff "Waiting on the owner" #4). The single step that points a
build at the **real** G1 is the `real-g1-switch` lane, `next_actor: owner`, and never points any build at
production or staging.

## Log
### 2026-10-17T10:56Z · <kiro-session-id> · created → drafted
Holder of the `native-g1-wiring/_plan` claim (to be claimed before pushing the plan PR). Wrote
requirements, design, tasks, plan and 5 lane files. Measured on the worktree (same as origin/main):
parity ledger `apps/mobile/parity/ledger.json` v2 = 435 route rows (428 not_started / 5 in_progress /
2 exception), 15 shell entries (all in_progress, owner N3 VTID-05186), 4 native_only; Wave 1 N3 shell
(`apps/mobile/src/shell/`) + N2 UI kit (`apps/mobile/src/ui/`) already on main, only screen rows
non-not_started are `/maxina` + `/alkalma`; no `eas.json` yet. Computed lane paths from the existing tree
so no file belongs to two lanes and no in-scope file is orphaned; `build-profiles` is the only lane that
touches a governance path (`.github/**`) and is `executor: claude`. No VTID allocated, no product code
changed, no live system touched, no build pointed at any real host.
Next: PLAN-SPAR spars the `plan(native-g1-wiring)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd`
claims `env-profiles` first (the others depend on it or on `fixture-gateway`), and `real-g1-switch` waits
for the owner to provision G1.

### 2026-10-17T14:17Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T14:44Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:33Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T18:48Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T19:31Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T20:11Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T07:59Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T14:53Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T21:03Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-20T08:41Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 7 lane(s) got a VTID and are handed to Kiro.
