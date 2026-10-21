# Sparring round 2 — in_progress

Session: `b9c548f7-6f0e-4151-81f1-48a0b8a42d85` · plan hash `9750d3fe5d0667fc7f22b8c0d9e807ab42504e847664e8a1f5ec84fecfef3d88`

## Summary

All four R1 findings were accepted and the planner's stated resolutions are directionally correct. The gateway-side premises all hold (SHA_RE = /^[0-9a-f]{40}$/ confirmed at plan-sparring-service.ts:41; extra_refs validation at :108-116; refs merge at :266; round reuse of repo_refs at :358; PLAN_SPARRING_REPOS at github-tools.ts:21; parseFrontMatter block-list parsing at queue.mjs:103-121). One new major finding: the plan's R1-F1 prose says the merge lives in main(), while the Scope section and the R1-F3 prose say it lives inside step()'s create branch — those are mutually exclusive placements, and following the R1-F1 text literally re-introduces the R1-F3 bug. One new minor finding: the plan does not state what step() should do when handoff.md does not exist at create time.

## Findings

### R2-F1 [major]

The plan contains mutually contradictory statements about where the CLI-arg / spar_refs merge (and the associated resolveRef / fail-loud contract) must live. The R1-F1 resolution text says 'main() first builds the CLI-arg map… then overlays the parsed spar_refs on top of it', which places the merge (and any fail-loud throw) in main() before step() is called. But the Scope section says 'step() reads handoff.md and parses its front matter for spar_refs', and the R1-F3 resolution says 'the merge (CLI arg overlaid by spar_refs), the resolveRef call and the fail-loud contract all live inside the if (!cur || retryInfra || replan) branch'. These are mutually exclusive: if the merge and fail-loud live in main(), they fire for every invocation of main() regardless of whether step() will create a new session or process a round on an existing in-progress one — re-introducing exactly the R1-F3 bug that was supposed to be fixed (resolveRef failing loudly during a round and blocking the planner from answering findings). The current main() passes extraRefs into step() (plan-spar.mjs:317-319); step() spreads extraRefs only inside the create path (plan-spar.mjs:190-202). An implementer reading the R1-F1 prose literally would move the handoff.md read and the overlay into main(), breaking the R1-F3 invariant.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:317` — const v1Sha = (a['extra-ref-vitana-v1'] || '').trim();
const extraRefs = /^[0-9a-f]{40}$/.test(v1Sha) ? { 'exafyltd/vitana-v1': v1Sha } : null;
const r = await step({ dir: a.dir, slug, baseSha: a['base-sha'], repo: a.repo, client, allocate: process.env.PLAN_SPAR_ALLOCATE === 'true', extraRefs });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:190` — if (!cur || retryInfra || replan) {
  action = !cur ? 'create' : retryInfra ? 'retry' : 'replan';
  ...
  session = await client.create({
    ...
    ...(extraRefs && Object.keys(extraRefs).length ? { extra_refs: extraRefs } : {}),
  });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:204` — } else if (cur.verdict === 'in_progress') {
  ...
  session = await client.round(cur.id, n + 1, { responses: ..., revised_plan_text: planText });

Suggestion: Remove the sentence 'main() first builds the CLI-arg map… then overlays the parsed spar_refs on top of it' from the R1-F1 resolution body, or replace it with a statement that makes clear this describes the logical precedence rule only. State unambiguously that the physical location of the handoff.md read, the parseSparRefs call, the `{ ...(extraRefs || {}), ...sparRefs }` merge, the resolveRef call, and the fail-loud throw are all inside step()'s `if (!cur || retryInfra || replan)` branch — not in main(). main() continues to pass the CLI-arg map (or null) as extraRefs to step() unchanged, exactly as today.

### R2-F2 [minor]

The plan says step() reads handoff.md inside the create branch for spar_refs but does not state what should happen when handoff.md does not exist. For a brand-new plan PR, handoff.md may not be present at all. Without an explicit existsSync guard (mirroring the guards already used at plan-spar.mjs:258 and :274 for the write-back paths), an implementation that calls readFileSync unconditionally would throw ENOENT and fail the create step loudly with a file-not-found error rather than treating missing handoff.md as 'no spar_refs declared'.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:258` — if (existsSync(handoffPath)) {
  const ht = readFileSync(handoffPath, 'utf8');
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:274` — if (existsSync(handoffPath) && (infra || last)) {
  const ht = readFileSync(handoffPath, 'utf8');

Suggestion: Add one explicit sentence to the Scope section: 'If handoff.md does not exist when step() enters the create branch, parseSparRefs returns {} (no companion refs declared) and no error is thrown; the existsSync guard matches the pattern used in the converged/escalated write-back paths.' This removes ambiguity for the implementer and prevents a spurious ENOENT from masquerading as a fail-loud spar_refs validation error.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The plan now pins explicit precedence (spar_refs overlays the CLI arg map) and correctly restates the no-op guarantee against step()'s default extraRefs=null rather than production CI. Both the code-level merge rule and the no-op precision are addressed. R2-F1 is raised as a separate finding because the prose description of where the merge lives is internally inconsistent, but the stated intent of R1-F1 is satisfied.
- R1-F2: acknowledged — The plan now restricts resolveRef to verbatim 40-hex SHAs for any repo other than the plan's own --repo, makes a non-SHA companion ref a loud declaration error, and correctly defers branch/tag resolution to a follow-up lane that provisions a CI-accessible contents:read credential. Consistent with the gateway's SHA_RE = /^[0-9a-f]{40}$/ (plan-sparring-service.ts:41).
- R1-F3: acknowledged — The plan now states that the merge, resolveRef call, and fail-loud contract live inside the create/retry/replan branch, not before it. The round/waiting_for_planner/nothing_to_do paths are unaffected. The R2-F1 finding is about the contradictory prose in the R1-F1 section, not a regression on R1-F3's stated intent.
- R1-F4: acknowledged — The plan now explicitly adds handoff.md reading to step()'s scope, requires a spar_refs declaration to accompany a plan.md or responses change, and records the detectSlug/paths extension as a documented follow-up. The trigger requirement limitation is clearly stated.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
