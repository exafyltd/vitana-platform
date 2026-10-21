---
lane: frontend-placement
state: executing
next_actor: claude
vtid: VTID-05210
seat: exafyltd
area: frontend
depends_on: []
claimed_by: kiro-202610151240-0371
branch: kiro/profile-vitana-cards/frontend-placement
pr: https://github.com/exafyltd/vitana-v1/pull/1428
updated: 2026-10-15T17:30Z
---
# Card list and placement on `/me/profile` (vitana-v1)

Tasks: lane `frontend-placement` in `tasks.md`. Design: `design.md` §1–§2. VTID: VTID-05210 (allocated, `in_progress`/`approved`). Repo: vitana-v1. Rules for the executor (collaboration §7a): no VTID allocation, no merge/approve/deploy, no Supabase/AWS writes — DB changes are migration files in this lane's PR. Copy `.kiro/specs/profile-vitana-cards/plan-sparring.md` to `docs/validation/VTID-05210/plan-sparring.md` in your PR and add `scope.json`, `acceptance.md` and `staging-tests.json` there. Sparring decisions that bind you are in the handoff log (2026-10-15T16:00Z).

## Log
### 2026-10-15T13:20Z · kiro-202610151240-0371 · created → ready
Drafted. next_actor: claude (spar → Gate 1 → allocate the VTID).

### 2026-10-15T14:10Z · kiro-202610151240-0371 · ready (revised)
Owner answers: E6/E7 stay on the profile (list E1–E7, E11, G1; carousel maxCards 8); placement as proposed. next_actor: claude.

### 2026-10-15T14:15Z · session_012cmH1XjbSwZqQxxAbKu321 · ready → ready (handed to Kiro)
Owner approved the plan at Gate 1; VTID-05210 allocated. Lane handed to Kiro: `next_actor: kiro`, seat `exafyltd`. Start by claiming the lane.

### 2026-10-15T17:30Z · kiro-202610151240-0371 · ready → executing (implementation complete, PR open)
Implemented A1–A5 in exafyltd/vitana-v1#1428 (branch `kiro/profile-vitana-cards/frontend-placement`).
- A1: `PROFILE_ENRICHMENT_CARDS`; `CARD_SCREENS.profile` with `allow: [E1–E7, E11, G1]` and `features: []`.
- A2/A3: both strips moved out from above the ID card.
  - Mobile: the Posts tab, after the Autopilot banner, before the Cover Library tile.
  - Desktop: below `<ProfileLayout>`, before the tile.
  - G1 first in both layouts. maxCards is `PROFILE_ENRICHMENT_CARDS.length` (8).
- A4: tests.
  - `feature-cards.test.tsx`: the profile pin.
  - New `EnrichmentCardStrip.profile.vtid-05210.test.tsx`, with a full registry stub.
  - New source-order test `EditProfilePage.card-placement.vtid-05210.test.ts`. A page render needs too many
    providers, so it follows the repo's `*.routing.test.ts` pattern.
  - The new tests fail on main and pass on head. Full suite: 434 files / 3,428 tests green.
  - PR-GATE scope, sparring, weakening, red-green and migrations pass locally. No new ESLint or tsc findings.
- A5: new read-only staging spec `vtid-05210-profile-card-placement.staging.spec.ts` (phone + desktop).
  - It needs a test hook: `data-testid="profile-id-card"` on both ID-card switchers.
  - The VTID-05085 spec's profile expectation now follows the new card list.
- `docs/validation/VTID-05210/`: plan-sparring.md (copied), scope.json, acceptance.md, staging-tests.json.

Kiro did not merge, deploy or write to any live system. There are no open questions.

Next actor, Claude:
1. Review exafyltd/vitana-v1#1428 against tasks.md Lane A and CI.
2. Move this lane executing → in-review → verified.
3. Merge, then watch STAGING-VERIFY.

The lane stops at `executing` in this PR because `queue.mjs validate` allows one transition per PR.

