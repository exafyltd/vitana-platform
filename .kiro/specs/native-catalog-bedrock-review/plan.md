---
change_class: standard
slug: native-catalog-bedrock-review
author: kiro
author_seat: exafyltd
repos: [exafyltd/vitana-v1, exafyltd/vitana-platform]
program: docs/programs/native-app/NATIVE-APP-PLAN.md
---
# Plan — native-catalog-bedrock-review

Author: Kiro, seat `exafyltd`. Session `kiro-exafyltd-202611072144-1c88`. Spec: `handoff.md`, `tasks.md`, `lanes/*.md`
in this folder. Program row: `vitana-platform:native-app` (`docs/programs/native-app/program.md`).

<!-- plan:begin -->
## Goal
Owner instruction, verbatim: "Bedrock translation reviewer: proceed as a plan. Do not clear any _pending_review flag until the reviewer exists and passes it."

This plan builds a reviewer for native catalog values. The reviewer is Claude on AWS Bedrock. It judges one value at a
time and writes one evidence record per value in the format that PR #1680 defines. The plan clears no flag. A later
PR removes a flag only after the reviewer has run and the checker of #1680 accepts the records.

## Measured state
Pinned: vitana-v1 origin/main `70546df8cd2c68fa135bd51301215ee37a6e76f8`, vitana-platform origin/main
`4e215b0198b0aca3637b623d7e1abf50c411c2e1` (2026-11-13T08:48Z).

Premises, each read with `git show <sha>:<path>`:

1. **No Bedrock translation reviewer exists.** `git grep -n -i bedrock` over `scripts/` at the vitana-v1 pin finds
   Bedrock only in `scripts/whats-new/draft-entry.mjs:119-136` (a drafter for What's New cards, not a reviewer). No
   `scripts/i18n/` folder exists on main.
2. **The translator clears flags.** `vitana-v1:scripts/translate-keys.mjs:4-6` states it walks `_pending_review` keys,
   translates them and "clears the _pending_review flag per successful key".
3. **The audit has no Bedrock path.** `vitana-v1:scripts/i18n-audit-llm.mjs:68` defaults `PROVIDER` to `deepseek`; the
   provider calls are `callGemini` (`:100`), `callAnthropic` (`:117`) and `callDeepSeek` (`:134`). Bedrock is absent.
4. **The checklist script writes to Supabase.** `vitana-platform:scripts/journey/generate-checklist-translations.mjs:20`
   calls Claude on Bedrock through the AWS CLI. Its docblock (`:149-152`) gives the reason for no SDK: it shells out
   rather than adding `@aws-sdk/client-bedrock-runtime`. The invocation is `aws bedrock-runtime invoke-model` at `:172`.
   `:112` is the Supabase REST fetch (`rest()`, `:111-112`), which writes results to Supabase. It is not usable for
   catalogs, which are files in `src/i18n/`.
5. **The Bedrock call pattern exists without a new dependency.** `vitana-v1:scripts/whats-new/draft-entry.mjs:27-28`
   sets `MODEL_ID` `eu.anthropic.claude-sonnet-4-6` and region `eu-central-1`; `:136` runs
   `aws bedrock-runtime converse` through `execFileSync`.
6. **Account and region rule.** `vitana-platform:CLAUDE.md:392` (IF–THEN 11): AWS account/region must be
   `472838866351` / `eu-central-1`, else stop. The reviewer checks this before any model call.
7. **Evidence format is defined by PR #1680, not on main.** PR #1680 (`kiro/native-catalog-evidence/harness`, head
   `b9b467ffc6b94445a5234d9008b2bad5eddea9e5`, open) adds `docs/validation/VTID-05761/review/README.md` (record
   format, `pass|reject`, `prompt_sha256`, the rule that the reviewer is not the author) and
   `scripts/i18n/check-pending-review-evidence.mjs` (the checker). This plan uses that record format and does not
   duplicate the checker.
8. **Protected files.** `vitana-platform:scripts/collab/protected-gate-files.json` lists no path under `scripts/i18n/`
   or `docs/validation/VTID-*/review/`. No lane here touches a protected file.

## Decisions (each decided by Kiro from the premises above)
1. **Two lanes, not three.** The brief lists `flag-clear` as a third lane. The checker it describes is PR #1680's.
   A lane here would duplicate it, so this plan has no flag-clear lane. The flag removal is a later PR that depends on
   #1680 merging and on a live review run.
