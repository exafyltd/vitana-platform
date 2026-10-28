# Plan sparring record — VTID-04869 (Command Hub Overview, Phase 0)

Phase 0 of Plan A, the Command Hub Overview supervisor cockpit. Full plan with every revision and
the planner's responses: [`plan-A-overview.md`](./plan-A-overview.md). File sha256 at owner
approval: `b18acf2088bb2f98cec7db062cb87d2dd758d54b488beae34370c2af3efd7ee3`.

- **Producer:** claude-code (session_01ESw1mpd9mLUjEmXG7d2Gd5)
- **Class:** standard
- **Partner:** read-only general-purpose subagent, using the same model as the planner. This
  first run predates the Opus 4.6 partner.
- **Verdict:** ESCALATED after 3 rounds with 3 owner items. The owner decided them on 2026-10-04,
  making the verdict **CONVERGED**.
- **Owner approval:** "Yes", 2026-10-04, in session.

## Findings ledger

| Round | ID | Sev | Finding (short) | Outcome |
|---|---|---|---|---|
| 1 | F1 | blocker | Aggregator runs inside the gateway it supervises | accepted → staleness/"cockpit blind"; GChat stays the pager; ALB alarm |
| 1 | F2 | blocker | Fan-out polling repeats the VTID-03980 overload on shared Supabase | accepted → on-demand compute, single-flight cache, bounded queries |
| 1 | F3 | major | HTTP loopback to service-token/dev-role routes; inconsistent auth | accepted → in-process builders, exafy_admin only |
| 1 | F4 | major | `ops/action-required` stays public | accepted → gated in Phase 1 |
| 1 | F5 | major | Ack/Snooze can hide P1s; no OASIS event | accepted |
| 1 | F6 | major | No dedup, hysteresis or auto-resolve | accepted |
| 1 | F7 | major | voice-budget-watch is Vertex-era | accepted → dropped from Phase 0 |
| 1 | F8 | major | SNS ingest is new infrastructure | accepted → CloudWatch DescribeAlarms adapter |
| 1 | F9 | major | Phase 1 scope creep | accepted → status bar + queue + 7 adapters |
| 1 | F10 | major | Deep-link contract underspecified | accepted → per-screen checklist and tests |
| 1 | F11–F14 | minor | CSP; accessibility/RTL; notifications; read-only staging spec | accepted |
| 2 | N1 | major | Named in-process builders do not exist | accepted → Phase 1a extraction |
| 2 | N2 | major | Per-task hysteresis inconsistent across tasks | accepted → source-timestamp based |
| 2 | N3 | major | Cognito admin gap | accepted → Command Hub uses Supabase auth today; dependency recorded |
| 2 | N4 | major | Stuck rubric includes session VTIDs | accepted → `isAutonomousExecutionTask`, heartbeat age |
| 2 | N5 | major | Thresholds not measurable from data | accepted → `golden_path` flag, named topics |
| 2 | N6, N7 | minor | build-info cache; kill-switch double count | accepted |
| 3 | N8 | major | Staging and prod share `ops_attention_state` | accepted → `env` in key; owner allowed staging writes |
| 3 | N5 fix | minor | Topic is `cicd.deploy.service.failed` | fixed |

## Owner decisions (2026-10-04)
6. Staging may write `env='staging'` attention state.
7. The staging spec signs in as one of the 2 existing full-access admin test accounts.
8. Add the ALB target-health alarm (separate infrastructure VTID).

## Phase 0 scope (this VTID)
Frontend-only false-signal fixes:
- router state keys
- the shared-health crash
- the undefined `navigateTo`
- CSP inline handlers
- UNKNOWN instead of OPERATIONAL when data is missing
- fetch-failure states
- stale Vertex/Gemini labels
- honest window labels
