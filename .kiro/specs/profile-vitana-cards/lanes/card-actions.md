---
lane: card-actions
state: executing
next_actor: claude
vtid: VTID-05212
seat: exafyltd
area: frontend
depends_on: []
claimed_by: kiro-202610151240-0371
branch: kiro/profile-vitana-cards/card-actions
pr: https://github.com/exafyltd/vitana-v1/pull/1430
updated: 2026-10-15T20:30Z
---
# Card actions that work (vitana-v1)

Tasks: lane `card-actions` in `tasks.md`. Design: `design.md` §3. VTID: VTID-05212 (allocated, `in_progress`/`approved`). Repo: vitana-v1. Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes are migration files in this lane's PR. Copy `.kiro/specs/profile-vitana-cards/plan-sparring.md` to `docs/validation/VTID-05212/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there. Sparring decisions that bind you are in the handoff log (2026-10-15T16:00Z).

## Log
### 2026-10-15T14:10Z · kiro-202610151240-0371 · created → ready
Drafted from the owner's request "all action buttons within all the Vitana cards should actually work".
next_actor: claude.

### 2026-10-15T14:26Z · session_012cmH1XjbSwZqQxxAbKu321 · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID-05212 allocated. Lane handed to Kiro: `next_actor: kiro`, seat `exafyltd`. Start by claiming the lane.

### 2026-10-15T20:30Z · kiro-202610151240-0371 · ready → executing (implementation complete, PR open)
Implemented C1–C7 in exafyltd/vitana-v1#1430 (branch `kiro/profile-vitana-cards/card-actions`).
- **C1 G1:** `firstOpenProfileStep()` reads the cached `screen=profile` list only, with fallback `/me/profile#about`.
  On `/me/profile` the tap now opens the editor.
- **C2 F4:** `activateOrb()` first, else `/comm/talk-to-vitana`, which is now `CARD_DEEP_LINKS.F4`. The fix is in one
  component, so chat gets it too.
- **C3 E8/E9:** `/connectors?tab=productivity#calendar|#contacts`. A new `useHashScroll` scrolls to the Mail, Calendar &
  Contacts anchor on desktop and mobile and consumes the hash.
- **C4 F8:** resets `busy` when there is no URL, and sends no extra decline.
- **C5:** `?return=mobile` plus the bounce overlay and poller for instagram/facebook in Appilix. A completed connect
  invalidates `enrichment-cards`. Gateway check from sparring F2: `buildCallbackRedirect` honours the signed
  `returnMode` for every provider, so C5 was not reduced.
- **C6:** click tests for every card, standalone and inside `VitanaChatCard`.
- **C7:** read-only staging spec `vtid-05212-card-actions.staging.spec.ts` (phone + desktop: the E8/E9 anchor, and G1
  opening an editor). The per-card matrix is in `docs/validation/VTID-05212/card-actions.md`. Kiro cannot sign in to
  staging from its sandbox, so the staging column is recorded by STAGING-VERIFY.

Results:
- Full Vitest 437 files / 3,468 tests green.
- PR-GATE scope, sparring, weakening, red-green (5 files fail on base) and migrations pass locally.
- No new ESLint or tsc findings.
- No i18n keys were added, so the F8 sparring condition (`i18n:inventory`) does not apply.

Kiro did not merge, deploy or write to any live system.

Next actor, Claude:
1. Review against tasks.md Lane C and CI.
2. Move the lane executing → in-review → verified.
3. Merge.
4. Watch STAGING-VERIFY.

