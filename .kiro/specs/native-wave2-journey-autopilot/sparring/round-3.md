# Sparring round 3 — escalated

Session: `89b36d49-f10d-4101-a12c-a5011b92ac29` · plan hash `6a529f2f0918ab19af3d57b93989f7546cde152e1315d883af99ad09f78e21fb`

## Summary

Round 3: vitana-v1 remains inaccessible (`no pinned ref for exafyltd/vitana-v1 in this session` on all three read attempts). This is structurally inevitable — as verified in R2-F1, `spar_refs` is only applied at `client.create` (plan-spar.mjs:312-320), and this in-progress session takes the `client.round` path (plan-spar.mjs:322-333) which carries no `extra_refs`. The planner accepted both R2-F1 and R2-F2 and the revised plan adds "Cross-repo sparring" and "Sparring status" sections that change the plan text, satisfying the `plan_text_sha` condition for the `replan` branch (line 307). The recovery mechanism is verified: `MAX_SESSIONS = 2` (line 36), this is session 1, the replan condition at line 307 checks `!cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText)`, and even if the escalation is classified as infra/retryable (`code_access_unavailable` at line 43-44), the `retryInfra` path at line 306-311 also creates a fresh session with `extraRefs` applied. Either recovery path is sound. This session must escalate so session #2 picks up the `spar_refs: - exafyltd/vitana-v1: main` from handoff.md at `client.create` time, allowing the partner to independently verify the load-bearing premises (IO-free classification of horizonBuckets.ts and vitana-projection.ts, manifest.json autopilot type re-export, parity-ledger row counts, App.tsx routes, exclusions.json entries).

## Findings

### R3-F1 [blocker]

vitana-v1 is still inaccessible in this Round 3 session. All three read_file attempts for vitana-v1 files returned 'no pinned ref for exafyltd/vitana-v1 in this session'. This is the same structural limitation documented in R2-F1: spar_refs is applied only at client.create (plan-spar.mjs:312-320, inside the `!cur || retryInfra || replan` branch at line 308), and this in-progress session always takes the client.round path (line 322-333) which forwards no extra_refs. Every load-bearing premise — the IO-free (class A) classification of src/lib/horizonBuckets.ts and src/lib/vitana-projection.ts (no @/integrations/supabase/client, no @/lib/community-gateway import), the packages/core/manifest.json:59 autopilot type re-export, the 2-row / 435-row parity-ledger count, the App.tsx:1538-1548 routes, the exclusions.json:211 audiobook entry, and parity-scope.json line references — remains independently unverifiable. The planner's recovery mechanism (plan text change → replan branch fires on next step() after escalation) is verified as sound against the code, but this session cannot converge without independent verification of those premises. Session must escalate.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:308` — if (!cur || retryInfra || replan) {
      action = !cur ? 'create' : retryInfra ? 'retry' : 'replan';
      if (retryInfra) state.sessions.pop();
      session = await client.create({
        plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
        ...(extraRefs ? { extra_refs: extraRefs } : {}),
      });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:322` — } else if (cur.verdict === 'in_progress') {
      const n = cur.rounds;
      ...
      action = 'round';
      session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:36` — export const MAX_SESSIONS = 2;
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:306` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;
    const replan = cur && cur.verdict === 'escalated' && !cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText);

Suggestion: This session must escalate so the next step() invocation hits the replan (or retryInfra) branch and creates session #2 with spar_refs applied. The fresh session's partner must then independently verify all load-bearing premises by reading the vitana-v1 files before convergence can be granted. No convergence or policy approval from this session.

## Acknowledgements of earlier responses

- R2-F2: acknowledged — Deferral to the fresh vitana-v1-pinned sparring session is sound. The verification genuinely cannot happen in this session (vitana-v1 is inaccessible, confirmed by tool errors in rounds 1-3). The recovery mechanism — replan or retryInfra branch creating session #2 with spar_refs applied — is verified against the code (plan-spar.mjs:306-320, MAX_SESSIONS=2). The premises (IO-free classification of horizonBuckets.ts/vitana-projection.ts, manifest.json type re-export, parity-ledger rows) MUST be verified by the partner in session #2 before convergence.
