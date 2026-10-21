# ORB Recovery — Observability dashboard + E2E flow (ORB-6, DEV-COMHU-0506)

Companion reference for ORB Recovery Phase 6. Two deliverables: dashboard panels
that extend the Phase D cockpit, and the synthetic browser flow spec (which needs a
real deployed surface + Playwright, so it's documented here for the human to run).

## 1. Dashboard panels (extend Phase D `/command-hub/voice-budget.html` cockpit)

All panels read OASIS events emitted by the recovery phases. Add as cards/queries on the
existing cockpit. Each row is `event type → what it surfaces → why it matters`.

| Panel | OASIS source | Surfaces |
|---|---|---|
| Anonymous on authenticated surface | `orb.session.identity.resolved` where `payload.anonymous_on_authenticated_surface = true` | The ORB-1 widget anonymous-drift bug, observed from outside. Should trend to ~0 after the auth-contract fix deploys. |
| Repeated daily greeting within 15 min | `orb.session.continuity.persisted` + greeting telemetry, or absence of `skip` policy on quick reopen | The ORB-2+3 regression (re-greeting on reopen). |
| Greeting selected but no audio scheduled | `orb.live.greeting.delivered` without a following audio frame; `voice.instruction.budget_trimmed` correlation | The original "Vitana won't talk" class. |
| Autopilot offer without executable CTA | continuation telemetry where `cta.type='ask_permission'` AND `cta.onYesTool` missing | The ORB-5 contract gap — should be 0 after deploy. |
| Tool activation failures by reason | `guide.initiative.executed` failures + `activate_recommendation` error reasons (`recommendation_not_found` / `recommendation_belongs_to_another_user`) | Truthful-fallback health (ORB-5). |
| Speaking-state watchdog fires | `[VTOrb] speaking-state watchdog` client logs (Cloud Logging) | ORB-0.1 — how often the cross-provider backstop has to intervene. |
| Audio-ready ack latency | `orb.session.audio_ready.acked` vs session start | ORB-4 — how often the 3s greeting-gate timeout is hit vs a real ack. |

Suggested implementation: a `GET /api/v1/admin/orb-recovery-health?window=24h` route
that aggregates these `oasis_events` counts, rendered as a second card on the existing
voice-budget cockpit page (DEV-COMHU marker required for the Command Hub edit).

## 2. Synthetic browser flow (Playwright — run on a deployed surface)

Cannot run in the autonomous sandbox (no browser, no prod network). Run after deploy
on `vitanaland.com` (community) — NOT Command Hub (dev persona).

```
Login (e2e-test@vitana.dev) → open ORB → receive greeting audio
  → close 60s → reopen → assert NO first-time greeting (policy skip/brief_resume)
  → trigger an autopilot recommendation offer → say "yes"
  → assert activate_recommendation invoked with the rec id (not "I have no access")
```

Run twice:
1. Vertex active (default).
2. LiveKit canary forced on (`voice.livekit_canary_enabled` + allowlist the e2e user).

Acceptance:
- Greeting audio plays on first open (watchdog silent).
- Reopen within 60s → no first-time greeting (`orb.session.identity.resolved` shows
  authenticated; greeting policy = skip/brief_resume).
- Autopilot "yes" → activation succeeds; unauthorized variant → truthful fallback.
- Both providers pass.

## 3. Test suites shipped in-repo (ORB-6 + earlier phases)

| Suite | Phase | Status |
|---|---|---|
| `test/frontend/orb-widget-speaking-watchdog.test.ts` | 0.1 | ✓ in #2431 |
| `test/frontend/orb-widget-auth-reactive.test.ts` | 1 | ✓ in #2432 |
| `test/frontend/orb-widget-continuity.test.ts` | 2+3 | ✓ in #2435 |
| `test/services/orb-session-state.test.ts` | 2+3 | ✓ in #2435 |
| `test/services/wake-cadence-signals.test.ts` (recordWakeTurn) | 2+3 | ✓ in #2435 |
| `test/frontend/orb-widget-audio-ready.test.ts` | 4 | ✓ in #2437 |
| `.../autopilot-recommendation.test.ts` (CTA contract) | 5 | ✓ in #2438 |
| `test/services/orb-recovery-greeting-cadence.test.ts` | 6 | ✓ this PR |

The synthetic browser flow + the dashboard route are the only ORB-6 items that require
a deployed surface / Command Hub edit; both are specified above for the human to land.
