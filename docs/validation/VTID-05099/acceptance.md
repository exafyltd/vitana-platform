# VTID-05099 — Vitana Companion Messages, Phase 1: engine (shadow only)

Plan: Vitana Companion Messages — sparred 5 rounds, CONVERGED, owner approved 2026-10-12. Record: `docs/validation/VTID-05099/plan-sparring.md` (plan hash `494738ed…ba63`). Phases 2–4 are VTID-05100/05101/05102.

Phase 1 decides, for each member inside their local morning window, the one moment (and Unified Card System card) Vitana would bring today, records it in `companion_messages_ledger` as a shadow row, and composes a capped sample. **It sends nothing.**

AC-1 Moments and cards: `vitana_index` → card F2 when the member has a score, otherwise `morning_greeting` → card F4; the health topic switch is respected; the Index is not repeated within 3 days; every moment carries an English intent and never a finished sentence (CLAUDE.md rule 41).
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

AC-2 Mode: never on staging (shared database); off without FEATURE_COMPANION_MESSAGES_ENV live or COMPANION_MODE=shadow; COMPANION_MODE=staff|live still runs shadow in Phase 1 (`send_not_available`); defaults 07:30–09:30 local window, 20 composed samples a day, Bedrock models; invalid settings fall back to the defaults.
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

AC-3 Composer: Claude on Bedrock for primary AND fallback (per-call overrides), localized du-form system prompt, intent + facts only; a non-Bedrock answer, a failed, thrown or truncated call, or text that fails validation (empty, > 700 chars, link, markdown, wrong script) is a skip — never a template.
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

AC-4 The shadow tick: only members whose local time is inside the window; the Vitana bot and strict-excluded test/service accounts never decided (a failed exclusion lookup skips the tick); opted-out members skipped; once per member per local day (any ledger row today, including a real match DM, means no decision); an onboarding touch sent today means no decision; the presence pacer is respected; anti-repeat reads the ledger; compositions capped per day; writes no table and calls only the claim/finish RPCs; one aggregate `companion.tick.completed` per tick that decided something, none when nobody was in the window.
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

AC-5 The tick enforces X-Gateway-Internal itself whatever SCHEDULED_NOTIFICATIONS_AUTH_MODE says (401 missing, 403 wrong); the staging gateway refuses it with 409 even with a valid token; off by default in production; GET /api/v1/companion/status returns only the mode.
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

AC-6 The proactive match message (VTID-01270) claims the member's one proactive Vitana DM for their local day (live, proactive_match, new_match, card F5) before it sends; a refused claim skips the DM and the push; a ledger error fails open; a failed chat insert marks the slot failed; no matches → no claim.
TEST: services/gateway/test/vtid-05099-proactive-match-daily-limit.test.ts

AC-7 Migration `20261012200000_vtid_05099_companion_messages.sql`: one real proactive DM per member per local day across senders (partial unique index), shadow rows never block a real send and are once per day themselves, `finish_companion_message` moves only pending rows, `mark_companion_replied` marks the latest unreplied real send only, preference defaults (business off), functions service_role only, ledger not client-readable, RLS on both tables; the pacer CHECK gains `messenger_companion` (live surfaces read first, 2026-10-12). Applied to a throwaway Postgres twice, 31 checks; an unknown live surface aborts the whole migration with nothing half-applied.
TEST: docs/validation/VTID-05099/pglite-companion-messages-check.mjs (outputs/pglite-companion-messages.txt)

AC-8 The pacer's TypeScript surface union and the latest migration's CHECK list the same surfaces.
TEST: services/gateway/test/vtid-04892-onboarding-journey-pacer.test.ts

AC-9 The new route file is claimed by the `community` atlas domain; the role-separation suite stays green; the EventBridge job list gains exactly `gateway-companion-tick`.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts

Decisions taken (inside the approved plan, most conservative option):
- The engine never runs on staging, not even in shadow (onboarding-coach precedent, VTID-04892): staging shares the production database.
- Bedrock primary + fallback are per-call overrides (VTID-05077 pattern) instead of a new `llm_routing_policy` stage — same guarantee, smaller change.
- A member who already had an onboarding-coach touch that day is skipped (one Vitana touch a day).
- DM delivery, the push type and the reply hook ship with Phase 2 (VTID-05100), when sending starts.
- `automation-handlers/{sharing,onboarding}-growth.ts` now use the canonical Vitana bot id (plan §E).

ROUTE_MOUNT: services/gateway/src/routes/companion.ts mounted at /api/v1/companion in services/gateway/src/index.ts (owner 'companion'); POST /companion-tick added to services/gateway/src/routes/scheduled-notifications.ts (mounted at /api/v1/scheduled-notifications)
FINAL_URL: GET /api/v1/companion/status; POST /api/v1/scheduled-notifications/companion-tick
CURL_PROOF: staging checks in docs/validation/VTID-05099/staging-tests.json — GET status returns JSON `mode: disabled-on-staging`; an untokened POST to the tick returns 401 JSON (rejected probe, no write).

OASIS_IMPACT: yes
OASIS_PROOF: one `companion.tick.completed` per tick that decided something, with its counters (services/gateway/src/services/companion/companion-service.ts; topic added to src/types/cicd.ts). No per-member events.
