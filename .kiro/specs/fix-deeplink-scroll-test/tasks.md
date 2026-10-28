# Tasks — fix-deeplink-scroll-test
<!-- lane: fixture-dates -->
Repo `exafyltd/vitana-v1`. Code starts only after the VTID is allocated (plan § Lanes).
- [ ] T0 Start check: `gh pr view 1506 --repo exafyltd/vitana-v1 --json state,mergeCommit`. If `MERGED`: skip T1, T2
      and T4; run T3 on `origin/main` and record it, the #1506 merge SHA and the UNIT-TESTS run on that SHA in
      `docs/validation/<VTID>/commands.log`; T5 then means that evidence PR. Otherwise continue with T1.
- [ ] T1 Red on base: in the lane worktree on `origin/main`, run
      `npx vitest run src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx` and save the output (2 failed:
      `reload > re-posts a pending item …`, `review fixes > several mounted instances share one outbox …`) to
      `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 `src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx`: replace the fixed outbox `created_at` values
      at `:204`, `:205`, `:261` with now-relative ISO strings, same shape as vitana-v1#1506: a `minutesAgo(m)` helper,
      pending `minutesAgo(2)`, failed `minutesAgo(1)`, `:261` `minutesAgo(2)` (pending older than failed by 60 s,
      both far under `OUTBOX_MAX_AGE_MS`). No other line, assertion, fake timer or product file changes.
- [ ] T3 Green on head: the VTID-05320 file passes; the deep-link test
      `npx vitest run src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx` passes;
      `npm run test:unit` passes every file. Commands and summaries in `docs/validation/<VTID>/commands.log`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json` (UTF-8, no BOM): `service: community-app`, one test
      `kind: "existing"`, `ref: "npx vitest run src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx"`, reason
      "test-only change, the app bundle is unchanged" (precedent `docs/validation/VTID-05313/staging-tests.json`).
- [ ] T5 PR titled with the VTID (squash merge keeps it in the subject); after merge UNIT-TESTS `Vitest (jsdom)` is
      green on the merge commit on main and STAGING-VERIFY community-app has a result for it.

Acceptance:
- Change types: Tooling/docs (test-only change in a Vitest file plus validation records).
- **Outcome** — CI: the vitana-v1 `Vitest (jsdom)` check is green on main after merge, and stays green past
  2026-10-28 (no fixed outbox date that the 7-day prune can expire).
- **States** — n/a: no UI or runtime state changes; the test still covers pending/failed reload and the shared-outbox
  case with unchanged assertions.
- **Surfaces** — n/a: no screen or caller changes; only `useGlobalMessages.send-status.vtid-05320.test.tsx`.
- **Locales** — n/a: no user-visible string.
- **Accessibility** — n/a: no UI.
- **Contract** — n/a: no boundary crossed; `outbox.ts:48,90` (`OUTBOX_MAX_AGE_MS`, prune) unchanged.
- **Staging proof** — not verified on staging: test-only change, the deployed bundle is unchanged; covering tests are
  the VTID-05320 file and the full `npm run test:unit`; `staging-tests.json` present so STAGING-TESTS-REQUIRED passes.
- Red on base for the reason fixed (the 2 named tests, not a setup or module-resolution error), green on head; the
  deep-link test passes; full suite passes.
- Diff touches only the lane `paths`; no assertion loosened, no test skipped; files UTF-8 without BOM.
