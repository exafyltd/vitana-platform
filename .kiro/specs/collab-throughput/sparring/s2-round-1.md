# Sparring round 1 — in_progress

Session: `1df87f89-7dc3-4dfa-bd1e-064c69be6c18` · plan hash `4c60a6476e9e75a671fb1f9568d90085f4892410b5583adfd573a6a0be017ae3`

## Summary

I reviewed the code at the pinned commit and verified the central premises. The queue slowness diagnosis holds (collect() loops per-branch git diff/git show). The sparring answer validation gap holds (submitPlannerRound enforces exactly-one-answer at ~L340–349; the gateway's round() only throws on 4xx). hasCodeAccess only checks token presence (github-tools L26–29, plan-sparring-service L77). I found several concrete defects, the most serious being the concurrency-cap (D): the round path (submitPlannerRound) writes no session row before the pass runs, so a request queued at the semaphore has no state change and PLAN-SPAR's 25-min waitFor poll will time out before the round is appended. Findings below.

## Findings

### R1-F2 [major]

plan-spar.mjs main() currently has NO try/catch and the top-level rejection handler only does console.error and sets exitCode (L311–315). The plan's change B says main() 'handles every failure the same way' and 'It never re-throws, so the comment file always exists when the job fails.' However, the plan scopes the new catch to step() errors and returned failure actions only; an arg-parsing Usage error (missing --dir etc., thrown at L298) still propagates to the top-level rejection handler which prints console.error and never writes the comment file. Since PLAN-SPAR.yml always passes all args this is not a live blocker, but the claim 'the comment file always exists when the job fails' is false for Usage errors, and the Comment step would fall back to the generic today-body, silently hiding a usage failure. The plan should either also catch Usage in main() to write the comment file (then exit 2), or explicitly state Usage errors skip the comment file.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:296` — async function main(argv) { const a = parseArgs(argv); if (!a.dir || !a['base-sha'] || !a.repo || !a.changed) throw new Usage('needs --dir --base-sha --repo --changed'); ... if (process.argv[1] ...) { main(...).then((c) => { process.exitCode = c; }, (e) => { console.error(`plan-spar: ${e.message}`); process.exitCode = e instanceof Usage ? 2 : 1; }); }

Suggestion: Extend the single failure path to also catch Usage errors thrown by arg validation so the comment file is written and the non-zero exit is preserved, or explicitly document that Usage errors (exit 2) intentionally skip the comment file.

### R1-F3 [major]

Change B's local answer check compares parsed responses against `live.rounds[n-1].review.findings[].id`. If the previous round has no `review` (e.g. a partner_error round produced by model_unavailable/code_access_unavailable, which write rounds with partner_error and NO review field — see createSparringSession L289–295 and submitPlannerRound L380–386), then `live.rounds[n-1].review` is undefined and the `.findings` access throws a TypeError. The gateway in this situation returns 409 'no_review_to_answer' (L338), but an in_progress session would not normally have a partner_error last round. Still, a defensively-correct local check must handle a missing review and report a friendly message rather than crash. The plan's new tests (unknown/duplicate/missing/malformed) do not cover a prior round without findings.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:337` — const previous = session.rounds[session.rounds.length - 1]; if (!previous || !previous.review) throw new SparringError(409, 'no_review_to_answer');
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:289` — if (!pass.ok) { await writeRound(deps, session, { round: 1, at: at(), plan_hash: plan.hash, plan_text: plan.canonical, tool_log: pass.toolLog, partner_error: `${pass.reason}: ${pass.error}`, repo_refs: refs }, { verdict: 'escalated', escalation_reasons: [pass.reason], model_log: pass.modelLog, final_plan_hash: plan.hash }); }

Suggestion: Guard the local check: if `live.rounds[n-1]?.review` is missing, return `responses_invalid` (or a distinct action) with a message naming 'no_review_to_answer' before indexing `.findings`, and add a test for a prior round without a review.

### R1-F4 [blocker]

Change D's in-process semaphore wraps runPartnerPass, and a waiting request is 'held open (no 429)'. In createSparringSession the session row is inserted (L255) before runPartnerPass, so a waiting CREATE shows in_progress and the gatewayClient.create recovery path (re-POST + waitFor) works. But submitPlannerRound (the round path) performs NO write until runPartnerPass returns — the round is appended only at L381 (failure) or L401 (success) AFTER the pass. A round request that is merely QUEUED at the semaphore for longer than WAIT_MS (25 min) will (a) have its POST aborted by AbortSignal.timeout(WAIT_MS) in gatewayClient.call, and (b) the subsequent waitFor poll will also time out because the round is still not appended, throwing 'session <id>: no round N after 25 min' while the pass continues running server-side. This results in a red check with no recorded round and the pass running abandoned, and it is not recomputable: the next push re-POSTs the same round and may 409 round_conflict after the orphaned pass finishes. The plan's risk note only covers the CREATE-side recovery ('For cases ... as it does for a slow pass today') and does not address the round path, which today never queues behind other requests because there is no semaphore.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:370` — const pass = await runPartnerPass({ round: n, prompt: nextRoundPrompt(...), callLlm: deps.callLlm, executeTool: deps.makeToolExecutor(refs), deadlineMs: PASS_DEADLINE_MS[session.change_class], now: deps.now }); const modelLog = [...(session.model_log ?? []), ...pass.modelLog]; if (!pass.ok) { await writeRound(...) } else { ... await writeRound(...) }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:89` — const call = async (method, p, body) => { try { const res = await fetchImpl(`${baseUrl}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(WAIT_MS) });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:101` — const waitFor = async (id, rounds) => { const until = now() + WAIT_MS; while (now() < until) { await sleep(POLL_MS); ... if (s && (s.rounds.length >= rounds || s.verdict !== 'in_progress')) return s; } throw new Error(`session ${id}: no round ${rounds} after ${WAIT_MS / 60000} min`); }

Suggestion: For the round path, either enqueue with a durable 'pending' state written to the store before the semaphore wait (so waitFor can observe the in-flight round and recover), or write a placeholder/'in_progress' round marker before waiting, or bound the queue wait below WAIT_MS and return a retryable 503 so plan-spar's lost() path re-posts. At minimum, document and test the round-path queue-wait-beyond-WAIT_MS behavior.

### R1-F5 [minor]

Change A's `git log --source --name-only --format=%x1e%S` with the known difference that '--source names the first ref that reached a commit' changes the ORDER in which refs are considered when a spec file is unchanged (`updated` equal across branches). collect() uses `consider()` with a strict `>` compare (L256) so the first-seen ref wins ties, and the winner feeds the `branch` column (buildQueue uses plan.ref / l.ref). The old code iterated refs from for-each-ref (committerdate order), the new code iterates git log output order (topological/commit order, first-reached ref). The plan's verification ('identical rows, or every difference explained') is a one-off manual comparison before merge, but the test fixture ('two competing lane versions') presumably uses different `updated` values and will not pin the tie-break. The branch column on tied `updated` is under-specified and could change nondeterministically if git log's ordering is not stable. Minor because `updated` is unlikely to tie in practice, but the regression-suite should pin tie ordering.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:251` — const consider = (ref, p) => { const text = showFile(repo, ref, p); if (text === null) return; const fm = parseFrontMatter(text); const prev = best.get(p); if (!prev || (fm?.updated || '') > (prev.fm?.updated || '')) best.set(p, { path: p, ref, fm, text, ...classifyPath(p) }); };

Suggestion: Add a deterministic tie-break in the new collect() (e.g. prefer main, then sort refs lexically) and extend the fixture to include two branches with an identical `updated` value to pin the branch column.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
