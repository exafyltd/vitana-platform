# VTID-05366 — Messenger Vitana cards: 11 profile-enrichment moments in the Vitana companion DM

Plan: `messenger-vitana-cards-v2` — CI PLAN-SPAR session `89e98eb8-922e-4c04-8de2-6bf56dbcd74b`, CONVERGED and approved
by policy `converged-auto-v1` (2026-10-28T10:25Z), final plan hash `e932e462…e0bf`. Record:
`.kiro/specs/messenger-vitana-cards-v2/sparring/verdict.md` (plan PR #4425). Lane `companion-enrichment-moments`,
depends on `companion-enrichment-signals` (VTID-05367).

**Nothing is sent by this change in any environment.** The companion engine stays `disabled-on-staging` and off in
production unless `COMPANION_SEND_ENABLED=true` and a send mode are set; this change sets neither. Once sending is on,
a member with an unfinished profile and no health/habit moment due gets one enrichment card a day in the Vitana DM.

AC-1 One moment per enrichment card E1–E11 (`enrichment_e1` … `enrichment_e11`); a moment fires only when the tick put
its card in `MemberContext.eligibleEnrichmentCardTypes` (not done, not dismissed in the last 7 days, available on this
stack). Moments never call the resolver and never build a `Date`.
TEST: services/gateway/test/vtid-05366-companion-enrichment-moments.test.ts

AC-2 Absolute companion-scale priorities E1=39 … E11=29 (R2-F3/R3-F1): the Vitana Index (50–70), a lapsed diary (40–50)
and the Guided Journey step (65) always win; even E11 beats feature_tip (20) and invite_friend (15).
TEST: services/gateway/test/vtid-05366-companion-enrichment-moments.test.ts

AC-3 Topic and repeat windows (R1-F2, R2-F2): E3/E6/E7 are `community` (never offered when the member switched community
off), the rest `null`; repeatAfterDays 4 for E1/E2/E4/E5/E11 and 7 for E3/E6/E7/E8/E9/E10.
TEST: services/gateway/test/vtid-05366-companion-enrichment-moments.test.ts

AC-4 Wording (rule 41, R3-F2): one English composer intent that opens "Greet the member…" and contains no quoted
sentence; the card's English title/description travel as `facts`; the DM card itself carries the card id and numbers
only (`cardParams`), so the card face comes from the client catalog.
TEST: services/gateway/test/vtid-05366-companion-enrichment-moments.test.ts

AC-5 End to end through the shadow tick with the real bulk reads: a member who set nothing up gets E1; a member who did
everything but Instagram/Facebook gets no E6/E7 while the Meta OAuth client is unset and E6 once it is set; a card
dismissed 2 days ago is skipped for the next one.
TEST: services/gateway/test/vtid-05366-companion-enrichment-moments.test.ts

AC-6 Regression: the VTID-05101 every-moment contract covers all 17 moments with no assertion relaxed; the 05099/05100/
05101 tick suites keep testing their own moments (their helpers get a fully-set-up enrichment stub); every companion
suite stays green.
TEST: services/gateway/test/vtid-05101-companion-generators.test.ts
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts
TEST: services/gateway/test/vtid-05100-companion-delivery.test.ts
TEST: services/gateway/test/vtid-05367-companion-enrichment-signals.test.ts
TEST: services/gateway/test/vtid-05099-proactive-match-daily-limit.test.ts
TEST: services/gateway/test/vtid-05171-companion-wiring.test.ts
TEST: services/gateway/test/companion-qa.test.ts

Local evidence (isolated worktree, `--runInBand`): 8 suites, 181 tests green (the one VTID-05099 endpoint test that hit
the 5 s limit while `tsc` ran in parallel passes alone in 3.5 s); `tsc --noEmit` 0 errors in touched files.

Decisions taken (inside the approved plan, most conservative option):
- One shared composer intent for all 11 cards (the plan allows one template or per-card constants); it reuses the
  existing rule-41 opening so the VTID-05101 intent assertion stays exactly as it was.
- The existing tick suites get a fully-set-up enrichment stub rather than new expectations, so they keep pinning the
  moments they were written for; enrichment selection is pinned in its own suite.
