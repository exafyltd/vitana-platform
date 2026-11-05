---
change_class: standard
---
# plan(fix-deeplink-scroll-test): turn vitana-v1 Vitest (jsdom) green on main again
Author: Kiro, seat `dstev`, session `kiro-dstev-202610280954-a005` (Kiro IDE, run `wf_41f1175f2cb86d49`). Code repo:
`exafyltd/vitana-v1`; the spec lives in vitana-platform because PLAN-SPAR only runs here (cross-repo pattern of
`.kiro/specs/i18n-audit-nightly-off`). Premises pinned to vitana-v1 `origin/main` `5bc8d10cd` (2026-10-28T10:01Z) and
vitana-platform `origin/main` `fec7aafc02`. Detail per lane: `tasks.md`; lane file under `lanes/`.
<!-- plan:begin -->
## Goal
Owner (2026-10-28): *"the vitana-v1 Vitest (jsdom) check has been red on main since 2026-10-17. The failing test is
src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx … Fix the test mock … not the component.
Check whether other tests mock @/lib/i18n-toast the same way and fail for the same reason, and fix those too within
the lane. … the Vitest (jsdom) check must turn green on main after merge."*

## Today (evidence, read-only)
1. **The deep-link mock is already fixed on main.** vitana-v1
   `src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx:38-44` already uses the partial mock
   the owner prefers (`vi.mock('@/lib/i18n-toast', async (importOriginal) => ({ ...(await importOriginal()), t,
   notify, notifyError }))`, comment "VTID-05313: keep the real module (getI18nLocale …)"); `:76-77` makes fixture
   timestamps relative to now. Landed by `610b7270a` (VTID-05313, exafyltd/vitana-v1#1473, merged 2026-10-21T14:23Z);
   red-on-base proof with exactly the owner's error in vitana-v1 `docs/validation/VTID-05313/red-on-base.txt`;
   confirmed by VTID-05308 (#1479). The component is unchanged: `ConversationView.tsx:63` imports `notify, notifyError,
   t`; `getI18nLocale` (`src/lib/i18n-toast.ts:34`) is reached through `formatDate` from `@/lib/locale-format`
   (`ConversationView.tsx:65`, `src/lib/locale-format.ts:16,56`).
2. **The red window the owner describes closed on 2026-10-21.** UNIT-TESTS (`.github/workflows/UNIT-TESTS.yml:26-39`,
   job `Vitest (jsdom)`, `npm run test:unit` = `vitest run`) on main: red 2026-10-17 08:02 → 2026-10-21 11:13
   (`704b5def4`…`69d39ef34`), green from `610b7270a` through `a6c5bd073` (run 40511463300, 2026-10-27: `Test Files
   479 passed (479)`, the deep-link test `✓`).
3. **Other `@/lib/i18n-toast` mocks: none fails for this reason.** 81+ test files mock the module, most with a full
   factory without `getI18nLocale`; in run 40511463300 all 479 files pass, and in today's red run (item 4) the only
   failures are not i18n-toast mocks. Rewriting ~76 passing mocks is not "fail for the same reason" and is out of
   scope (see Unchanged).
4. **Vitest (jsdom) is red on main again since 2026-10-28T10:01Z, for a different reason: a date time bomb.** Runs
   40668786443 (push) and 40668788587 (schedule) on `5bc8d10cd` fail 1 file / 2 tests in
   `src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx` (added by `7499b3b7d`, VTID-05320, #1474):
   - `reload > re-posts a pending item once with its original id and shows a failed one with Retry`
     (`expected [] to deeply equal [ 'was in flight:server', … ]`)
   - `review fixes > several mounted instances share one outbox: a reload re-posts once and nothing is overwritten`
     (`expected "vi.fn()" to be called 1 times, but got 0 times`)
   `5bc8d10cd` changes only `.github/PULL_REQUEST_TEMPLATE.md` and `docs/validation/VTID-05348/*`. Cause: the outbox
   fixtures at `:204`, `:205`, `:261` carry fixed `created_at` `2026-10-21T10:00:00.000Z` / `…10:00:01.000Z`;
   `src/lib/messaging/outbox.ts:48` `OUTBOX_MAX_AGE_MS = 7 days` and `:90` prune drops items older than that on load,
   so since 2026-10-28T10:00Z the seeded items vanish and the assertions fail on every run (PR, push, nightly). Same
   defect class VTID-05313 fixed in the deep-link test. Still red on vitana-v1 `origin/main` `1349f6991` (UNIT-TESTS
   run 40674402709, 2026-10-28T10:43Z).
   Verified on vitana-v1 `origin/main` `1349f6991` (round 1, R1-F1): `git show origin/main:src/lib/messaging/outbox.ts`
   → `:46` `SENT_GRACE_MS = 2 * 60 * 1000`, `:48` `OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000`, `:89-90`
   `prune(items, now)` = `items.filter((i) => now - new Date(i.created_at).getTime() < OUTBOX_MAX_AGE_MS)`, `:99`
   `loadOutbox(userId, now = Date.now())`, `:114` / `:138` sort by `created_at.localeCompare`. The fixed outbox dates
   `2026-10-21T10:00:0…` sit at test lines `:204`, `:205`, `:261` (outbox) and `:249`, `:250` (realtime INSERT payloads,
   never pruned).
   **Time thresholds on outbox items (R1-F3):** `created_at` is read only by `prune` (`outbox.ts:90`, 7 days) and for
   ordering (`:114`, `:138`; copied to the optimistic row at `:181-182`). The only other threshold, `SENT_GRACE_MS`
   (2 min), is applied to `sent_at` of `status: 'sent'` items (`src/hooks/useGlobalMessages.ts:1460-1465`), never to
   `created_at`, and the fixtures are `sending` / `failed` without `sent_at`. No minimum-age check exists.
5. **A fix-forward for the same defect is already open: exafyltd/vitana-v1#1506** (branch
   `kiro/messenger-ux-v2/ui-send-status-fixfwd`, session `kiro-exafyltd-202610281029-e076`, lane
   `messenger-ux-v2/ui-send-status`, VTID-05320, opened 2026-10-28T11:01Z, head `3e324cec2`). It changes only this
   test file: a `minutesAgo(m)` helper and `created_at: minutesAgo(2)` / `minutesAgo(1)` at `:204`, `:205`, `:261`. Its
   `Vitest (jsdom)` check is green on that head, which proves the approach empirically; it is not merged yet
   (`mergeStateStatus: UNSTABLE`, one unrelated red native-parity check).

## Decision
The owner's named test needs no change (item 1); the owner's outcome ("Vitest (jsdom) must turn green on main after
merge") is unmet today only because of item 4. The conservative change that delivers that outcome, test-only and
inside "fix the test, not the component": make the three outbox fixture timestamps in the VTID-05320 test relative
to now. No component, hook, `outbox.ts`, constant or assertion changes. The deep-link test is re-run as a regression
check only. Because #1506 (item 5) carries the same edit, the lane does not race it: it applies the identical edit
only if #1506 is not merged when the lane starts, and otherwise closes as a verification of `main` (see Lanes).

## Lanes
- `fixture-dates` — **repo `exafyltd/vitana-v1`**, executor `kiro`, reviewer `agent:vitana-lane-reviewer`.
  Files: `src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx`, `docs/validation/<VTID>/{red-on-base.txt,
  commands.log,staging-tests.json}`.
  Start check: if exafyltd/vitana-v1#1506 is merged to `main` when the lane starts, the test file is already fixed;
  the lane makes no code change, re-runs the commands below on `main`, records them in
  `docs/validation/<VTID>/commands.log` (with the #1506 merge SHA and the UNIT-TESTS run on it) and closes. Otherwise:
  Change: replace the fixed `created_at` at `:204`, `:205`, `:261` with now-relative ISO strings, using the same shape
  as #1506 so the two edits are identical and either can land without conflict: a `minutesAgo(m)` helper
  (`new Date(Date.now() - m * 60_000).toISOString()`), pending = `minutesAgo(2)`, failed = `minutesAgo(1)`, the
  `:261` pending = `minutesAgo(2)`. Offsets (R1-F3): 1-2 minutes is (a) far inside `OUTBOX_MAX_AGE_MS` (7 days), (b)
  keeps the pending item strictly older than the failed one (60 s apart, merge order by `created_at`,
  `outbox.ts:114,138`), and (c) touches no other threshold (only `prune` reads `created_at`; `SENT_GRACE_MS` reads
  `sent_at` of `sent` items). In the reload test the re-posted item becomes a server row dated by `serverRow()`
  (2026-10-21, `:101`), still earlier than the failed item, so the asserted order `['was in flight:server', 'had
  failed:failed']` is unchanged; #1506's green `Vitest (jsdom)` on `3e324cec2` confirms it. No fake timers (the hook
  relies on real `waitFor` timing). Other fixed dates in the file (`:79` `fetchConversations`, `serverRow()` `:101`,
  realtime payloads `:231-250`) are not pruned and stay.
  Test that fails on base: `npx vitest run src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx` on base
  (any date ≥ 2026-10-28T10:00Z) → the 2 tests above fail; on head → all pass.

## Parallel / shared files / hot files
One lane, no fan-out (common-rules §11 small task): one changed code file (the test file) plus the standard lane
evidence under `docs/validation/<VTID>/` (`red-on-base.txt`, `commands.log`, `staging-tests.json`), which every lane
produces and which §11's "at most 3 files" does not count (R1-F2). No hot file (no migration, `DATABASE_SCHEMA.md`,
`src/App.tsx`, `screens.json`/`exclusions.json`, parity ledger, i18n shard, `CLAUDE.md`). No protected gate file and
no governance path, so the reviewer agent's accept is enough under §7b. No interfaces between lanes.

## Tests and commands (vitana-v1 lane worktree)
- `npx vitest run src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx` — red on base (2 failed), green on
  head; output in `red-on-base.txt` / `commands.log`.
- `npx vitest run src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx` — green (regression).
- `npm run test:unit` — full suite, every file passes (479/479 expected).
- After merge: UNIT-TESTS `Vitest (jsdom)` on the merge commit on main = success.
- Staging: `src/**` triggers `AWS-STAGE-DEPLOY-FRONTEND.yml:33-54` and STAGING-TESTS-REQUIRED, so the lane adds
  `docs/validation/<VTID>/staging-tests.json` (`service: community-app`, `kind: "existing"`, `ref` = the Vitest
  command above, reason: test-only change, the app bundle is unchanged), precedent `docs/validation/VTID-05313/`.
  End point: STAGING-VERIFY community-app passes on the merge commit (or later commit containing it).

## Measurement
`docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`, collaboration.md §8b), quoted in Gate 2.

## Risks
1. STAGING-VERIFY community-app is red on main independent of this plan (run 40515327351 on `a6c5bd07`, failure;
   nav-perf line `News /home: ready 3843 ms > 1500 ms`). This lane cannot fix that; if it is still red after merge it
   is logged as a blocker with the run link, never overridden.
2. Other tests may hold similar fixed-date fixtures that expire later; the full suite run on head proves none is red
   today. A sweep for latent time bombs is a separate plan.
3. Lane scope on the vitana-v1 PR reads this lane file from vitana-platform `main`; it is green only after this plan
   PR merges (governance-artifact false positive until then, common-rules §4).
4. Known pipeline issue: review steps may return `model_unavailable` (VTID-05359, plan `reviewer-step-model`); the land
   step then sends `info` to the parent with the PR and head instead of parking silently.

## Unchanged
`ConversationView.tsx`, `useGlobalMessages`, `src/lib/messaging/outbox.ts` (`OUTBOX_MAX_AGE_MS`, `prune`), every
assertion, the deep-link test file, and the ~76 passing full-factory `@/lib/i18n-toast` mocks. Nothing user-visible
ships; no What's New entry, no i18n, design-manifest, nav-registry or parity-ledger change.
<!-- plan:end -->
