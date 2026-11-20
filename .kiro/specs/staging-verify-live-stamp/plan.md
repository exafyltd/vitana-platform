---
change_class: standard
---
# Plan — staging-verify-live-stamp

Author: Kiro, session `kiro-exafyltd-202611131736-78e6` (seat `exafyltd`). Repo: `exafyltd/vitana-platform` only
(`.github/workflows/**` + `scripts/ci/**`, so this needs a sparred plan, not `frontend-simple` — CLAUDE.md Part 1
rules 51–55). 1 lane, 2 files. No product code, no migration, no live write, no VTID allocated by hand.

<!-- plan:begin -->
## Goal
Task given to this session (root cause already diagnosed, not re-derived here): `.github/workflows/STAGING-VERIFY.yml`'s
`workflow_dispatch` trigger requires a `commit_sha` input and uses it as-is as "the commit under test" for every
manual dispatch, with no cross-check against what staging actually serves. `STAGING-VERIFY-NIGHTLY.yml` already does
this correctly — it calls `run.mjs stamp --service <svc> --repo-root target` to get the live-served commit before
dispatching with that exact SHA — but a manual dispatch of `STAGING-VERIFY.yml` has no such safeguard. This is what
happened on run https://github.com/exafyltd/vitana-platform/actions/runs/43434282759: dispatched with
`commit_sha=388bef0eb886acdd2555d20118d28dbbe4f9f10c` (main's tip at dispatch time) when staging was actually serving
`96d43e09f457f543b443c66e333f4837fb82eebb` (confirmed via ECS task-def revision 531) — it correctly failed, but only
after being pointed at the wrong target, burning a full verification run.

Fix: make `commit_sha` optional on the `workflow_dispatch` input. When left empty, the "Resolve commit under test"
step calls the equivalent of the existing `stagingStamp(service)` function (via its `stamp` CLI subcommand, already
in `run.mjs`) to find the live-served commit and uses that instead. When `commit_sha` IS explicitly supplied, today's
behavior stays completely unchanged — an explicit input is a deliberate request to verify that specific commit (e.g.
a pinned-rollback re-verification per VTID-04709) and must never be silently overridden. Add a test that fails before
the fix and passes after.

## Today's behavior (file:line, before this change)
- `.github/workflows/STAGING-VERIFY.yml:56-59` — `commit_sha` is `required: true`, no default; GitHub's
  `workflow_dispatch` form/API refuses a dispatch that omits it, so there is no way to ask "verify whatever staging
  currently serves" without first finding that commit yourself (by hand, or by reading the ECS task definition).
- `.github/workflows/STAGING-VERIFY.yml:95-101` — `EVENT_SHA` for a `workflow_dispatch` event is `inputs.commit_sha`
  verbatim; `SERVICE`/`EVENT_SHA` are job-level `env`, available to every step.
- `.github/workflows/STAGING-VERIFY.yml:121-137` ("Resolve commit under test (VTID-04715)") — sets `SHA="$EVENT_SHA"`,
  then overrides it only from a `deployed-commit` artifact (`workflow_run` only, VTID-04715 pinned-rollback case).
  For `workflow_dispatch` there is no artifact, so `SHA` stays exactly what the caller typed — unverified against
  live staging.
- `.github/workflows/STAGING-VERIFY.yml:139-147` ("Validate inputs") only checks `SHA` is 40 hex chars; it cannot
  tell a stale/wrong sha from a correct one.
- `scripts/ci/staging-verify/run.mjs:102-108` (`stagingStamp`) and `run.mjs:573-583` (`args.cmd === 'stamp'`) — the
  live-served-commit lookup already exists and is already used correctly: `.github/workflows/STAGING-VERIFY-NIGHTLY.yml:57-61`
  checks out the service's repo at `main` (`fetch-depth: 0`, so the stamp resolves against full history) and runs
  `node runner/scripts/ci/staging-verify/run.mjs stamp --service <svc> --repo-root target` to get the commit it then
  dispatches `STAGING-VERIFY.yml` with. `STAGING-VERIFY.yml` itself never calls this.

## The fix
`.github/workflows/STAGING-VERIFY.yml` only:
1. `commit_sha` input: `required: false`, `default: ''` (was `required: true`, no default). Description updated.
2. `run-name`: falls back to `(live)` when every other source of a displayed sha (the three existing operands) is
   empty, instead of showing a blank `@ `. Cosmetic only — never used for any check.
3. Header comment (line ~11) documents the optional-input behavior for a reader of the file.
4. Step order in the `verify` job: "Checkout runner (vitana-platform main)" and `actions/setup-node@v4` move to the
   top of `steps:` (both already unconditional and independent of every other step — reordering them changes
   nothing for any existing trigger). Two new steps, each gated
   `if: env.SERVICE == '<service>' && github.event_name == 'workflow_dispatch' && inputs.commit_sha == ''`:
   "Checkout target main for live-served commit lookup (gateway)" and "… (community-app)" — a full-history
   (`fetch-depth: 0`) checkout of the service's repo at `main`, to path `target`, so the stamp the lookup returns can
   be resolved to a full sha (`git rev-parse`) the same way `stamp`'s own CLI handler already does. The
   community-app variant checks out the cross-repo `exafyltd/vitana-v1` and so carries
   `token: ${{ secrets.VITANA_V1_READ_TOKEN || secrets.GITHUB_TOKEN }}` — the same token the existing "Checkout
   commit under test (community-app)" step (`STAGING-VERIFY.yml:171` before this change) and
   `STAGING-VERIFY-NIGHTLY.yml:46` already use for the identical cross-repo checkout. Both new steps are no-ops
   (skipped) whenever an explicit `commit_sha` was given or the event isn't `workflow_dispatch` — a byte-for-byte
   no-op for every trigger this workflow already handles.
5. "Resolve commit under test (VTID-04715)" step: one new `elif` branch, after the existing `deployed-commit`
   artifact branch: `elif [ -z "$SHA" ] && [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]` — only reachable when
   `commit_sha` was omitted (today this combination cannot occur at all, since `commit_sha` was required) — runs
   `node runner/scripts/ci/staging-verify/run.mjs stamp --service "$SERVICE" --repo-root target` (the `target`
   checked out by step 4) and validates the result is a 40-hex sha, failing loudly (`::error::`, `exit 1`) if not.
   The existing `if [ -f "$RECORDED" ]` branch (VTID-04709 pinned rollback) and the final `SHA="$EVENT_SHA"` fallthrough
   (every other case, including an explicit `commit_sha`) are untouched — same text, same order, same effect.
6. "Checkout commit under test (gateway/community-app)" (the real checkout the test suite runs against) and
   everything from "Run STAGING-VERIFY" onward: untouched.
`run.mjs` and `lib.cjs` are not modified — the lookup this calls into already exists and is already correct.

## Tests and evidence
`scripts/ci/staging-verify/workflow.test.cjs` (run by `UNIT.yml` on every PR — it globs every `scripts/**/*.test.{cjs,mjs}`):
- Static: `commit_sha` is `required: false` with `default: ''`; the two new checkout steps exist, gated per service
  and on `inputs.commit_sha == ''`; the community-app one carries the `VITANA_V1_READ_TOKEN`/`GITHUB_TOKEN`
  cross-repo token; the real checkout-at-SHA steps never reference `commit_sha` (so an explicit value is never
  second-guessed); step order puts the runner checkout and Node before the live-stamp lookup.
- Behavioral: extracts the exact `run:` text of "Resolve commit under test" from the YAML (not a reimplementation)
  and executes it with `bash --noprofile --norc -eo pipefail` (GitHub Actions' own invocation) with a fake `node`
  first on PATH standing in for `run.mjs stamp`. Cases: `workflow_dispatch` + empty `commit_sha` → the fake `node` is
  called exactly once with `stamp --service <svc> --repo-root target` and its output becomes `SHA`;
  `workflow_dispatch` + given `commit_sha` → the fake `node` is never called, `SHA` stays the given value;
  `workflow_run` with a recorded pinned commit, and `workflow_run`/`repository_dispatch` with no artifact →
  unchanged, fake `node` never called (regression proof for every path this workflow already handles); the lookup
  itself failing (empty stamp) → the step exits non-zero with `::error::`, and `SHA` never reaches `$GITHUB_ENV`.
- Evidence of fails-before/passes-after: `docs/validation/<VTID>/commands.log` records `node --test
  scripts/ci/staging-verify/workflow.test.cjs` run against this PR's base (5 of the 12 new/changed cases fail) and
  against its head (all pass), plus the full `scripts/ci/staging-verify/*.test.{cjs,mjs}` suite green (135 cases) and
  a `js-yaml` parse check of the edited workflow file.

## Risks
- A `workflow_dispatch` with `commit_sha` omitted now takes two extra full-history checkouts (one for the lookup, one
  for the real test) instead of one — slower, never wrong; every automatic trigger (`workflow_run`,
  `repository_dispatch`) and every dispatch that still supplies `commit_sha` is unaffected (the new steps are
  skipped entirely).
- If staging is serving nothing resolvable (e.g. `build-info` unreachable), the run now fails fast in "Resolve commit
  under test" with a clear message, instead of failing later in "Validate inputs" with a less specific one — strictly
  better, not a behavior change for any case that passes today.

## Unchanged
`run.mjs`, `lib.cjs`, `STAGING-VERIFY-NIGHTLY.yml`, the `report` job, OASIS recording, every other workflow; no CI
variable/secret/token change; no production write; no migration.
<!-- plan:end -->
