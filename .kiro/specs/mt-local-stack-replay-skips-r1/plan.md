---
change_class: standard
---
# plan(mt-local-stack-replay-skips-r1): list the two VTID-05579 migrations PGlite cannot replay so the MT local stack gate is green again
Author: Kiro, seat `hotmail`, session `kiro-hotmail-202611061752-cc1f`. Repo: `exafyltd/vitana-platform`.
Premises pinned to `origin/main` `4294d5cd57`.
<!-- plan:begin -->
## 1. Goal
Orchestrator task: fix the red "MT local stack (PGlite)" check on `main` without loosening the gate. PR #4850
(VTID-05579, merge `b670aa2b99`) added migrations that cannot replay on the stack, and the open PRs #4899, #4900 and
#4901 run the same job on their branches and are blocked by it.

## 2. Today (evidence)
- `.github/workflows/MT-LOCAL-STACK.yml` (VTID-05520) replays `supabase/migrations` on PGlite on every push to `main`.
  A migration that fails and is not listed in `supabase/tests/local-stack/replay-skip.json` fails the gate
  (Amendment 3 of `mt-guardrails-r2`, by design).
- Failing on `main` pushes `b670aa2b99`, `e7969bd82f` and `4294d5cd57`:
  `migration 20261102054000_vtid_05579_chat_groups_scope.sql failed and is not listed in replay-skip.json: relation public.chat_groups does not exist`.
  `chat_groups` is created in this repository by `20260525000000_VTID_03089_chat_groups.sql:12`, but that migration is
  itself skipped on PGlite (it needs `chat_messages`, `replay-skip.json`), so the table is absent during replay.
- Read-only investigation on `origin/main` `4294d5cd57`: `node scripts/mt/stack/discover-skips.mjs` finds 733
  migrations, 425 apply, 308 skipped, and the only difference from the committed `replay-skip.json` is two entries:
  `20261102054000_vtid_05579_chat_groups_scope.sql` and `20261102054200_vtid_05579_chat_groups_rls.sql`, both
  `relation "public.chat_groups" does not exist`. `20261102054100_vtid_05579_*` applies and needs no entry.
- With those two entries added, `node scripts/mt/stack/check-stack.mjs` prints `PASS local-stack gate` and
  `npm run test:mt-stack` passes 57/57, including `skipped-isolation.test.mjs` and `repo-gate.test.mjs`. `chat_groups`
  is not one of the 11 present required tables, so the "Isolation gap on the present tables" table in
  `docs/multitenancy/LOCAL-STACK.md` needs no new row (the scan only lists skips that touch a present table).

## 3. Change: one lane `replay-skips` (vitana-platform)
Regenerate `supabase/tests/local-stack/replay-skip.json` with `discover-skips.mjs --write`, so it gains exactly the two
entries above with the generator's real reason and error text. No wildcard, no test deleted or weakened, no change to
`stack.mjs`, `check-stack.mjs` or the workflow. `docs/multitenancy/LOCAL-STACK.md` changes only if a test shows it must
(the doc-agreement tests decide; expected: no change).
Evidence under `docs/validation/<VTID>/`.

## 4. Tests
- Red on base: `node scripts/mt/stack/check-stack.mjs` exits non-zero with the message in section 2 before the change; after the
  change it prints `PASS local-stack gate`.
- `npm run test:mt-stack` passes (57 tests).
- `node scripts/mt/stack/discover-skips.mjs` output equals the committed file (the file is exactly the generator's output).

## 5. Deferred
Standing note, tracked in lane `ci-wiring` of `mt-guardrails-r2`: every future migration that cannot replay on PGlite
must update `replay-skip.json` in its own PR (run `discover-skips.mjs --write`). Not changed here; no other lane is touched.

## 6. Unchanged
No code, workflow, protected gate file or live system. Deploys nothing.

## 7. Risks
A newer migration merging before this lane lands adds more failures; the lane re-runs discover on the latest `main` before
pushing and merges `main` into its branch.
<!-- plan:end -->
