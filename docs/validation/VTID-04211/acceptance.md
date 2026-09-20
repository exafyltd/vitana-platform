# VTID-04211 — Acceptance

Test-only regression coverage for `services/gateway/src/services/operator-bootstrap-pack.ts`,
confirming the whole assembled session bootstrap pack still resolves to a
valid, non-throwing, budget-capped string when EVERY individual source
(CLAUDE.md/path-map/schema reads, build-info, both PR lists, OASIS events)
fails or times out simultaneously — not just one source failing at a time.

## Confirming this was genuinely new coverage

Read `services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts` in
full before writing anything, per the task's own instruction.

- **"a failing or hanging source renders as unavailable and does not block
  the others"** only fails 3 of 7 sections (`queryRecentEvents`,
  `listPlatformOpenPrs` via a hang, `listFrontendOpenPrs`) and explicitly
  asserts `sections[0].body` (CLAUDE.md) still contains real content — it
  deliberately proves the OPPOSITE of an all-sources-failure: that a
  partial failure doesn't spread.
- **"never throws — a broken deps set fails open to an empty pack"**
  comes closer in spirit but has a real gap: it passes only
  `{ readRepoFile: undefined }` as a **partial** `Partial<BootstrapDeps>`
  object. Since `getOperatorBootstrapPack()` spreads `{ ...defaultDeps(),
  ...opts.deps }`, every OTHER source (`listPlatformOpenPrs`,
  `fetchBuildInfo`, `queryRecentEvents`, ...) silently falls through to the
  REAL production implementation (real GitHub/Supabase calls) rather than
  a controlled failure. That test only happens to pass because those real
  calls fail fast in this sandboxed test environment (no tokens/env vars
  configured) — an incidental, unasserted side effect, not a deliberate
  test of the all-sources-fail case. The test also checks nothing about
  the resulting content, only `typeof pack === 'string'`.

Neither test is a duplicate of what this VTID adds.

## What was added

A fully-overridden, deterministic `BootstrapDeps` object
(`allFailingDeps()`, mirroring the sibling file's own safe `deps()`
pattern) where every named source function rejects — never a partial
object, never a silent fallthrough to real production I/O:

1. `buildBootstrapSections()` — confirms 6 of the 7 sections carry their
   own `.error` (the four `readRepoFile()`-backed sections, "Open pull
   requests" via `listPlatformOpenPrs` with no bare fallback supplied, and
   "Recent deploy / autopilot events"), while "Live build-info" is the one
   section whose per-target internal `try/catch` absorbs the failure into
   its own `body` instead of the section's `.error` — pinned explicitly so
   a future change to that internal catch can't silently start throwing
   instead.
2. `assembleBootstrapPack()` — the whole assembled string still resolves,
   stays at or under `PACK_MAX_CHARS`, and shows an `(unavailable: ...)`
   line for every section that genuinely failed (via either mechanism
   above), never `(empty)`.
3. `getOperatorBootstrapPack()` — the full, real call path (cache +
   real tool-catalog rendering) still returns a non-empty, budget-capped
   pack whose ONLY successful section is the tool catalog — the one
   section with no external dependency at all, since it renders straight
   from the `toolDefs` the caller already has in hand.

## Acceptance criteria

AC-1: with every source mocked to fail/timeout,
`buildBootstrapSections`/`assembleBootstrapPack` still resolves to a
valid, non-throwing string containing only `(unavailable: ...)` lines for
each section, never throws, and stays under the byte cap.
TEST: `services/gateway/test/vtid-04211-bootstrap-pack-all-sources-fail.test.ts`
— "every one of the 7 sections reflects a genuine failure...", "resolves
to a valid, non-throwing string under the byte budget...", and "never
throws when assembling an all-failed pack...".

AC-2: the test is a genuinely new case, not a duplicate of existing
single-source-failure coverage.
Confirmed above by reading the existing file first; documented in this
file's own header comment for anyone reading it later.

## Verification

`tsc --noEmit` clean — no source file changed.

Own suite: 5/5 tests passing, against the real, unmocked
`buildBootstrapSections`/`assembleBootstrapPack`/`getOperatorBootstrapPack`
functions.

Regression sweep: `vtid-04018-operator-bootstrap-pack.test.ts` (the
sibling file, all 16 pre-existing tests) plus the new file — 2 suites, 21
tests, 0 failures.

## Not done here

- No source change — `operator-bootstrap-pack.ts` is untouched.
- Did not touch the pre-existing "never throws — a broken deps set fails
  open to an empty pack" test's real latent gap (it can silently reach
  real production I/O in an unmocked environment) — flagging it in this
  file's own header comment rather than silently fixing an unrelated
  pre-existing test, since that was not what this task asked for.

OASIS_IMPACT: no — this PR adds one test file; it emits no OASIS events
and changes no runtime code path.
