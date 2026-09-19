# VTID-04082 — fix regen-screens-catalog.mjs vm-sandbox ReferenceError + masked screen-id collisions (T7)

Context: `services/gateway/scripts/regen-screens-catalog.mjs`'s `loadAdm()`
evaluates `vitana-v1`'s `ADMIN_SECTIONS` array literal inside a `node:vm`
sandbox to strip its TypeScript-only syntax without a full TS parser. The
sandbox context was a hardcoded object naming exactly 12 lucide-react icon
identifiers. Any OTHER identifier referenced in the literal (a 13th icon, or
any other bare identifier the source happens to use) threw
`ReferenceError: <name> is not defined` and crashed the whole regen script —
`main()` calls `loadAdm()` unconditionally, so a single unlisted icon name in
`vitana-v1` breaks the DEV-side regen too, not just ADM. Two of the three
`vm.runInNewContext` call sites in this file used the same brittle shape (a
fixed enumerated `ctx` object, or a bare `{}` — no better, since any
identifier at all throws against an empty context).

What ships: all three `vm.runInNewContext` contexts replaced with a shared
`stubIdentifierContext()` — a `Proxy({}, ...)` that resolves any free
identifier to `0` instead of throwing. Also 6 new `idOverrides` disambiguator
entries (3 DEV, 3 ADM) for real screen-id collisions the crash had been
masking (BackOffice's navigation, VTID-03833, added new sections after these
maps were last updated).

AC-1 — an icon identifier outside the old fixed 12-name list no longer throws.
TEST: services/gateway/test/scripts/regen-screens-catalog.test.ts

AC-2 — previously-working well-known lucide icon names still parse correctly (the fix is additive, not a different fixed list under a different name).
TEST: services/gateway/test/scripts/regen-screens-catalog.test.ts

AC-3 — fixing the crash surfaces, rather than continues to mask, real screen-id collisions in the current live `vitana-v1/src/config/admin-navigation.ts`; the script must ship able to actually complete a regen against real data, not merely stop crashing.
TEST: services/gateway/test/scripts/regen-screens-catalog.test.ts

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

OASIS_PROOF: n/a — OASIS_IMPACT is `no` (pure dev-tooling script fix, no
runtime/OASIS-event-emitting code touched).
