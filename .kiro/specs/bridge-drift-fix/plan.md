---
change_class: standard
---
# plan(bridge-drift-fix): main is red after #5021 and #5027 — four independent test-drift fixes

Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611122052-a6df` (Kiro Web), 2026-11-12. Premises read at
vitana-platform `94f5183f77` (`origin/main`).

Owner, 2026-11-12 (GitLab migration, next step): *"FIX MAIN (unblocks everything) ... Open one PR into main with
these fixes and its test output. Merge it when its checks are green."*

<!-- plan:begin -->
## 0. Premises (each one a file on `origin/main` 94f5183f77)
1. `services/gateway/test/loop-catalog.test.ts` fails: `AWS-KIRO-ACCESS` (`.github/workflows/AWS-KIRO-ACCESS.yml`,
   added by `c8ecb6eb3f`/VTID-05764) has no owning loop in `services/gateway/specs/loop-catalog-v1.json`, so the
   coverage rule reports it as an orphan and the compiled-registry count mismatches (29 != 30).
2. `services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts` fails:
   `extractClaudeMdPart1()` (`services/gateway/src/services/operator-bootstrap-pack.ts:110-114`) clips `CLAUDE.md` at
   `LIMITS.rulesChars = 8_000` chars before returning. `a199f9ac9a`/#5021 added governance text before
   `# PART 1: CORE RULES`, pushing that heading from byte 6852 to byte 8158 — past the clip, so the returned text
   never reaches it at all.
3. `services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts` fails: the assertion
   `expect(md).toMatch(/[Pp]lan → sparring → owner approval[\s\S]*?→ VTID → code\./)` requires the literal phrase
   "owner approval". `a199f9ac9a`/#5021 reworded `CLAUDE.md` rule 51 to "plan → sparring → **machine approval on
   convergence** (local partner or CI policy approval `converged-auto-v1`, VTID-05214) → VTID → code." (bridge
   period). The test's own comment states the intent: "Pin the stable endpoints of the flow rather than the exact
   middle clause so a future wording tweak does not re-break it" — the regex just didn't anticipate this particular
   tweak (the word itself, not only the parenthetical).
4. `services/gateway/test/vtid-05041-definer-lockdown.test.ts` fails: its last check
   (`test/vtid-05041-definer-lockdown.test.ts:125-137`) requires every migration newer than
   `20261010164100_vtid_05041_definer_functions_lockdown.sql` that creates a `SECURITY DEFINER` function to either
   revoke `PUBLIC` and `anon` in the same file, or say why not with a `-- definer-public: <reason>` comment line
   (checked against the raw file text, so independent of comment-stripping).
   `supabase/migrations/20261112100000_bridge_sparring_convergence_is_approval.sql` (`a199f9ac9a`/#5021)
   `CREATE OR REPLACE FUNCTION public._plan_sparring_gate_eval(...) SECURITY DEFINER` with no `REVOKE` and no
   `definer-public` comment, so it is reported as an offender. The function's grants are unchanged by this
   migration — `PUBLIC`, `anon` and `authenticated` are already revoked by
   `20261015180000_vtid_05214_plan_sparring_policy_approval.sql:155-156`, which this migration does not touch.
5. None of the four fixes needs to touch a protected gate file or a governance path
   (`scripts/collab/protected-gate-files.json`, `scripts/collab/queue.mjs` `GOVERNANCE_PATHS`): checked against all
   five changed files, both lists come back empty.
6. The migration is marked `-- NOT APPLIED ... apply only after the owner approves this file` (its own header). This
   plan edits that file's text only; nothing here runs `RUN-MIGRATION.yml` or touches a live database.
7. Owner spec `agentic-delivery-scope` v5, gate M7: a failure on `main` pauses landings. Four lane PRs are blocked on
   this (#4999 VTID-05762, #4888 VTID-05672, and this session's own agentic-delivery-scope/privacy-ledger-auth
   lanes) until `main` is green again.

## 1. Goal
One lane, one PR, four independent fixes — each proven red on `origin/main` and green on the branch, with mutation
checks for the two test-only fixes. No change to test *intent*; each fix either widens a test's own stated tolerance
(session-layer) or supplies the data/budget/comment the test was already designed to accept (catalog, bootstrap-pack,
migration).

## 2. Change
- **C1 (catalog):** add `"AWS-KIRO-ACCESS"` to loop **L5 Guard**'s `workflows` sensor list in
  `services/gateway/specs/loop-catalog-v1.json`. Reason: `AWS-KIRO-ACCESS.yml` is read-only drift reporting that
  escalates to the owner and never applies IAM — the guard loop's existing L0 escalate-only role. One line, data only.
- **C2 (bootstrap-pack budget):** raise `LIMITS.rulesChars` from `8_000` to `12_000` in
  `operator-bootstrap-pack.ts`, with a comment naming why; update the test's pinned
  `rules.length <= 8_000 + 20` to `<= 12_000 + 20`. `PACK_MAX_CHARS` (overall budget, 40_000) is untouched; this
  section still fits comfortably alongside the pack's other sections.
- **C3 (session-layer regex):** widen the one assertion from the literal `owner approval` to `\w+ approval` (any one
  word before "approval"), keeping every other assertion in the test (and the adjacent "partner agent" test)
  unchanged. This matches the test's own stated intent — pin the stable endpoints, "Plan → sparring →", an approval
  word, "→ VTID → code." — without enumerating which approval-type word is current (sparring round 1, R1-F1).
- **C4 (migration comment):** add one `-- definer-public: <reason>` line to
  `20261112100000_bridge_sparring_convergence_is_approval.sql`, naming the migration that already holds the
  function's `REVOKE`/`GRANT` pair. No SQL statement changes; the migration still does only what its own header says
  (`CREATE OR REPLACE FUNCTION`, body logic only).
- Nothing else changes. No migration is applied. No protected or governance file is touched.

## 3. Acceptance
- Each of the four target suites: failing on `origin/main` (6 failed, 1 skipped, 49 passed, 56 total across the four
  files together), passing on the branch (0 failed, 1 skipped, 55 passed, 56 total).
- Mutation check, C3: reverting the regex to `owner approval` only re-fails the suite (1 failed, 6 passed).
- Mutation check, C4: removing the `definer-public` comment re-fails the suite (back to the pre-fix offender).
- Mutation check, C2: reverting `rulesChars` to `8_000` re-fails the Part-1 assertion (2 failed in that file).
- Full `services/gateway` Jest run: the only two failures (`storage-provider.test.ts` region-env mismatch;
  `vtid-04226-eventbridge-test-contract-schedules.test.ts`, `openssl` missing from this sandbox) are environmental
  and present identically with the four fixes stashed out — pre-existing, not introduced by this change.

## 4. Risks
- C3 widens a regex; it does not loosen *what* must be true (the flow's endpoints, and that some approval word
  exists), it only stops pinning one no-longer-current word in the middle. No assertion is removed.
- C4 adds a comment, not a grant change; the function's actual permissions are provably unchanged (the earlier
  migration's `REVOKE`/`GRANT` pair is untouched and still the one that applies).
- C1 duplicates the single-line intent of open PR #5050 (`kiro/ci-gate-invariants-loop-catalog`, same author
  identity, not yet merged). Both edits are identical and idempotent; if #5050 lands first, this lane's hunk becomes
  a no-op and is dropped before merge rather than conflicting.

## 5. Unchanged
No production write. No migration applied. No protected gate file or governance path touched. PUBLISH stays the
owner's.
<!-- plan:end -->
