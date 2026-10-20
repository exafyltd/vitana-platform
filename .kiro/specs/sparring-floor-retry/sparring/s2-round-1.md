# Sparring round 1 — in_progress

Session: `3b3d1387-6c4d-49dd-969c-7d1ce1a43ad0` · plan hash `d13baae4609192225bbc1b2dd0d38bcdf2200ae6b943a7b17444c2d791d0c26b`

## Summary

The plan is well-constructed and its core premises check out against the code. I verified: hasCodeAccess is Boolean(planSparringGithubToken()) (service L77); INFRA_REASONS includes partner_output_invalid but RETRYABLE_REASONS does not (plan-spar.mjs L32-33); gateway RETRYABLE_REASONS omits evidence_floor_not_met/partner_output_invalid (L46); the invalid-submission exit returns evidence_floor_not_met/partner_output_invalid (partner.ts L242-244); ToolLogEntry currently has no status field (types.ts L78-84); citesReadFile counts only read_file with ok:true (partner-prompt.ts L166-168); step() retryInfra requires cur.infra && cur.retryable (plan-spar.mjs L186). The relabel-to-code_access_unavailable logic at the three exits, the gateway dedup predicate, and the script migration are internally coherent and mutually consistent (change 2 is actually required for change 3 to work). Three findings raised: tool_log null-safety in the legacy predicate/migration (surfaced by the existing test fixture), a 429 gap in isAccessStatus, and the over-broad migration trigger condition.

## Findings

### R1-F1 [major]

The legacy predicate and change-3 migration read the live session's round-1 `tool_log` (and change 2 reads `round1.tool_log`), but neither the plan nor its test list specifies null/undefined-safety for a session whose round 1 has no `tool_log`. The existing test fixture `sess()` (plan-spar.test.mjs L28-31) builds rounds with only `{round, plan_hash, review}` and NO `tool_log`, so the existing test 'partner_output_invalid goes to Claude but is not auto-retried' (L193-204) will, on its second step(), trigger the new migration's `client.get` path against a live session whose `rounds[0].tool_log` is `undefined`. A bare `.filter`/`.every` over `tool_log` throws a TypeError. The plan's test list (section 4 items a-d) adds new tests but does not mention updating this existing test or making the predicate null-safe.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.test.mjs:28` — const sess = (id, rounds, verdict, extra = {}) => ({ id, verdict, escalation_reasons: [], ... rounds: rounds.map((fs, i) => ({ round: i + 1, plan_hash: 'h', review: { summary: 's', findings: fs, acknowledgements: [] } })), ...extra, });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.test.mjs:193` — test('review fix: partner_output_invalid goes to Claude but is not auto-retried ...', async () => { ... const bad = sess('S1', [[]], 'escalated', { escalation_reasons: ['partner_output_invalid'] }); ... assert.equal((await step(...)).action, 'nothing_to_do');

Suggestion: Make `legacyCodeAccessFailed` and the change-3 migration defensive: treat a missing/empty `tool_log` (e.g. `(rounds[0]?.tool_log ?? [])`) as 'not a legacy all-failed session' so it falls through to `reclassified: false`. Update the existing 'partner_output_invalid' test to give its session a `tool_log` (or assert the new `client.get` is called and no `create` happens), and add a test covering a round-1 without `tool_log`.

### R1-F2 [minor]

`isAccessStatus(s) = s === 0 || s === 401 || s === 403 || s >= 500` omits HTTP 429 (GitHub's secondary rate limit / 'Too Many Requests'). A code-read outage caused by GitHub rate limiting would produce all-`read_file`-failed entries with `status: 429`, which is NOT an access status, so the round would be labelled `evidence_floor_not_met` (non-retryable) even though the partner could not read code, contradicting the plan's stated intent that 'a partner that cannot reach GitHub' escalates as `code_access_unavailable`. 429 is also already recognised as retryable elsewhere (isRetryableThrottle matches `\b429\b`).

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:57` — export function isRetryableThrottle(error) { ... /\b429\b/.test(e) ... }

Suggestion: Include `s === 429` in `isAccessStatus` (or explicitly document 429 as intentionally excluded and why it is not a code-access failure).

### R1-F3 [minor]

The change-3 migration trigger ('verdict: escalated, retryable === false, no reclassified key') is broader than the legacy-failure shape it targets. Every escalated-but-non-retryable entry — including `round_cap_reached`, `disputed_items`, and genuine post-fix `evidence_floor_not_met` — will make one extra `client.get` network call and one state.json write on its next push before recording `reclassified: false`. The plan's 'a normal no-op push makes no network call' only holds after that first reclassification, and test (c)/(d) confirm this one-shot behaviour. This is wasteful but bounded and not a correctness bug.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:186` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable; const replan = cur && cur.verdict === 'escalated' && !cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText);

Suggestion: Optionally narrow the migration trigger to entries whose escalation reasons include `evidence_floor_not_met`/`partner_output_invalid` so `round_cap_reached`/`disputed_items` entries avoid the extra `client.get`; otherwise the behaviour is acceptable but should be stated precisely (one network call per un-reclassified escalated entry).

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
