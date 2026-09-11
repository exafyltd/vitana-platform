# VTID-03817 — Flip Operator to DeepSeek-V4.1-Flash + emoji tone, fix 2 blocking catalog bugs

## Report

The platform owner asked to point the `operator` stage (Command Hub chat +
voice-to-voice) at DeepSeek and test it live, and to make replies emoji-rich.
Attempting the flip through the governed `POST /api/v1/llm/routing-policy`
API — rather than a raw table write — surfaced two independent, pre-existing
bugs that had made that endpoint unusable for ANY policy update since
Bedrock became the standing default provider: `llm_allowed_models` had zero
`bedrock` rows at all, and separately `deepseek-chat`'s catalog entry was
missing `triage` from `applicable_stages` even though the live policy
already used it there. Both are fixed at the root via Supabase migrations
rather than repeating the direct-write workaround a prior session already
left evidence of. The flip itself, and a live test through the real
`/api/v1/operator/chat` endpoint, both succeeded — DeepSeek genuinely served
the request — but the reply's own text claimed to be Claude, a real
self-identification hallucination worth flagging rather than hiding.

## Acceptance Criteria

AC-1 — The `operator` stage's live, active routing policy targets
`deepseek/deepseek-flash` as primary, with a confirmed-invokable Bedrock
model as fallback, and every other stage is unchanged from v16.

TEST: `outputs/live-verification.txt` — the v17 POST response body, diffed
against the pre-change GET response for all 7 untouched stages.

AC-2 — The two catalog bugs blocking the governed policy-update API are
fixed at the root (migration, not a one-off manual patch), not merely
routed around for this one change.

TEST: `outputs/live-verification.txt` records both `apply_migration` calls
(`bootstrap_bedrock_deepseek_flash_catalog_gap`,
`fix_deepseek_chat_applicable_stages_triage_gap`) and the before/after
`POST /routing-policy` responses proving the second attempt succeeded
where the first did not, for reasons unrelated to the operator change
itself.

AC-3 — The flip is verified against the exact live endpoint the Command Hub
UI calls, not a synthetic/internal path.

TEST: `outputs/live-verification.txt` — `grep 'operator/chat'` against
`command-hub/app.js` confirms the UI's own call site, then the same
`POST /api/v1/operator/chat` request and its `meta.provider`/`meta.model`
fields.

AC-4 — Any model self-identification inaccuracy observed during the live
test is recorded honestly, not smoothed over or omitted.

TEST: `outputs/live-verification.txt` — the raw reply text is quoted
verbatim ("I'm Claude, made by Anthropic") alongside the `meta` fields
proving DeepSeek actually served it.

AC-5 — The emoji tone change is a style instruction, not a hardcoded
sentence (NEVER-rule 41), and actually reaches the live surface (i.e. no
DB-backed personality override silently shadows the code default).

TEST: `commands.log` — the `ai_personality_config` query for `operator_chat`
returning no row, confirming the code default in
`services/gateway/src/services/ai-personality-service.ts` is what serves
today.

AC-6 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-7 — No regression: the operator-relevant test slice and the full gateway
suite both pass.

TEST: `outputs/jest-operator-filter.txt` (13/13 relevant suites, 72/72
tests) and `outputs/jest-full-suite.txt` (737/738 suites, 1 pre-existing
skip, 13,673/13,708 tests, 0 failures).

## Deliberately NOT attempted

- **Reproducing the emoji change on the live production chat within this
  VTID.** The DB routing flip (AC-1) took effect immediately with no
  deploy; the emoji code change (AC-5) only reaches
  `gateway.vitanaland.com` — the exact console the platform owner is
  testing against — once it clears the normal staging→PUBLISH pipeline.
  Flagged explicitly in the PR/changelog rather than implied as already
  visible.
- **Writing the emoji instruction as a DB-backed `ai_personality_config`
  override instead of a code change.** That mechanism exists
  (`updatePersonalityConfig`) and would have taken effect without a
  deploy, but `getPersonalityConfigSync`'s cache is only populated by a
  separate async warm path this investigation could not confirm is ever
  actually invoked for the `operator_chat` surface outside of a settings
  UI — writing the row and trusting it to be picked up risked a silent,
  hard-to-diagnose no-op. The code-default edit has no such uncertainty.
- **Auditing or fixing every other stage's catalog gaps beyond what the
  live v16→v17 diff actually required.** `llm_allowed_models` may have
  further inconsistencies against other historical policy versions; only
  the two gaps that actively blocked this specific, requested change were
  fixed.
