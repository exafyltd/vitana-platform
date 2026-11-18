# VTID-05588 plan sparring record (companion-test-card, lane `gateway-test-card`)

The plan `companion-test-card` (an exafy admin sends one Vitana companion card to themselves, now) was sparred by CI
(`PLAN-SPAR.yml`) with the independent partner. The full record is in the plan's spec folder; this file states what the
PR-GATE sparring check reads.

- Spec: `.kiro/specs/companion-test-card/` (plan PR #4750, merged as `2b9356e041`).
- Verdict: CONVERGED after 2 rounds, session `97e421c8-09eb-4d71-94b8-bb09b5d32ff1`. Round 1 returned three findings
  (R1-F1 major, R1-F2 and R1-F3 minor), all accepted in `.kiro/specs/companion-test-card/sparring/responses-1.md` and
  applied to the plan block. Round 2 converged with one new minor finding, R2-F1: `getServiceClient()` is local to
  `scheduled-notifications.ts`; `getSupabase()` (`services/gateway/src/lib/supabase.ts:5`) is already a service-role
  client. This lane therefore uses `getSupabase()`, which keeps the plan's intent (a service-role client for the
  Vitana-bot-sender insert); recorded in `handoff.md` and listed under Decisions taken for Gate 2.
- Plan hash: `70f1f7ce49198ee4cd26e574e2c0b96978b1dd25e4fc773c248cac7fef53969b` (final plan hash, `sparring/verdict.md`).
- Owner approval: by policy `converged-auto-v1` at 2026-11-06T17:07:22.779+00:00. Owner decision 2026-10-14
  (VTID-05214/05218, CLAUDE.md "Policy approval replaces Gate 1 for CI-sparred plans") makes this the approval of a
  converged, CI-sparred plan; the `vtid_ledger` accepted it when CI allocated this lane's VTID. The owner asked for this
  work in Kiro Web session `kiro-exafy-202611061658-9ca9` on 2026-11-06 (option 3, admin-only test send).
- VTID: VTID-05588 (lane `gateway-test-card`), allocated by CI PLAN-SPAR, not by hand.
- Source record: `.kiro/specs/companion-test-card/sparring/verdict.md`, `round-1.md`, `responses-1.md`, `round-2.md`,
  `state.json` (on origin/main at `2b9356e041`).
