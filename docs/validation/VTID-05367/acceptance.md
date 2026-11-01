# VTID-05367 — Messenger Vitana cards: bulk enrichment completion + dismissal for the companion tick

Plan: `messenger-vitana-cards-v2` — CI PLAN-SPAR session `89e98eb8-922e-4c04-8de2-6bf56dbcd74b`, CONVERGED and approved
by policy `converged-auto-v1` (2026-10-28T10:25Z), final plan hash `e932e462…e0bf`. Record:
`.kiro/specs/messenger-vitana-cards-v2/sparring/verdict.md` (plan PR #4425). Lane `companion-enrichment-signals`.

**No member-visible change.** This lane only reads data and fills `MemberContext.eligibleEnrichmentCardTypes`; no moment
uses it until VTID-05366. The companion engine stays `disabled-on-staging` and off in production unless
`COMPANION_SEND_ENABLED=true` and a send mode are set; this change sets neither.

AC-1 Bulk reads, one query per source table per chunk of members (never one per member): profiles enrichment fields,
any post, active Instagram/Facebook connections (`is_active` and not disconnected), an enabled calendar app, any
contact, a live device token (not revoked, FCM token present), and `user_enrichment_cards` dismissal rows.
TEST: services/gateway/test/vtid-05367-companion-enrichment-signals.test.ts

AC-2 Completion is false-initialized for all 11 cards (R1-F3): a member with no source rows, not even a `profiles` row,
has E1–E11 = false (eligible), never absent. The rules are the shared pure `computeCompletions`, so they match the
`GET /api/v1/enrichment-cards` route.
TEST: services/gateway/test/vtid-05367-companion-enrichment-signals.test.ts

AC-3 The seam never throws (R2-F2): every read is in `Promise.allSettled`; a failed source is named in the tick result's
new `enrichment_unavailable` field (kept apart from `signals_unavailable`) and the tick continues. On ANY failed source
no member gets enrichment state that tick (empty maps), so unknown state can never look "not done" and no enrichment
card is offered; the other moments run as usual.
TEST: services/gateway/test/vtid-05367-companion-enrichment-signals.test.ts

AC-4 The tick computes `eligibleEnrichmentCardTypes` per member with the real tick `now` (R3-F1) through
`eligibleEnrichmentCards(completions, dismissRows, 'messenger', now, unavailableEnrichmentCards())`: a card dismissed 3
days ago is hidden, 8 days ago it is back; E6/E7 are hidden while the Meta OAuth client is unset and offered once it is
set (R2-F3).
TEST: services/gateway/test/vtid-05367-companion-enrichment-signals.test.ts

AC-5 Regression: every existing companion suite stays green.
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts
TEST: services/gateway/test/vtid-05099-proactive-match-daily-limit.test.ts
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts
TEST: services/gateway/test/vtid-05171-companion-wiring.test.ts
TEST: services/gateway/test/companion-qa.test.ts

Local evidence (isolated worktree, `--runInBand`): the 4 suites run together 95/95; companion-qa, proactive-match and
05171 green; `tsc --noEmit` 0 errors in touched files.

Decisions taken (inside the approved plan, most conservative option):
- Enrichment read failures are reported in a separate `enrichment_unavailable` tick field instead of being merged into
  `signals_unavailable`, which the VTID-05101 suite pins exactly (plan R1-F5 names this field).
- The lane file declares `docs/validation/**` so this suite can ship with the lane (rule 47).
