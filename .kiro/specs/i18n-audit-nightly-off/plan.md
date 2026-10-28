# Plan — i18n-audit-nightly-off
Stop the nightly i18n audit run, which produces nothing usable. Keep the manual audit, and point it at a provider
that answers.
<!-- plan:begin -->
## Problem
`.github/workflows/i18n-audit-llm.yml` has two triggers: `workflow_dispatch` (one locale, commits to the dispatching
branch) and a nightly `schedule` (`30 3 * * *`, job `audit-nightly`, 9 locales on `--provider=gemini`, each pushing
`auto/i18n-audit-<locale>-<yyyymmdd>` and never opening a PR).

**Evidence (read 2026-10-19, session kiro-202610181950-f0b7):**
- Last scheduled run 39227796755: Gemini answers `HTTP 429 — You exceeded your current quota` on almost every batch.
  `scripts/i18n-audit-llm.mjs` retries 3× and moves on. The step ends `exit 0` by design, so all 30 recent runs show
  `success`.
- Nothing from the nightly job reaches `main`: the newest audit commits on `main` are 2026-08-24, from manual
  dispatches on `deepseek`. The `auto/` branches are never merged. The newest one is a 126-file, 108k-line diff.
- The job had created 945 `auto/i18n-audit-*` branches. 811 superseded ones were deleted on 2026-10-18; it adds 9 a
  night.
- About 9 runner jobs a night, each running `npm ci` (about 1 min) plus the audit.

**Providers today:** `gemini` is out of quota. `anthropic` is the direct Anthropic API, and that account has no
credit (platform CLAUDE.md rule 10b). `deepseek` works, but DeepSeek did the translating, so the script warns about
correlated errors.

## Changes
1. `.github/workflows/i18n-audit-llm.yml`: remove the `schedule:` trigger and the `audit-nightly` job. Keep
   `audit-single` (manual) unchanged except for change 2. Update the header comment ("Triggers") to match.
2. Same file: the `provider` input's `default` goes from `gemini` to `deepseek`, the only provider that answers
   today. The choice list stays `gemini | anthropic | deepseek`, so a working Gemini key can still be chosen.
3. `CLAUDE.md` (§ Catalog quality): `gh workflow run i18n-audit-llm.yml -f locale=<code> -f provider=gemini`
   becomes `-f provider=deepseek`, with one sentence on why (Gemini quota, Anthropic API has no credit) and that a
   Bedrock auditor is the follow-up.
4. `scripts/i18n-audit-llm.mjs`: the script's own fallback (`const PROVIDER = args.provider || 'gemini'`, ~L67)
   becomes `'deepseek'`, and the usage comment (~L34–40, "default gemini") says `default deepseek`. Otherwise a
   direct `node scripts/i18n-audit-llm.mjs` run without `--provider` still lands on the exhausted Gemini key.
5. `.github/workflows/i18n-audit-llm.yml`: drop `pull-requests: write` from the workflow `permissions` block. Only
   `audit-nightly` opened branches for PRs. `audit-single` only commits and pushes to the dispatching branch, which
   needs `contents: write` and nothing else.

## Not in this plan
- A Bedrock (Claude) provider in `scripts/i18n-audit-llm.mjs`. That is the right auditor (independent of the
  DeepSeek translator, AWS-billed), but it needs AWS OIDC credentials in this workflow. It is a separate plan.
- Deleting the 134 remaining `auto/i18n-audit-*` branches (the newest per locale plus the last 14 days). Once the
  schedule is off they stop growing, and they can go in a later cleanup.
- `docs/i18n-8-language-parity-plan.md` L167 mentions `provider=gemini`. That is a historical plan, so it is left
  as is.

## Tests
- `actionlint`/YAML parse of the workflow (PR-GATE runs it). `gh workflow view i18n-audit-llm.yml` after merge
  shows only `workflow_dispatch`.
- No scheduled run of `i18n-audit-llm.yml` appears after 03:30 UTC on the day after merge, and no new `auto/i18n-audit-*`
  branch appears.
- Deploys nothing, so there is no staging suite (no Gate 2).

## Lane
- `workflow-off`, **repo `exafyltd/vitana-v1`** (every file above is in vitana-v1; the spec lives here in
  vitana-platform because PLAN-SPAR only runs here). Executor **claude** (governance paths `.github/**`,
  `CLAUDE.md`), reviewer `exafy`. Sequence: plan → sparring → policy approval → VTID → code. No implementation
  exists before the VTID: an earlier draft (exafyltd/vitana-v1#1463) was closed unmerged during sparring, and the
  executor opens a fresh lane PR only after the VTID is allocated.
<!-- plan:end -->
