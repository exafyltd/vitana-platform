# Tasks — I18N-PROPAGATE stale-write fix

Author: kiro. Drafted 2026-10-16. VTID allocated by CI (PLAN-SPAR, policy `converged-auto-v1`) or Claude Code after
sparring. Executor: claude (the lane changes `.github/**`, a governance path). Code repo: exafyltd/vitana-v1.

<!-- lane: fix-workflow -->
## Lane — fix-workflow  [vitana-v1]
depends_on: []

- [ ] 1. Add `scripts/i18n-propagate-apply.mjs` implementing the key-level 3-way merge of design D4 (leaf table, file
      rules, key order, serialisation detection, `::warning::` on conflicts, non-zero exit on a missing `base_sha.txt`
      or bad JSON without writing that locale).
      Verify: `node --test scripts/i18n-propagate-apply.test.mjs` passes (task 2).
- [ ] 2. Add `scripts/i18n-propagate-apply.test.mjs` (`node --test`, temp git repo). Scenarios:
      a. PR #1399 replay: base has EN placeholders for `settings.preferences.{desc,accessibilityNote}`; a later human
         commit translates them; the bot output (from base) changes only `vitanaCards.*` → result has the human
         `desc`/`accessibilityNote` AND the bot `vitanaCards.*`.
      b. Both changed the same key to different values → human value kept, one warning naming locale/file/key.
      c. Bot adds a key, deletes a key, creates a new shard → applied.
      d. Human deleted a shard after base → not recreated.
      e. Stamp file (compact one-line JSON) merged key-wise and stays one line.
      f. Unchanged keys produce a byte-identical file (no diff); running twice is a no-op.
      g. Artifact without `base_sha.txt` → exit 1, no file written.
      Verify: `node --test scripts/i18n-propagate-apply.test.mjs` — all pass; each scenario fails against a
      whole-file copy implementation (mutation check, noted in the PR).
- [ ] 3. `.github/workflows/I18N-PROPAGATE.yml`:
      fanout — after "Re-stamp", write `base_sha.txt` from the SHA recorded right after checkout; upload it with the
      locale files (`:216-224`);
      collect — `fetch-depth: 0` (`:230-232`); replace the `cp -r` step (`:243-247`) with the script; replace the
      commit/push loop (`:256-269`) with fetch → `reset --hard origin/<ref>` → script → commit → push, 5 attempts then
      red (design D5);
      pivot — `git pull --rebase … || { git rebase --abort; …; }` instead of `|| true` (`:161-166`);
      update the header comment (`:22-27`) to say what the single writer guarantees and what the merge guarantees.
      Verify: `npx --yes @action-validator/cli .github/workflows/I18N-PROPAGATE.yml` (or `actionlint` if present)
      reports no errors; `npm run lint` unaffected.
- [ ] 4. `.github/workflows/i18n-check.yml`: add a step `node --test scripts/i18n-propagate-apply.test.mjs`.
      Verify: the `i18n check` job on the lane PR runs the step green.
- [ ] 5. `docs/validation/<VTID>/`: copy the sparring record, add `scope.json` and `acceptance.md`. No
      `staging-tests.json`: the change deploys nothing.
      Verify: PR-GATE green incl. Lane scope.

## Acceptance

Maps to requirements 1.1–3.2. Lane `verified` when PR-GATE, `i18n check` (incl. the new test step) and Lane scope are
green on the PR head and the reviewer seat approved. Post-merge evidence (not a gate): the next I18N-PROPAGATE run on any
PR shows the script's summary in the `collect` log.
