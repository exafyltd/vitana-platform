---
lane: colours-batch-3
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
claimed_by: kiro-202610152203-0347
paths:
  - src/components/sharing/**
  - src/components/community/**
  - src/components/event-game/**
  - src/components/liverooms/**
  - src/components/meetups/**
  - src/components/events/**
  - src/components/crossover/**
  - src/components/feed/**
  - src/components/home/**
  - src/pages/Community.tsx
  - src/pages/community/EventsAndMeetups.tsx
  - src/pages/community/FindPartner.tsx
  - src/pages/community/GroupDetail.tsx
  - src/pages/community/Groups.tsx
  - src/pages/community/LiveRooms.tsx
  - src/pages/community/TalkToVitana.tsx
  - src/pages/sharing/CampaignDetail.tsx
  - src/pages/sharing/Campaigns.tsx
  - src/pages/sharing/DataConsent.tsx
  - tests/e2e/staging/vtid-*-colours-batch-3.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
updated: 2026-10-21T23:30Z
vtid: VTID-05287
---
# Raw palette GåÆ tokens, batch 3 (owner decision 1, option A) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` GÇö `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: colours-batch-3 -->`
(tasks K3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 81 files with findings in this lane's paths GÇö `design/no-raw-palette` 608 -+ `design/no-arbitrary-size` 87 -+ `design/no-physical-direction` 2 -+ `design/no-raw-content-card` 7.

**Goal.** Clear every `design/*` finding in the 81 files of this batch: raw palette GåÆ nearest existing token (SPOTLIGHT_RULES -ºE + the extended mapping in design.md -º2), arbitrary sizes per decision 2, raw `Card` GåÆ `VCard`/`Panel` per design.md -º4, leftover physical directions per design.md -º5.

**Acceptance (the reviewer seat checks these):**
- `design/*` = 0 in every owned file (escape-hatch lines only with a reason); design + ESLint baselines lowered for these files only, every other entry byte-identical.
- No `dark:` palette pairs left; no file worse on any rule (`gate.mjs ratchet-design` green vs base); Vitest + build + lint green.
- PR body lists the colour shifts by category (status / category / surface / text / overlay / gradient) for the Gate 2 review.
- Staging spec (read-only): the batch's main routes at 1440 `?spotlight=1` and 390 render without console errors and pass the design-contract structural checks.
- `npx vitest run`, `npm run build`, `npm run lint` green; PR-GATE design ratchet and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's spec) and
  `plan-sparring.md` (copy of the plan's sparring record).

**Shared files.** `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` are the only paths every lane lists
(each lane lowers its own entries; on a merge conflict rebase and regenerate with `gate.mjs baseline-design|baseline-eslint`).

**Never** (collaboration -º7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z -+ kiro-202610152203-0347 -+ created GåÆ ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/colours-batch-3 --session <id>`).

### 2026-10-21T09:24Z -+ ci-plan-spar -+ ready (VTID allocated)
VTID-05287 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z -+ kiro-202610152203-0347 -+ VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.


### 2026-10-22T14:30Z - kiro-202610152203-0347 - merged to main (done)
PR #1457 (VTID-05287) merged to vitana-v1 `main`. merge: `141eeaa3808e1033eea72826b1c6c7813c144d04`.
Baseline conflict resolved by regenerating design/eslint baselines from eslint on the merged tree; every batch-3-owned
src file reads 0 in the regenerated design baseline. All required checks green (Vitest, pr-gate incl. design ratchet,
Lane scope). No shared-constant (index-look-style) issue: batch-3 changed no `src/lib/*` constant and no owned page
imports a shared design-const module. preview-deploy is a non-required check (was Actions-queue-stuck) and did not
block. authority: owner instruction 2026-10-21 (full automation to verified staging, collaboration.md section 7b).