# Tasks — native-catalog-bedrock-review

Plan: `plan.md`. Two lanes, both in `exafyltd/vitana-v1`. One PR per lane. A lane changes only its `paths`. VTIDs come
from CI PLAN-SPAR after convergence. No lane clears a `_pending_review` flag, calls Bedrock, or writes to a live
system. No credential, no production host.

## Reviewer script
<!-- lane: reviewer-script -->
- [ ] R1 Create `scripts/i18n/bedrock-review.mjs`. Export `buildPrompt(item)`, `promptSha256(text)` (SHA-256 of the exact
  UTF-8 prompt bytes, lowercase hex), `checkIdentity(runner, expectedAccount, region)` and
  `runReview({ items, runner, now, model, region, expectedAccount })` as in `plan.md` "Interfaces between lanes".
- [ ] R2 `checkIdentity` runs `aws sts get-caller-identity --query Account --output text` and checks the region. It throws
  unless the account is `472838866351` and the region is `eu-central-1`. `runReview` calls it before the first model
  call. A throw stops the run with exit 2 and no record.
- [ ] R3 The model call uses `aws bedrock-runtime converse --region <region> --cli-input-json file://<tmp>` (Converse
  wire format: `modelId`, `system`, `messages`, `inferenceConfig`; reply text in `output.message.content`, not
  `invoke-model`), with the model id from `BEDROCK_REVIEW_MODEL_ID` or the default `eu.anthropic.claude-sonnet-4-6`. The prompt asks for one JSON
  object `{"verdict":"pass"|"reject","reason":"..."}` and nothing else. No Google endpoint, no direct Anthropic endpoint,
  no SDK import, no new dependency.
- [ ] R4 Parse the reply with a strict parser. An unparseable reply, a verdict other than `pass` or `reject`, or a
  missing `reason` yields a failure entry and no record (exit 1). Never record a parse failure as `reject`.
- [ ] R5 For each passing or rejecting reply, write one record with exactly these fields: `key_path`, `catalog_file`,
  `locale`, `value`, `verdict`, `reviewer_model`, `timestamp` (ISO-8601 UTC from `now()`), `prompt_sha256`. `catalog_file`
  is `src/i18n/<locale>/<file>.json` as given in the input. The reason goes to stdout. One file per record, named
  `<locale>__<catalog-stem>__<key_path>.json`, written to `--out`. `--out` has no default. The live run later passes
  `docs/validation/VTID-05761/review` explicitly.
- [ ] R6 CLI: `node scripts/i18n/bedrock-review.mjs --input <items.json> --out <dir> [--dry-run]`. `--dry-run` runs the
  identity check and prints the prompt hashes, but makes no model call and writes nothing. Missing or invalid arguments
  exit 2.

Acceptance:
- Change types: Tooling/docs, Integration (AWS Bedrock call through the CLI)
- Outcome: a reviewer exists that writes evidence records in the #1680 format and refuses to run outside the
  `472838866351` / `eu-central-1` account and region.
- States: n/a: no user-facing state.
- Surfaces: n/a: no screen, no route.
- Locales: n/a: the script reads catalog values, it does not show text.
- Accessibility: n/a: no UI.
- Contract: the record has exactly the eight fields of `docs/validation/VTID-05761/review/README.md` on PR #1680
  (head `b9b467ffc6b94445a5234d9008b2bad5eddea9e5`); `pass|reject` only; the evidence folder is written only when the
  CLI runs with `--out`.
- Safety: no flag is cleared by this lane. Nothing in `src/i18n/` changes. The script makes no model call in CI.
- Staging proof: not applicable (CLI, no deploy). Proven by `reviewer-tests`.

**Never:** no `ANTHROPIC_API_KEY`, no `GOOGLE_*` variable, no write to Supabase or a gateway, no commit of a live review
record from this lane, no VTID by hand.

## Reviewer tests
<!-- lane: reviewer-tests -->
- [ ] T1 Create `scripts/i18n/__tests__/bedrock-review.test.mjs` with `node:test` and `node:assert/strict`. Use a fake
  runner: a function that returns canned strings for `sts get-caller-identity` and `bedrock-runtime converse`, and records
  every argument list it was called with. No `child_process` call and no network in the test.
- [ ] T2 Test the identity guard: a wrong account, a wrong region and a runner error each throw before any `converse`
  call. The fake runner records zero `converse` calls in those cases.
- [ ] T3 Test the verdict path: a `pass` reply and a `reject` reply each produce one record with exactly the eight fields,
  `value` equal to the input value, `prompt_sha256` equal to the SHA-256 of `buildPrompt(item)`, `timestamp` equal to the
  injected `now()`, and `reviewer_model` equal to the model passed in.
- [ ] T4 Test fail-closed parsing: a non-JSON reply, a verdict of `maybe` and a missing `reason` each produce a failure
  entry and no record. A test checks that no record is ever written with verdict `reject` for a parse failure.
- [ ] T5 Test the record file name and content for one locale (`de`) and one key with a dot-free `key_path`, and that a
  `key_path` containing `.` is rejected with a failure entry.
- [ ] T6 Test `--dry-run` (through `runReview` with a flag): zero `converse` calls and zero records.
- [ ] T7 Red on base: run `node --test scripts/i18n/__tests__/bedrock-review.test.mjs` on `origin/main` before R1 lands.
  It fails with a module-not-found error. Record that output in the PR body.

Acceptance:
- Change types: Tooling/docs, Integration (fake AWS runner)
- Outcome: the reviewer's identity guard, verdict path and fail-closed parsing are proven without a live model call.
- States: n/a: no user-facing state.
- Surfaces: n/a: no screen.
- Locales: n/a: no user-visible text.
- Accessibility: n/a: no UI.
- Contract: the eight-field record shape is pinned by T3; the checker of #1680 is not imported or copied.
- Staging proof: not applicable. The suite is a unit suite and runs in CI with no network, no AWS call and no live
  system.

**Never:** no live Bedrock call in the test, no real AWS credential, no edit to the lane's own `paths` outside the test
folder, no `.skip` or loosened assertion to get green.

## Plan-level commands
- `node --test scripts/i18n/__tests__/bedrock-review.test.mjs` (after both lanes).
- `node --check scripts/i18n/bedrock-review.mjs`.
