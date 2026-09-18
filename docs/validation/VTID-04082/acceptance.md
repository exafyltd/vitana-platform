# VTID-04082 — Acceptance

VALIDATION_PROFILE: gateway_backend

## Background

`services/gateway/scripts/regen-screens-catalog.mjs`'s `loadAdm()` evaluates
`vitana-v1`'s `ADMIN_SECTIONS` array literal inside a `node:vm` sandbox to
strip its TypeScript-only syntax without a full TS parser. The sandbox
context was a hardcoded object naming exactly 12 lucide-react icon
identifiers. Any OTHER identifier referenced in the literal (a 13th icon, or
any other bare identifier the source happens to use) threw
`ReferenceError: <name> is not defined` and crashed the whole regen script —
`main()` calls `loadAdm()` unconditionally, so a single unlisted icon name in
`vitana-v1` breaks the DEV-side regen too, not just ADM.

Two of the three `vm.runInNewContext` call sites in this file used the same
brittle shape (a fixed enumerated `ctx` object, including two using a bare
`{}` — no better, since any identifier at all throws against an empty
context).

## AC-1: an icon identifier outside the old fixed 12-name list no longer throws

TEST: `services/gateway/test/scripts/regen-screens-catalog.test.ts` — "does
not throw ReferenceError for an icon identifier outside any fixed list".
Reproduces the real reported defect with a fixture `admin-navigation.ts`
using `RocketIcon`/`Wrench` (neither ever in the old hardcoded list) and
asserts the script's stderr carries no `ReferenceError`.

## AC-2: previously-passing well-known icon names still parse correctly

TEST: `services/gateway/test/scripts/regen-screens-catalog.test.ts` — "still
parses the well-known lucide icon names the fixed list used to enumerate".
Confirms the fix is additive (any identifier now resolves), not merely a
different fixed list under a different name.

## AC-3: fixing the crash must not silently mask errors class-of

Fixing the ReferenceError let the script run far enough to reach its
duplicate `screen_id` validation for the first time against the current,
real `vitana-v1/src/config/admin-navigation.ts` — which now has real
collisions (`overview/dashboard` vs `backoffice/dashboard` → both
`ADM-DASHBOARD`, plus 5 more; BackOffice's navigation, VTID-03833, was added
after this script's `idOverrides` map was last updated). The fix must ship
with those disambiguators, not just the sandbox context change, or the
script is "fixed" in the sense that it no longer crashes but still cannot
actually complete a regen.

TEST: `services/gateway/test/scripts/regen-screens-catalog.test.ts` —
"reports real screen-id collisions from the actual admin-navigation.ts,
instead of masking them behind a crash". Runs the real script against the
real sibling `vitana-v1` checkout in `--check` mode and asserts neither a
`ReferenceError` nor a `duplicate screen_ids` rejection.

## Manual verification (commands.log has full output)

- Reproduced the original defect against the pre-fix script (via `git
  stash`) with a fixture icon name: confirmed
  `ReferenceError: RocketIcon is not defined`.
- Ran the fixed script in `--check` mode against the real sibling
  `vitana-v1` checkout available in this session: no ReferenceError, no
  duplicate-id rejection, reports `out of sync` (expected — the committed
  spec predates this fix and the BackOffice-era navigation; regenerating it
  is `REGEN-SCREENS-CATALOG.yml`'s own job, which auto-PRs and auto-merges
  a pure data sync once this fix lands on `main`).
- `node --check services/gateway/scripts/regen-screens-catalog.mjs` — clean.
- `tsc --noEmit` (repo's own pinned binary) — clean.
- `jest test/scripts/regen-screens-catalog.test.ts` — 3/3 passing.

OASIS_IMPACT: no
