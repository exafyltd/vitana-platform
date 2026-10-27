# Sparring round 3 — escalated

Session: `f9549fe4-3a26-439f-b09e-c9c017660e49` · plan hash `8a7c445a04469431f396309b3cfcfcd8ec1af9658cef1f8bf586c6e85e66cc58`

## Summary

Round 3: vitana-v1 remains inaccessible (`read_file` returned "no pinned ref" again). The plan's load-bearing premises — CallProvider/CallManager mount location in Messages.tsx, class-B hook classifications, 9 parity-ledger rows, App.tsx routes, parity-ledger.mjs shapeOf logic — are unverified for the third consecutive round. The planner correctly identified the replan path as the resolution mechanism: my escalation (blocker) sets `verdict: escalated` on session 1, and the next CI run's replan branch (`plan-spar.mjs:307`) creates session 2 with `extra_refs` from handoff.md's `spar_refs`. The mechanics verify: `MAX_SESSIONS = 2` (line 36), `client.create` spreads `extraRefs` (lines 312–319), and the PR-branch handoff.md will be read (line 286). The plan text is well-structured and the revision adequately documents the cross-repo sparring gap. One blocker finding maintained to trigger the replan; both deferrals from Round 2 acknowledged as sound.

## Findings

### R3-F1 [blocker]

The load-bearing vitana-v1 premises remain unverified for the third consecutive round. read_file('exafyltd/vitana-v1', 'src/pages/Messages.tsx') returned 'no pinned ref for exafyltd/vitana-v1 in this session' again in Round 3. The 5 core premises — (1) CallProvider/CallManager mounted inside Messages.tsx at lines 52–53 and 1227–1569, (2) every chat/call hook runtime-imports @/integrations/supabase/client.ts (class B), (3) the 9 parity-ledger rows partitioned 3+6, (4) parity-ledger.mjs:60 shapeOf matching logic, (5) App.tsx:1352–1410 route lines — remain unverifiable in this session. The plan cannot converge without at least one session verifying them. The replan path is the correct resolution: this escalation sets verdict='escalated' on session 1; the next CI run fires the replan branch (plan-spar.mjs:307, conditions: escalated && !infra && sessions.length(1) < MAX_SESSIONS(2) && plan_text_sha changed) which calls client.create with extraRefs from handoff.md spar_refs, giving session 2 vitana-v1 access.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:36` — export const MAX_SESSIONS = 2;
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:307` — const replan = cur && cur.verdict === 'escalated' && !cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText);
    if (!cur || retryInfra || replan) {
      action = !cur ? 'create' : retryInfra ? 'retry' : 'replan';
      ...
      session = await client.create({
        plan_text: planText, producer: `ci-plan-spar.${slug}`, ...
        ...(extraRefs ? { extra_refs: extraRefs } : {}),
      });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:333` — session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText });

Suggestion: No plan change needed — the plan and its spar_refs declaration are correctly set up. This blocker triggers the escalation that enables the replan path. Session 2 must verify premises (1)–(5) against vitana-v1 source before the plan can converge.

## Acknowledgements of earlier responses

- R1-F3: acknowledged — Deferral to the fresh vitana-v1-pinned sparring session is sound. The replan mechanics verify: MAX_SESSIONS=2 (plan-spar.mjs:36), the replan branch fires on escalation with changed plan text (line 307), client.create spreads extraRefs (lines 312–319), and handoff.md spar_refs is read from the PR head checkout (line 286). Session 2 will have vitana-v1 access and can verify all five premise groups. The lane-reviewer re-verification requirement per VTID-05253 is a reasonable backstop.
- R2-F1: acknowledged — Deferral of the pipeline fix (forwarding extra_refs in client.round) to the owner/operator is correct. This is a vitana-platform infrastructure change outside the scope of a native screen-port plan PR. The replan path (fresh client.create) is the correct in-scope workaround for this plan.
