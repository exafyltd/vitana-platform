---
lane: public-profile
state: executing
next_actor: kiro
depends_on: [skeletons]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
claimed_by: kiro-202610152203-0347
paths:
  - src/components/profile/**
  - src/pages/EditProfilePage.tsx
  - src/pages/Profile.tsx
  - src/pages/PublicProfilePage.tsx
  - src/i18n/*/spotlightProfile.json
  - tests/e2e/staging/vtid-*-public-profile.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
  - docs/SCREEN_INVENTORY.md
updated: 2026-10-21T23:55Z
vtid: VTID-05291
---
# Public profile `/u/:identifier`, `/me/profile`, `/profile/:id` onto the `detail` archetype (owner decision 4) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` ΓÇö `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: public-profile -->`
(tasks P1ΓÇôP4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 67 files with findings in this lane's paths ΓÇö `design/no-raw-palette` 406 ┬╖ `design/no-arbitrary-size` 39 ┬╖ `design/no-physical-direction` 2 ┬╖ `design/require-screen-frame` 3 ┬╖ `design/no-raw-content-card` 1 ┬╖ `design/no-page-spinner` 1.

**Goal.** Frame `PublicProfilePage` and `EditProfilePage` (both render the shared `ProfileLayout`) with `ScreenFrame archetype="detail"` while Spotlight is on: the profile itself is the one `spotlight` VCard, sections in the stage, compact/row cards in the rail. `/me/profile` is the same layout in edit mode. Phones and flag-off unchanged. Clears every `design/*` finding in `src/components/profile/**` and the three pages (raw palette ΓåÆ nearest token per decision 1; sizes per decision 2; the page spinner via `SpotlightLoading`, which shows the `detail` skeleton on desktop and on mobile ΓÇö owner approved 2026-10-16).

**Acceptance (the reviewer seat checks these):**
- `design/*` = 0 in every owned file (escape-hatch lines only with a reason, listed in the PR body); baselines lowered.
- Vitest: `ProfileLayout` under Spotlight renders exactly one `[data-vcard-size="spotlight"]` and `data-archetype="detail"`; flag off renders today's tree (snapshot of the mobile branch unchanged).
- Staging spec (read-only): `/u/<test user handle>` and `/me/profile` at 1440 with `?spotlight=1` show the sidebar chrome, one spotlight card, no horizontal scroll; at 390 no `data-archetype`.
- Manifest flips are done in lane `remaining-screens` (it owns the manifest); this PR lists the routes it made ready.
- `npx vitest run`, `npm run build`, `npm run lint` green; PR-GATE design ratchet and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's spec) and
  `plan-sparring.md` (copy of the plan's sparring record).

**Shared files.** `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` are the only paths every lane lists (plus `docs/SCREEN_INVENTORY.md`, shared by the three lanes that add copy: regenerate with `npm run i18n:inventory`)
(each lane lowers its own entries; on a merge conflict rebase and regenerate with `gate.mjs baseline-design|baseline-eslint`).

**Never** (collaboration ┬º7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z ┬╖ kiro-202610152203-0347 ┬╖ created ΓåÆ ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/public-profile --session <id>`) after `skeletons` is `done`.

### 2026-10-21T09:24Z ┬╖ ci-plan-spar ┬╖ ready (VTID allocated)
VTID-05291 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z ┬╖ kiro-202610152203-0347 ┬╖ VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.
### 2026-11-01T01:22Z · agent-vitana-lane-reviewer-202611010122-941f · review
review: accept
head: ae09f3045a68c6c03a1089987d3ef3cdf2a5803f
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-v1/pull/1532
Findings: non-blocking only. The staging spec no longer calls the real get_user_profile_by_identifier RPC (the staging guard aborts every POST); supabase/tests/vtid_05041_definer_lockdown.test.sql covers the RPC. Reviewer workflow wf_f4f50d71e7a964db, session sess_6e1654e8-8460-45ba-9989-57acfbf46e11.
Stored by the land step (parent session kiro-ide-202610272306-27b0) on the agent's behalf (`lane-land.md` step 2) in vitana-platform, where this lane's spec lives; the review ran as a separate read-only agent session.
Next: none for the reviewer; merge under collaboration.md §7b once checks are green.
### 2026-11-01T05:03Z · agent-vitana-lane-reviewer-202611010505-f795 · review
review: accept
head: bc993b7467079a8eacdb8c0d1b83793c432a273f
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-v1/pull/1532
Findings: non-blocking only (reviewer session sess_f795330e-780f-4e29-84e0-a2f2ad261067, workflow wf_c61862136ef79711): CI was not re-read on this head, so every required check must be green before merge (land-guard enforces this). The head after update-branch adds only main's commits on top of the earlier accept at ae09f304.
Stored by the land step (parent session kiro-ide-202610272306-27b0) on the agent's behalf (`lane-land.md` step 2) in vitana-platform, where this lane's spec lives; the review ran as a separate read-only agent session.
Next: none for the reviewer; merge under collaboration.md §7b once checks are green.
### 2026-11-01T05:57Z · kiro-ide-202610272306-27b0 · merged
PR https://github.com/exafyltd/vitana-v1/pull/1532 squash-merged by land-guard under collaboration.md §7b (PM merge rule, applied by the plan driver while the PM is not live), no `--admin`: merge commit 9ca55e22e108afba8bd5eddf28c63cb8bd170558 (mergedAt 2026-11-01T05:57:02Z), reviewed head bc993b74; land-guard confirmed every required check green on that head.
