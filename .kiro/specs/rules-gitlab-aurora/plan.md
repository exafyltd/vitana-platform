# Plan: rules-gitlab-aurora

Change class: standard
Scope: vitana-platform (docs/delivery/, generator, CI wiring, CLAUDE.md, AGENTS.md, .kiro/steering/, scripts/collab/queue.mjs, scripts/collab/land-guard.mjs, services/gateway/src/services/project-manager/governance.ts, their tests, .claude/rules/collaboration.md, .claude/skills/plan-sparring/SKILL.md, config/delivery/services.json, scripts/eng/pipeline-gen.mjs, and the rendered infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml); vitana-v1 (CLAUDE.md, AGENTS.md pointer).

<!-- plan:begin -->
## Owner decisions (2026-11-14, recorded; not to be re-argued)
1. CLAUDE.md becomes a pointer file with no rules. The old rules are removed.
2. Generated rules cover three active GitLab projects: vitana/vitana-platform, vitana/vitana-v1, vitana/vitanaland-strategy. vitana/vitana-infra and vitana/vitana-mobile are on hold and untouched.
3. Zero human in the loop from task definition to STAGING-VERIFY. Every plan is approved by machine convergence. The only human step after a task starts is production PUBLISH (Gate 2).
4. Production database is Supabase today. The Aurora cutover is not part of this plan.
5. Google and Vertex are allowed only for the two voice features (Vertex Live voice bridge and Google TTS audiobook narration, sr and ru). No other Google service. No expiry date.
6. Protected files (CLAUDE.md and the governance rules) have no owner gate for any change made after this plan's Phase 3 is on main. The sparring round is the check.

## Planner decisions
- Claude Code is retired as a seat. Local sparring with a Claude partner is retired.
- The bootstrap authority for this plan's own protected-file changes is owner decision 6 itself: it names protected files and says there is no owner gate. Phases 2 and 3 merge under it. No further owner instruction is needed for those merges. This is the one-time bootstrap.

## Protected-file authority (defined mechanically)
A change to a protected gate file (protected-gate-files.json) is accepted only when all three hold:
1. The lane's plan front-matter (`.kiro/specs/<slug>/handoff.md`) has `sparring_verdict: converged`, a `plan_hash`, and a `protected_files:` list that names the changed file.
2. The plan hash equals the SHA-256 of the plan body between the plan-begin and plan-end markers at the merge head.
3. The reviewer accept trailer on the current head (`Collab-Review: accept`, `Collab-Reviewer-Seat`) names a seat different from the author's `Collab-Seat` trailer.

Data path: the merge command in land-guard.mjs (the `merge` command, lines 268-287) computes a `protectedApproval` object from the lane's trusted front-matter and the head's trailers, and passes it into `mergeDecision`. `queue.mjs` scopeCheck (line 1034) and `governance.ts` (lines 197-198) receive the same object from their callers. The object has: `{ converged: boolean, plannedFiles: string[], reviewerSeat: string, authorSeat: string }`. The predicate is one pure function, `protectedApprovalOk(approval, changedFiles)`, implemented once in scripts/collab/protected-approval.mjs and imported by queue.mjs and land-guard.mjs; governance.ts re-implements the same predicate in TypeScript with a shared fixture test so the two cannot drift.

## Phases

