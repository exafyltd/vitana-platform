# Sparring round 1 — in_progress

Session: `7565ba31-3c19-4bf9-80ce-dba0ddca43ad` · plan hash `a0e06292b53ea5fcfb9b7e35df99bbb79d71f969a3bdca4e7c854f47596a744d`

## Summary

Verified 4 premises against the pinned vitana-platform code. The vitana-v1 repo has no pinned ref in this session, so premises 1–3 and 5 (all vitana-v1) could not be independently verified — noted below but not raised as findings against the plan. The plan is well-scoped, governance-compliant, and conservative. One factual error and one notable API mismatch found.

## Findings

### R1-F1 [major]

Premise 4 says the checklist script's Bedrock call pattern at `:150` uses `aws bedrock-runtime converse` and that this is the pattern the new reviewer reuses. The actual code at lines 172–175 uses `aws bedrock-runtime invoke-model`, not `converse`. The documented and verified Bedrock invocation pattern in §2b (backend.md lines 100–104) also shows `invoke-model`. `invoke-model` and `converse` are different AWS Bedrock APIs with different request/response wire formats (invoke-model takes native Anthropic JSON; converse uses AWS's unified message format). The plan must be precise about which API it uses, since the prompt construction, the response parsing, and any test stubs all depend on it.

- `exafyltd/vitana-platform:scripts/journey/generate-checklist-translations.mjs:172` — 'bedrock-runtime', 'invoke-model',
          '--region', BEDROCK_REGION,
          '--model-id', BEDROCK_MODEL_ID,
          '--body', `fileb://${inPath}`,
- `exafyltd/vitana-platform:.claude/rules/backend.md:100` — python3 -c "import json;open('/tmp/b.json','w').write(json.dumps({'anthropic_version':'bedrock-2023-05-31','max_tokens':16,'messages':[{'role':'user','content':'hi'}]}))"
aws bedrock-runtime invoke-model --region eu-central-1 \
  --model-id eu.anthropic.claude-sonnet-4-6 --body fileb:///tmp/b.json /tmp/o.json

Suggestion: Clarify which Bedrock CLI subcommand the reviewer will actually use. If it uses `converse` (matching the claimed vitana-v1 draft-entry.mjs pattern), state that explicitly and note it differs from the checklist script and §2b's documented `invoke-model` pattern. If it uses `invoke-model` (matching the only verifiable pattern in this repo), update premise 4/decision 2 accordingly. Either way, the test stubs must match the chosen wire format.

### R1-F2 [minor]

Premise 4 line references are inaccurate: `:150` points to a JSDoc comment (the function docblock starting at line 149), not the AWS CLI invocation (line 172). `:112` for 'writes results to Supabase REST' is one line off — the `rest()` helper starts at line 111. These are cosmetic but matter for a plan whose premises must be verifiable by a reviewer.

- `exafyltd/vitana-platform:scripts/journey/generate-checklist-translations.mjs:149` — /**
 * Invoke Claude on Bedrock via the AWS CLI (VTID-04236 — replaces the
 * former direct Gemini call). Shells out rather than adding an
 * `@aws-sdk/client-bedrock-runtime` dependency to this standalone script:
- `exafyltd/vitana-platform:scripts/journey/generate-checklist-translations.mjs:110` — /** PostgREST helper (service role). Times out so a stalled call can't hang the run. */
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {

Suggestion: Fix line references in premise 4: the AWS CLI call is at :172, not :150; the REST helper is at :111, not :112.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