2. **Bedrock through the AWS CLI, no SDK, with the Converse API.** The reviewer calls
   `aws bedrock-runtime converse`, the way `draft-entry.mjs:136` does, and not `invoke-model` (premise 4, `:172`, and the
   invoke-model example in `vitana-platform:.claude/rules/backend.md:100`). Reasons: the reviewer lives in vitana-v1,
   which already uses Converse; Converse takes one message format for any Bedrock model, so the model override works
   without a per-model body; the test stubs follow one wire format (`output.message.content`). Trade-off: a reader who
   compares this with the §2b example sees two invocation styles in the repo. Adding an SDK would add a dependency, so
   that choice is not open.
3. **Model.** Default `eu.anthropic.claude-sonnet-4-6`, the same id as premise 5, overridable with
   `BEDROCK_REVIEW_MODEL_ID`. The translator is DeepSeek or Gemini (premise 2 and 3), so the reviewer is a different
   model family from the author. The record names the model that answered.
4. **Account guard.** Before any model call the script runs `aws sts get-caller-identity` and refuses to run unless the
   account is `472838866351` and the region is `eu-central-1` (IF–THEN 11). Both checks run through the injected
   runner, so tests cover them without AWS.
5. **Verdict parsing fails closed.** The model must return one JSON object `{"verdict":"pass"|"reject","reason":"..."}`.
   Anything else writes no record and exits 1. A parse failure is never recorded as a reject, so a flaky model cannot
   create false evidence.
6. **Record shape is exactly the #1680 shape.** Eight fields: `key_path`, `catalog_file`, `locale`, `value`, `verdict`,
   `reviewer_model`, `timestamp`, `prompt_sha256`. The reason text goes to stdout only, so every record stays well
   formed for the checker.
7. **No write to the evidence folder in this plan.** `--out` has no default. The live run passes
   `docs/validation/VTID-05761/review` (the folder PR #1680 creates) explicitly, later. The lanes here write no file
   there.

## Lanes
- `reviewer-script` (vitana-v1): `scripts/i18n/bedrock-review.mjs`, a CLI and library. Input: a JSON list of items
  `{key_path, catalog_file, locale, value, reference: {en, de?}}`. Output: one record per item.
- `reviewer-tests` (vitana-v1): `scripts/i18n/__tests__/bedrock-review.test.mjs`, `node:test` with a fake runner.
  `depends_on: reviewer-script`, because it imports the module.

Shared files: none. The two lanes write different files. `scripts/i18n/__tests__/` is shared with PR #1680, which
adds a different file there; no lane edits #1680's files.

## Interfaces between lanes
- `bedrock-review.mjs` exports `runReview({ items, runner, now, model, region, expectedAccount })`, which returns
  `{ records, failures }`. `runner` is `(args: string[], stdinPath?: string) => string`, the only I/O.
- `buildPrompt(item)` returns the prompt text. `promptSha256(text)` returns 64 lowercase hex characters.
- `checkIdentity(runner, expectedAccount, region)` throws on a mismatch before any `converse` call.

## Tests and commands
- New test, red on base: `scripts/i18n/__tests__/bedrock-review.test.mjs` fails on `origin/main` because the module
  does not exist yet.
- Run: `node --test scripts/i18n/__tests__/bedrock-review.test.mjs`.
- Lint of the new files: `node --check scripts/i18n/bedrock-review.mjs`.
- No `npm install`, no `package.json` change.

## Measurement
`docs/validation/native-catalog-bedrock-review/timings.json` per `planning.md` / `collaboration.md` §8b.

## Owner-free check
Nothing in this plan needs the owner: no G1, G2 or G3, no vendor or SDK choice, no IAP decision, no store, no Mac, and
no live system.

## Out of scope / owner-gated
- **The live review run** calls Bedrock on real catalog values. It is a model call and not a database write, but it
  runs later under the owner stop rules, after this plan merges. The plan does not run it.
- **Clearing any `_pending_review` flag.** No flag is cleared by this plan. Clearing needs the live run, a passing
  record for each value, and #1680's checker accepting the PR.
- **Changing `translate-keys.mjs`, `i18n-audit-llm.mjs` or the checklist script.** They stay as they are.
- **Production.** No deploy and no write to Supabase, AWS or the gateway. The reviewer tests use a fake runner.

## Risks
- A model may approve a poor translation. Mitigation: the reviewer is only evidence, the human-readable reason goes to
  stdout, and the flag stays until the reviewer's records pass #1680's checker.
- #1680 may change its format before it merges. Mitigation: `reviewer-tests` pins the eight fields, and a change to
  #1680 requires a new lane.

## Unchanged
Every existing i18n script, every `src/i18n/` shard, `package.json`, `scripts/collab/**`, `.kiro/steering/**`,
`CLAUDE.md`, and the lane-scope and lane-path rules.
<!-- plan:end -->
