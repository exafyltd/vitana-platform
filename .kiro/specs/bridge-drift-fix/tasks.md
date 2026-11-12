# Tasks — bridge-drift-fix

Code starts only after the VTID is allocated. No address is ever written to a commit message, a PR body, a log or an
evidence file.

<!-- lane: fix -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Capture red on `origin/main` for all four suites together in one run, recorded in
      `docs/validation/<VTID>/outputs/red.txt`.
- [ ] T2 C1: add `AWS-KIRO-ACCESS` to loop L5's `workflows` in `services/gateway/specs/loop-catalog-v1.json`.
- [ ] T3 C2: raise `LIMITS.rulesChars` to `12_000` in `operator-bootstrap-pack.ts`; update the test's pinned bound to
      `12_000 + 20`.
- [ ] T4 C3: widen the session-layer test's regex to accept `owner` or `machine` approval.
- [ ] T5 C4: add the `-- definer-public:` comment to the migration, naming the earlier migration that already holds
      the grant.
- [ ] T6 Green on the branch for all four suites together, recorded in `docs/validation/<VTID>/outputs/green.txt`.
- [ ] T7 Mutation checks for C2, C3 and C4 (each re-fails when reverted alone), recorded in
      `docs/validation/<VTID>/outputs/mutations.txt`.
- [ ] T8 Full `services/gateway` Jest run; the two pre-existing environmental failures (region-env mismatch,
      missing `openssl`) are confirmed identical with the fixes stashed out, recorded in
      `docs/validation/<VTID>/outputs/full-suite.txt`.
- [ ] T9 PR `VTID-xxxxx (bridge-drift-fix/fix): main is red after #5021 and #5027 — four test-drift fixes`.

Acceptance:
- Change types: Backend, Database, Tooling/docs.
- **Outcome** — `main`'s Gateway Jest shards and Gateway Service Tests go green again; every lane PR blocked on a
  red `main` (owner spec v5 gate M7) can land once this merges.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — n/a: no API, route or schema change; the migration's grants are unchanged (not applied).
- **Staging proof** — not verified on staging: the change deploys nothing observable (a catalog data edit, two test
  assertions, one SQL comment).
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.
- Diff only inside the lane `paths`; no test skipped, `.only`'d, or loosened — C3's widened regex still requires
  every stable endpoint the test's own comment names.
