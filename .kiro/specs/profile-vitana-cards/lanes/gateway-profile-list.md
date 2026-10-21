---
lane: gateway-profile-list
state: executing
next_actor: claude
vtid: VTID-05211
depends_on: []
claimed_by: kiro-202610151240-0371
branch: kiro/profile-vitana-cards/gateway-profile-list
updated: 2026-10-15T19:00Z
---
# Gateway profile card list (vitana-platform)

Tasks: lane `gateway-profile-list` in `tasks.md`. Design: `design.md` §1. VTID: VTID-05211 (allocated, `in_progress`/`approved`). Repo: vitana-platform. Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes are migration files in this lane's PR. Copy `.kiro/specs/profile-vitana-cards/plan-sparring.md` to `docs/validation/VTID-05211/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there. Sparring decisions that bind you are in the handoff log (2026-10-15T16:00Z).

## Log
### 2026-10-15T13:20Z · kiro-202610151240-0371 · created → ready
Drafted. next_actor: claude (spar → Gate 1 → allocate the VTID).

### 2026-10-15T14:10Z · kiro-202610151240-0371 · ready (revised)
Profile list now E1–E7, E11. Added B2: hide E6/E7 while the Meta OAuth credentials are not configured (R7). next_actor: claude.

### 2026-10-15T14:19Z · session_012cmH1XjbSwZqQxxAbKu321 · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID-05211 allocated. Lane handed to Kiro: `next_actor: kiro`. Start by claiming the lane.

### 2026-10-15T19:00Z · kiro-202610151240-0371 · ready → executing (implementation complete, PR open)
Implemented B1–B3 on `kiro/profile-vitana-cards/gateway-profile-list` (this PR).

- **B1:** `SCREEN_ENRICHMENT_CARDS.profile` is now `['E1','E2','E3','E4','E5','E6','E7','E11']`. This matches the
  frontend allow list (VTID-05210, merged as c35c2560).
- **B2:**
  - New `services/enrichment/card-availability.ts`: `unavailableEnrichmentCards(env)` returns E6/E7 when their OAuth
    client (id and secret) is missing. It reuses the existing `isProviderConfigured()` (VTID-04402) rather than adding a
    second helper.
  - `eligibleEnrichmentCards` takes an optional `unavailable` set, so the catalog stays pure. The route passes it in.
  - Effect: E6/E7 are hidden on every screen until the Meta app's four values are provisioned, then come back with
    no deploy. `profile_completion_pct` is unchanged.
- **B3:** `test/routes/enrichment-cards.test.ts`.
  - The suite's default is now "Meta configured", so the existing expectations still hold.
  - The profile row is updated.
  - New cases cover each of home, profile, community and messenger with neither client and with Facebook only, plus
    id-without-secret, the cards coming back, `profile_completion_pct` unchanged, and the pure rule.
  - `docs/validation/VTID-05143/pglite-unified-card-system-check.mjs` does not pin screen lists, so it needed no change.
- **Results:** Jest enrichment suites 139/139 green. `tsc --noEmit` clean. PR-GATE scope, sparring, weakening and
  red-green were run locally.
- **Validation docs:** `docs/validation/VTID-05211/` holds plan-sparring.md (copied), scope.json, acceptance.md and
  staging-tests.json (read-only http probes).
- **Deployment note:** the staging and prod gateways have no Meta OAuth clients today (read-only check 2026-10-15),
  so after deploy E6/E7 disappear on both until lane `meta-oauth` resumes.

Kiro did not merge, deploy or write to any live system.

**Next actor: Claude.** Review against tasks.md Lane B and CI, move the lane executing → in-review → verified, then
merge and watch STAGING-VERIFY.

