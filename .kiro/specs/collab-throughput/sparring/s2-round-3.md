# Sparring round 3 — escalated

Session: `1df87f89-7dc3-4dfa-bd1e-064c69be6c18` · plan hash `f5691d7a19244ada644e258d0cdfe34d2af8da2e7ea015c0f4bcf2a0f11d227c`

## Summary

The revision cleanly resolves the two prior round-2 findings (R2-F1 default-branch hardcoding, R2-F2 missing --comment-file), and the round-1 items are addressed (Usage-error comment file, missing-review guard, deterministic tie-break, and the concurrency-cap blocker is removed rather than shipped). The core remaining defect is in Change C's health-route failure classification: it treats transient GitHub-side conditions (0/network and 5xx) and rate-limit (429) as "token cannot read" → ok:false → code_access_down, which blocks all new sparring sessions and false-positively fires the alert. This directly contradicts the plan's own stated philosophy elsewhere in Change C, which carefully makes gateway-side transient failures "carry on as today." Only 401/403 unambiguously mean the token itself cannot read; 0/429/5xx are GitHub-outage/rate-limit transients and should not produce ok:false.

## Findings

### R3-F1 [major]

Change C defines the health route's 'token cannot read' condition as 'only 0/401/403/429/5xx', and plan-spar.mjs blocks on any ok:false by returning code_access_down before client.create/client.round. But a server-side 0 (GitHub network error), 429 (GitHub rate limit), or 5xx (GitHub outage) does NOT mean the sparring token cannot read — it means GitHub is transiently unavailable. Classifying these as ok:false replicates the exact false-outage failure the plan set out to prevent: a transient GitHub 429/5xx (or a GitHub regional outage) makes the health route answer ok:false for one or both repos, every plan-spar run returns code_access_down and starts no session, and the 30-min alert workflow fires falsely. This is internally inconsistent with the plan's own decision that a gateway-side 5xx/network failure 'carries on as today' — it treats GitHub-side transient failures as blocking while deliberately not blocking on gateway-side transient failures. Only 401 (missing/invalid token) and 403 (insufficient scope) are genuine 'token cannot read' signals.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:77` — hasCodeAccess: () => Boolean(planSparringGithubToken()),
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:142` — const url = `${GITHUB_API}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`; const resp = await doFetch(url, { method: 'GET', headers: headers() }); if (!resp.ok) return fail(`GitHub ${resp.status} reading ${repo}/${path}@${ref}`, { path });

Suggestion: Distinguish genuine token failure from transient GitHub unavailability: treat 401/403 as ok:false (token cannot read), but treat 0/429/5xx as a third state (e.g. 'unknown'/'degraded') that does NOT set ok:false and does not block plan-spar. Ensure the alert only fails on a definitive token problem, or re-add a distinct alarm for sustained GitHub 5xx rather than conflating it with a broken token. Add a Jest test pinning that a 429 or 5xx from GitHub on the README read yields ok (or a non-blocking state), matching the gateway-side 'carry on' rule.

### R3-F2 [minor]

Change B claims a malformed responses-<n>.md ('no json block, not an array') gives responses_invalid, and Verification requires 'malformed responses each give responses_invalid with the right ids'. But parseResponses surfaces these as thrown Errors (throw new Error('responses file has no ```json block') / 'responses json must be an array'), not a structured result. The plan also states main()'s single try/catch wraps step() and reports thrown errors as a generic failure ('gateway rejected/partner outage' style), exit 1. Unless the new local check explicitly catches parseResponses (and JSON.parse) and converts it to responses_invalid before the send guard, a malformed file throws out of step() and is reported as a generic failure rather than the responses_invalid message the plan and tests specify. The plan does not state that step() wraps parseResponses in the local-check path.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:51` — export function parseResponses(md) { const m = /```json\s*\n([\s\S]*?)\n```/.exec(md || ''); if (!m) throw new Error('responses file has no ```json block'); const v = JSON.parse(m[1]); if (!Array.isArray(v)) throw new Error('responses json must be an array'); return v; }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:204` — const respPath = path.join(sdir, `${prefix(state.sessions.length)}responses-${n}.md`); if (!existsSync(respPath) || cur.submitted.includes(n)) return { action: 'waiting_for_planner', wrote }; action = 'round'; session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText });

Suggestion: State explicitly that the local answer check wraps parseResponses/JSON.parse in its own try/catch and maps parse/JSON failures to responses_invalid with a 'malformed responses-<n>.md: <reason>' problem, rather than letting the Error propagate to main()'s generic handler. Pin this in the malformed-responses test so the assertion is on the responses_invalid action/message, not just exit code 1.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Removing the branch name (calling the contents API with no ref) is a sound resolution: GitHub serves each repo's default branch, and treating 404 as ok:true means a missing README cannot block. The master-vs-main hardcoding is gone.
- R2-F2: acknowledged — Making --comment-file optional with a stdout fallback and no file write when absent correctly removes the TypeScript/undefined-path crash risk while preserving the exit-2 Usage report.
- R1-F4: acknowledged — Resolved by removal: Change D explicitly drops the server-side concurrency cap, so no queue exists to hold a round beyond WAIT_MS with no recoverable record. The burst-push token budget is documented as an operating rule, not code.
