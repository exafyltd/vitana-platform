# Journey Conversation V2 — Governance Spec

VTID: VTID-03307 (spec approved 2026-06-12); implementation PR: exafyltd/vitana-platform#2672
Detailed design spec: `docs/SPEC-journey-conversation-v2.md`

## Goal

Recenter the Vitana Assistant voice conversation flow around the My Journey
guided learning experience — maturity-aware, journey-aware, Life-Compass-aware,
Diary-aware, Autopilot-aware, community-aware, frequency-capped — without
building a parallel assistant architecture. One proactive arbiter replaces the
three competing proactive selectors; speech is generated from structured
intents instead of fixed paragraphs; all behavior ships behind the
`vitana_journey_conversation_v2_enabled` system control (default OFF).

## Non-negotiable Governance Rules Touched

- No new tables; reuses `user_journey`, `user_guided_journey_state`,
  `journey_checklist_topics`, `user_proactive_pause`, `user_proactive_touches`,
  `user_feature_introductions` (no schema change, no `DATABASE_SCHEMA.md` change).
- OASIS event discipline: only decision telemetry through the existing
  `emitGuideTelemetry` channel (`guide.focus.*`); no polling/heartbeat events.
- Tool execution stays consent-gated (`save_diary_entry`,
  `activate_recommendation` fire only on explicit user yes).
- Server-side i18n hard rule respected: generated speech carries the mandatory
  language directive; system instructions remain English per CLAUDE.md §13b.
- Staging-first CI/CD: merge deploys staging only; prod via PUBLISH button.

## Scope

Gateway only (`services/gateway`). Voice/community brain path. No frontend
changes (guided/full mode is read server-side from
`user_guided_journey_state.mode`). No deploy-workflow changes.

## Changes

1. `UserAwareness.journey_v2` optional extension block, built fail-open.
2. Deterministic maturity model (`ExtendedTenureStage`,
   `JourneyExperienceLevel` with capped additive scoring + calendar guards +
   `returning_low_data` backfill floor).
3. Single proactive arbiter `pickConversationFocus` (one focus per turn,
   spec §7 priority order; scoped pauses skip, blanket pauses suppress).
4. Structured speech intents with anti-repetition memory and locale rule.
5. Presence-pacer surface `vitana_responsibility_message` (once/day).
6. Flag-gated wiring in `vitana-brain.ts`; legacy path identical when off.

## Files to Modify

- `services/gateway/src/services/guide/journey-experience.ts` (new)
- `services/gateway/src/services/guide/awareness-extensions.ts` (new)
- `services/gateway/src/services/guide/conversation-focus.ts` (new)
- `services/gateway/src/services/guide/speech-intent.ts` (new)
- `services/gateway/src/services/guide/journey-conversation-v2.ts` (new)
- `services/gateway/src/services/guide/{types,awareness-context,presence-pacer,guide-telemetry,index}.ts`
- `services/gateway/src/services/vitana-brain.ts`
- `services/gateway/src/types/cicd.ts`
- 5 new test suites under `services/gateway/test/`

## Acceptance Criteria

- With the flag OFF, the legacy conversation path is byte-for-byte unchanged.
- With the flag ON, exactly ONE proactive focus per turn; overdue Autopilot
  events outrank missing Life Compass; missing user-defined Life Compass
  outranks optional recommendations; system-seeded goal counts as missing.
- Mature/long-tenured users are never classified first-time
  (`returning_low_data` floor) and never receive beginner explanations.
- Same-day return sessions get a short greeting, never a second deep
  inspiration; responsibility message max once/day via pacer.
- Generated speech blocks always carry the language rule (no English leakage).
- All consent-gated tools fire only after explicit user consent.

## Verification Steps

- `npx tsc --noEmit` clean; `npm run build` clean (run on PR branch).
- 47 new unit tests green across 5 suites (maturity scenarios, arbiter
  ordering/pauses/consent, speech intents, awareness builder, composed block).
- Full gateway jest: 347/348 suites (single failure `nav-manifest-sync`
  reproduced identically on clean main — pre-existing catalog drift).
- Post-merge: verify on staging (`env=staging`), enable flag for a dev user,
  confirm one-focus behavior and telemetry `guide.focus.selected` events.

## Rollback Plan

Disable the `vitana_journey_conversation_v2_enabled` system control (no
deploy needed — DB-backed control, ~30s propagation). Full code rollback =
revert PR #2672; no schema or data migration to unwind.

## Risk Level

Low — default-off feature flag, fail-open extension fetches, legacy path
preserved as automatic fallback, no schema changes, no prod deploy on merge
(staging-first cutover active).
