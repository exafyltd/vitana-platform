---
lane: colours-batch-2
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
claimed_by: kiro-202610152203-0347
paths:
  - src/components/health/**
  - src/components/journey/**
  - src/components/supplements/**
  - src/components/diary/**
  - src/components/memory/**
  - src/pages/Health.tsx
  - src/pages/health/ConditionsRisks.tsx
  - src/pages/health/EducationResources.tsx
  - src/pages/health/MyBiology.tsx
  - src/pages/health/PillarsOfHealth.tsx
  - src/pages/health/Plans.tsx
  - src/pages/health/VitanaIndexDetail.tsx
  - src/pages/health/WellnessServices.tsx
  - src/pages/memory/Diary.tsx
  - src/pages/memory/Recall.tsx
  # VTID-05286: shared design-constant source for VitanaIndexDetail (also read by the Calendar) + its two design-pin guards
  - src/lib/index-look.ts
  - src/lib/vitana-index-next-steps.test.ts
  - src/components/calendar/vcal/typography.test.ts
  - tests/e2e/staging/vtid-*-colours-batch-2.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
updated: 2026-10-21T23:30Z
vtid: VTID-05286
---
# Raw palette ΓåÆ tokens, batch 2 (owner decision 1, option A) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` ΓÇö `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: colours-batch-2 -->`
(tasks K2) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 86 files with findings in this lane's paths ΓÇö `design/no-arbitrary-size` 33 ┬╖ `design/no-raw-palette` 790 ┬╖ `design/no-physical-direction` 6 ┬╖ `design/no-raw-content-card` 8.

**Goal.** Clear every `design/*` finding in the 86 files of this batch: raw palette ΓåÆ nearest existing token (SPOTLIGHT_RULES ┬ºE + the extended mapping in design.md ┬º2), arbitrary sizes per decision 2, raw `Card` ΓåÆ `VCard`/`Panel` per design.md ┬º4, leftover physical directions per design.md ┬º5.

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

**Never** (collaboration ┬º7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z ┬╖ kiro-202610152203-0347 ┬╖ created ΓåÆ ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/colours-batch-2 --session <id>`).

### 2026-10-21T09:24Z ┬╖ ci-plan-spar ┬╖ ready (VTID allocated)
VTID-05286 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z ┬╖ kiro-202610152203-0347 ┬╖ VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.


### 2026-10-22T13:40Z - kiro-202610152203-0347 - BLOCKED (real test failure, needs decision)
Resolved the baseline conflict by regenerating design/eslint baselines (every batch-2-owned src file reads 0 in the
regenerated design baseline). Pushed merge commit a8d96dfd0 to the PR branch. PR-GATE then surfaced a REAL (non-infra)
Vitest failure, pre-existing on the lane's own tip faeb79807 (it also fails without my merge; it passes on main):

- 2 files, 3 tests fail: `src/lib/vitana-index-next-steps.test.ts` and `src/lib/index-look.test.ts`.
- Cause: this lane tokenised `src/pages/health/VitanaIndexDetail.tsx` (raw palette -> Spotlight tokens), but the
  page's design is pinned by a SHARED constants module `src/lib/index-look.ts` (still raw: `border-slate-100
  bg-white`, `hsl(200, 80%, 91%)`, `bg-teal-50 text-teal-700` ...). The guard tests assert the page source still
  contains those raw strings; after tokenisation it no longer does, so they fail.
- `src/lib/index-look.ts` is NOT just a test fixture: it is imported at runtime by the Calendar surface
  (`src/pages/Calendar.tsx` and `src/components/calendar/vcal/{Disclosure,GuideCard,sections,views}.tsx`). Its
  doc comment: "The calendar follows the Index page." So the only in-place fixes each change behaviour or scope:
  (a) tokenise `index-look.ts` to match the page -> re-skins the Calendar (out of this lane's paths, visually
      unverified here); the Spotlight-contract-consistent option, but a visible Calendar change nobody reviewed.
  (b) revert the pinned elements of VitanaIndexDetail.tsx -> leaves the lane's own page partly un-tokenised.
  (c) retire/relax the two guards -> removes the anti-drift protection they exist for.
- None is a mechanical baseline/merge resolution, and all touch files outside the lane's declared `paths`
  (would also fail Lane scope). This blocks the serialized conflicting chain (batch-3/4/5/backoffice follow batch-2).
- Recommendation: option (a) in a dedicated follow-up (tokenise `index-look.ts` + update both guard tests + add
  those files to this lane's paths + visual-verify Calendar on staging), since the Spotlight contract applies to
  every screen. Needs owner/author direction because it re-skins an out-of-scope surface. No live system touched.

### 2026-10-22T14:10Z - kiro-202610152203-0347 - deeper finding (hero tokenisation breaks Calendar WCAG guard)
Attempted the proper fix (tokenise shared `src/lib/index-look.ts` to match the page). The class-string constants map
cleanly (INDEX_CARD/HERO_CLASS/EYEBROW/TILE/NEXT_UP/NEXT_UP_CHIP all become exact substrings of the tokenised page,
so `index-look.test.ts` + `vitana-index-next-steps.test.ts` would pass). BUT `INDEX_HERO_STYLE` cannot be
tokenised cleanly:
- The Calendar guard `src/components/calendar/vcal/typography.test.ts` (L77-82) parses INDEX_HERO_STYLE's
  `backgroundColor`/`backgroundImage` with `/hsl\((\d+), (\d+)%, (\d+)%\)/` and runs a WCAG contrast check
  (expects 4 literal hsl stops, ratio >= 3). Replacing the literals with `hsl(var(--surface-page*))` yields 0 stops
  -> that Calendar test FAILS. The test needs literal hsl values it can resolve.
- The page's tokenised hero is NOT visually identical to the old one: old = pale blue
  (`hsl(200,80%,91%) / 212,72%,94% / 225,65%,95%`); `--surface-page-from/via/to` (index.css L225-227) =
  `270 100% 98% / 214 100% 97% / 327 73% 97%` = a violet->blue->pink gradient. No existing token reproduces the
  old pale-blue gradient, so "nearest token, Calendar visually identical, no new tokens" is not achievable for the
  hero. This is a real visible re-skin introduced by the lane's page tokenisation, plus an accessibility-guard break.
Conclusion: this is more than a trivial token swap and crosses into a design decision (accept the hero re-skin on both
Index + Calendar, and update the Calendar WCAG guard to resolve tokens) or keep the hero literal on the shared const
(page/const diverge). Per the owner's instruction, a non-trivial shared-constant fix needs independent review before
merge. #1456 left NOT merged at baseline-only merge a8d96dfd0 (class-const fix staged locally, unpushed). The other
four conflicting lanes (batch-3/4/5, backoffice) continue meanwhile. No live system touched.