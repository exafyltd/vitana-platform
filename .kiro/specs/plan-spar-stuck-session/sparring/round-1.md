# Sparring round 1 — in_progress

Session: `bbd53a84-4c5e-4b1d-ae52-7c65d44aa5ae` · plan hash `e7a3095b86bb9c935dcbe5702e9cc2fa035dc46a3765d42ee267879e4027f019`

## Summary

The plan is well-researched and correctly diagnoses the stuck-session incident: round 1 runs synchronously inside the create request (plan-sparring-service.ts:314-338), the Bedrock handler has no request timeout (bedrock.ts:218-229, a bare NodeHttpHandler), and the pass deadline is only checked between turns (partner.ts:174) while `await invoke(...)` (partner.ts:180) is unbounded. Most premises I checked hold precisely (POLL_MS/WAIT_MS, waitFor throw, dedup+isDeadRoundOne, guarded escalateDeadRoundOne, RETRYABLE_REASONS containing deadline_exceeded, protected-gate-files globs). The three changes are coherent and change #1 (bound invoke) is in fact sufficient on its own to convert the hang into a clean 15-min deadline_exceeded escalation on the existing infra-retry path. My main finding is that the §5 justification "every call is bounded by the 15-min deadline" is false: only `invoke` is bounded, while `await input.executeTool(...)` (partner.ts:272) — the code-access/GitHub fetch — remains unbounded, so a live pass hung on a slow tool call can still exceed 20 min and be incorrectly escalated mid-flight, dropping its late write via round_conflict. Two minor findings: the Promise.race leaves a hung Bedrock request running (no cancellation), and the plan touches protected gate files without an explicit legacy-claude review routing step.

## Findings

### R1-F1 [major]

The §5 risk justification 'with every call bounded by the 15-min deadline a live pass cannot run that long' is false. Change #1 bounds only the LLM `invoke` (partner.ts:150-171 raced against the deadline), but the tool-call execution `await input.executeTool(...)` (partner.ts:272) — the code-access/GitHub file reads — is completely unbounded and is not part of the race. The deadline is only re-checked at the top of the next turn (partner.ts:174). A pass hung on a slow or stuck GitHub API call (network partition, proxy hang, rate-limit retry without timeout) can therefore run well past 15 min and past the new 20-min STALE_AFTER_MS. Because a round-1 pass writes nothing until it completes (isDeadRoundOne uses updated_at==created_at during the pass), a live-but-slow pass becomes 'dead' at 20 min and a concurrent/re-run create will escalate it via isDeadRoundOne → escalateDeadRoundOne, then its late writeRound is refused (appendRound → round_conflict, session no longer in_progress), silently discarding a would-be-valid review and forcing an extra full pass. This does not lose data (nothing was written) but it wastes a pass and can falsely consume the second (re-plan) session slot if the first pass would have converged.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:173` — for (let turn = 1; turn <= PARTNER_MAX_TURNS_PER_ROUND; turn++) {
      if (now() - startedAt > input.deadlineMs) return fail('deadline_exceeded', ...);
      let r: LLMRouterResult;
      for (;;) {
        const tier = tiers[tierIndex];
        const t0 = now();
        r = await invoke(prompt, tier);
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:272` — const exec = await input.executeTool(call.name, call.arguments ?? {});
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:58` — export function isDeadRoundOne(s, nowMs) { ... const ts = s.updated_at ?? s.created_at; ... return t < nowMs - STALE_AFTER_MS; }

Suggestion: Either bound the tool execution too (race executeTool against the remaining pass deadline, or add a timeout to the code-access fetch), or acknowledge in the plan that tool calls are unbounded and justify that a >20-min tool hang is acceptable/unrecoverable in practice. If the tool calls are left unbounded, the STALE_AFTER_MS value should be chosen relative to a realistic worst-case tool-call duration, not justified solely by the LLM deadline.

### R1-F2 [minor]

Racing `invoke(...)` against the deadline with Promise.race (or an equivalent) discards the promise result but does not cancel the underlying Bedrock request. The hung `client.send(command)` in invokeBedrock (bedrock.ts:229) continues running in the background after the pass is already marked deadline_exceeded and the session escalated — consuming a connection and (if it ever completes) model tokens, with no AbortSignal passed down. On a serverless gateway this orphaned request lives until the instance's own timeout. Not a correctness bug for the session, but a resource/leak concern readily avoidable.

- `exafyltd/vitana-platform:services/gateway/src/providers/bedrock.ts:218` — const client = new BedrockRuntimeClient({
        region: bedrockRegion(),
        requestHandler: new NodeHttpHandler(),
      });
      ...
      const resp = await client.send(command);

Suggestion: Thread an AbortSignal (e.g. from AbortSignal.timeout(remainingDeadline)) into the invoke call path so the underlying Bedrock request is actually aborted when the pass deadline fires, rather than merely racing the promise.

### R1-F3 [minor]

The plan modifies protected gate files — `scripts/collab/plan-spar.mjs` and `services/gateway/src/services/plan-sparring/**` (protected-gate-files.json:6,9) — but the Change/§5 sections only name 'STAGING-VERIFY and Gate 2 per the pipeline' and a vague routing note in the goal. protected-gate-files.json's own description states a protected file change 'never merges on a reviewer-agent accept alone; it needs a legacy claude review on the current head or the owner's instruction.' There is no explicit, actionable step in the plan committing to that legacy-claude review routing for these files, distinct from the ordinary pipeline gates.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:3` — A change to one never merges on a reviewer-agent accept alone; it needs a legacy claude review on the current head or the owner's instruction.

Suggestion: Add an explicit sequencing step stating that, because plan-spar.mjs and the plan-sparring service both sit in protected-gate-files.json, the lane will route the merge through the required legacy-claude review (or owner instruction) before any merge, in addition to STAGING-VERIFY/Gate 2.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