### Phase 1: single source and generator
- docs/delivery/ in vitana-platform: the rules.
- scripts/delivery/render.mjs renders CLAUDE.md (pointer only), AGENTS.md (scope: three projects), .kiro/steering/*.md. `render --check` exits non-zero on drift; wired as a GitLab job in the platform pipeline.

### Phase 2: rule files
- CLAUDE.md reduced to the pointer (output of Phase 1). Merges under decision 6 bootstrap.
- vitana-v1: confirm on GitLab main that no CLAUDE.md or .claude/CLAUDE.md exists; remove if present.

### Phase 3: protected-file machine path (merges under decision 6 bootstrap)
- scripts/collab/protected-approval.mjs: the predicate above, pure, with tests.
- scripts/collab/queue.mjs:240 and :1034: scopeCheck accepts a protected-file change when protectedApprovalOk is true; otherwise refused as today.
- scripts/collab/land-guard.mjs:109 (mergeDecision) and the merge command at :268-287: compute protectedApproval from the lane front-matter and head trailers; mergeDecision accepts a protected change when protectedApprovalOk is true.
- services/gateway/src/services/project-manager/governance.ts:48-61 (PROTECTED_GATE_GLOBS unchanged in content) and :197-198: the hard refusal becomes a call to the same predicate, implemented in TypeScript with a fixture file shared with protected-approval.mjs.
- .claude/rules/collaboration.md section 3a (lines 138-146): rewritten to the predicate.
- Tests: protected-approval.test.mjs and governance.test.ts each prove (a) converged plan + different-seat accept + plan names file → accepted; (b) author = reviewer → refused; (c) plan not converged → refused; (d) file not named in protected_files → refused; (e) plan hash mismatch → refused.
- Acceptance proof: the Phase 3 merge itself is the bootstrap; the first protected change after Phase 3 (any) must merge under the predicate with no owner step, and its record is in docs/validation/.

### Phase 4: local-partner retirement
- .claude/rules/collaboration.md:193, .claude/skills/plan-sparring/SKILL.md:63 (and the vitana-v1 variant): remove "owner answers Gate 1" text; point to CI convergence.
- CLAUDE.md:38 removed by Phase 2.

### Phase 5: pipeline shadow-to-live flip
- The value is set in scripts/eng/pipeline-gen.mjs:146 (`DELIVERY_MODE: 'shadow'`). The flip adds a field `delivery_mode` per repository in config/delivery/services.json (initially "shadow"), and pipeline-gen.mjs:146 reads it instead of the literal. Rendered output changes accordingly; pipeline-gen --check stays the drift gate.
- Prerequisites, each recorded in docs/validation/<VTID>/: (a) check jobs green on at least 10 consecutive merge requests; (b) one shadow deploy-staging run produced the same deploy plan the live job would run; (c) rollback exercised once on staging.
- The flip is a config change reviewed like any other; it is itself a protected-file change only if it touches a protected file (it does not, since services.json is not in the list; verify).

## Scope exclusions (separate plans, each with its own sparring)
- Supabase-to-Aurora cutover, including VTID-05023 gates (AWS-STAGE-DEPLOY-GATEWAY.yml, staging-gateway-deploy.gitlab-ci.yml:74-78, test vtid-05023-aurora-strip-all) and the Aurora cluster check.
- RLS replacement for auth.uid() (981 occurrences, 195 migration files).
- Deletion of dead files (publish-to-prod.sh, EXEC-DEPLOY.yml, dead workflows). This plan removes dead references only from generated rules.
- vitana/vitanaland-strategy documentation: MR !7 in that project.

## State table
| Component | State | Rule |
|---|---|---|
| Production database and auth | Supabase | Supabase rules apply until the cutover plan is proven |
| Aurora production cluster | Last recorded 2026-10-01: terminal; 2026-11-14 check not done | Not used by any rule in this plan |
| Staging database | Shares production Supabase | Rewritten by the cutover plan |
| GitLab delivery mode | shadow (config/delivery/services.json, delivery_mode) | Zero-human claim applies after the Phase 5 flip |

## Replacement map
- GitHub PR, merge, Actions, PR template -> GitLab MR, vitana/ci-config, merge bot.
- Gate 1 -> machine convergence, for all plans.
- Gate 2 and PUBLISH -> unchanged; the only human step after task start.
- Claude Code roles -> Kiro seats and the reviewer agent on a different seat.
- Protected-file owner instruction -> the predicate (Phase 3), after bootstrap.
- Kept unchanged: AWS account 472838866351, region eu-central-1, ECR, /alive, port 8080, deploy verification, tenant isolation.
- Dead references removed from the generated rules only.

## Acceptance
- docs/delivery/ exists; render produces the generated files; render --check fails on drift in CI.
- CLAUDE.md on GitLab main is the pointer only; vitana-v1 has no CLAUDE.md on GitLab main.
- The predicate tests pass in both implementations, with the shared fixture.
- No local-partner Gate 1 text in the three files named in Phase 4.
- Phase 5 flip has its prerequisite evidence before the flip.
<!-- plan:end -->
