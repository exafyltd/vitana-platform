# Sparring round 3 — escalated

Session: `6bae03ec-0d06-4ab2-b19e-c8dd872dae69` · plan hash `1efe8530fafc9ced1a697c68b974f3b48438edbef60a177f1c6bb458bcd0357a`

## Summary

Round 3. vitana-v1 remains inaccessible in this session (confirmed by `list_dir` returning "no pinned ref"). The planner's rejection of my R2 sub-claim about `main` being an invalid spar_refs value is correct — `resolveRef` at plan-spar.mjs:80-89 clearly supports branch resolution via the GitHub commits API; I was citing a superseded design note. The R1-F5 fix (correcting the N5a signature source to vitana-v1 main rather than the old branch) is properly addressed in the revised plan. The R2-F2 deferral to a fresh vitana-v1-pinned session is the only possible remediation given this session's blindness. However, the three load-bearing premises (IO-freedom of vitanaIndex.ts, the 4+4+16 ledger partition, the no-health-data parallel-build claim for health-plans-services) have now been unverified across three consecutive rounds and remain the sole barrier to convergence. The plan explicitly acknowledges this and positions the replan path as the fix. An escalation from this session is the correct outcome: it triggers the replan at plan-spar.mjs:307-309 (verdict=escalated, !infra, plan_text changed), which creates a new session with spar_refs applied at line 312-319, allowing the fresh session to finally verify the premises.

## Findings

### R3-F1 [blocker]

Three load-bearing premises remain unverified after three consecutive rounds and cannot be verified in this session. (1) IO-freedom of src/lib/vitanaIndex.ts (pillarKeys/pillarLabel/getVitanaIndexTier) drives Decision 2's core-extraction argument — if any runtime import transitively reaches a class-B file, core-closure.mjs --check fails at m.own !== 'A'. (2) The 4+4+16=24 ledger partition (health-hub 4, vitana-index-biology 4, health-plans-services 16) with 0 overlap and 0 orphan defines the lane structure — the sibling plan's equivalent partition required three corrections across sparring rounds. (3) The claim that health-plans-services 'reads no health data' and can run in parallel with health-hub is unverified against Plans.tsx (383 lines, 5 tabs) and WellnessServices.tsx (286 lines, 4 tabs) — if either reaches a class-B health-data hook, the parallel-build claim breaks. vitana-v1 is confirmed inaccessible in this session (list_dir returns 'no pinned ref'), and client.round (plan-spar.mjs:333) never forwards extra_refs — only client.create (lines 312-319) does. The plan cannot converge without these verified. Escalation triggers the replan path (line 307: cur.verdict === 'escalated' && !cur.infra && plan_text_sha !== sha(planText)), which creates a new session with spar_refs resolved and forwarded.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:330` — action = 'round';
      session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:306` — const replan = cur && cur.verdict === 'escalated' && !cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText);
    if (!cur || retryInfra || replan) {
      action = !cur ? 'create' : retryInfra ? 'retry' : 'replan';
      ...
      session = await client.create({
        plan_text: planText, producer: `ci-plan-spar.${slug}`, ...
        ...(extraRefs ? { extra_refs: extraRefs } : {}),
      });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:286` — const handoffForRefs = path.join(spec, 'handoff.md');
    const declared = existsSync(handoffForRefs) ? parseSparRefs(parseFrontMatter(readFileSync(handoffForRefs, 'utf8'))) : [];
    let extraRefs;
    for (const [r, ref] of declared) {
      if (!PLAN_SPARRING_REPOS.includes(r)) throw new Usage(`spar_refs: ${r} is not an allowed sparring repo`);
      if (r === repo) throw new Usage(`spar_refs: ${r} is the plan's own repo; it is pinned by --base-sha`);
      (extraRefs ??= {})[r] = await resolveRef(r, ref, { token, fetchImpl });
    }

Suggestion: Escalation is the correct outcome for this session. The replan path will create a fresh session with spar_refs applied (vitana-v1 pinned). In that session, verify: (1) read src/lib/vitanaIndex.ts in full, trace every runtime import transitively, confirm class A or record the class-B chain; (2) read apps/mobile/parity/ledger.json, enumerate all lane===health rows by id, confirm 4+4+16=24 with 0 overlap/0 orphan; (3) read src/pages/health/Plans.tsx and WellnessServices.tsx in full, trace every hook import, confirm neither reaches a health-data hook or else add depends_on:[health-hub] to health-plans-services and remove the parallel claim. Record all three results line-level in the Measured state block.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The planner's rejection of my sub-claim is correct. The shipped code at plan-spar.mjs:80-89 clearly implements branch/tag resolution via the GitHub commits API for non-SHA refs, making 'main' a valid spar_refs value. My R2 citation of plan-spar-vitana-v1-ref/plan.md:89-96 was to a design note that described an earlier constraint (CI tokens scoped only to vitana-platform), which was superseded by the implementation. The operative half (vitana-v1 not pinned in this session because spar_refs is only applied at client.create) was accepted and remains the root cause.
- R2-F2: acknowledged — The deferral to a fresh vitana-v1-pinned session is the only possible remediation given that client.round cannot add extra_refs to an existing session. The rationale is sound. Re-raised as R3-F1 because the premises remain the sole convergence blocker: the plan explicitly positions escalation from this session as the trigger for the replan path that creates a new session with spar_refs applied.
