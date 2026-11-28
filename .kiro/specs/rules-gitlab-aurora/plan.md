# Plan: rules-gitlab-aurora

Change class: standard
Scope: vitana-platform (docs/delivery/, generator, CI wiring, CLAUDE.md, AGENTS.md, .kiro/steering/, scripts/collab/queue.mjs, scripts/collab/land-guard.mjs, scripts/collab/protected-approval.mjs, scripts/collab/protected-gate-files.json, services/gateway/src/services/project-manager/governance.ts (list entries only), their tests, .claude/rules/collaboration.md, .claude/skills/plan-sparring/SKILL.md, config/delivery/services.json, scripts/eng/pipeline-gen.mjs, and the rendered infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml); vitana-v1 (CLAUDE.md, AGENTS.md pointer).

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
- The Project Manager's hard refusal of protected gate files (governance.ts:191-198) stays. The Project Manager never unlocks a protected file. The predicate applies only where a merge is actuated through land-guard.mjs and queue.mjs scopeCheck.

## Protected-file authority (defined mechanically)
A change to a protected gate file (protected-gate-files.json) is accepted only when all three hold:
1. The lane's handoff.md front-matter (`.kiro/specs/<slug>/handoff.md`) has `sparring_verdict: converged` and a `plan_hash`, written by CI PLAN-SPAR when its session converges. It also has a `protected_files:` list, written by the planner, that names the changed file.
2. The plan hash equals the SHA-256 of the plan body between the plan-begin and plan-end markers at the merge head.
3. A reviewer accept (`Collab-Review: accept`) on the current head comes from a reviewer agent session whose seat differs from the author's seat. Seats are derived from the `Collab-Session` trailers through the existing seat mapping (`seatOf()`). No new trailers are introduced.

Data path, existing code and new code kept apart:
- Existing, changed: `mergeDecision({ review, checks, behindBy, protectedFiles })` in land-guard.mjs:108 and the `protectedTouched(files, PROTECTED_GATE_PATHS)` call in the merge command at :284.
- New: a `protectedApproval` object `{ converged: boolean, plannedFiles: string[], reviewerSeat: string, authorSeat: string }`, built in the merge command from handoff.md front-matter and the head's `Collab-Session` trailers; front-matter parsing; seat derivation through `seatOf()`; `validatePlan` (queue.mjs:196) extended to accept `sparring_verdict`, `plan_hash` and `protected_files`.
- The predicate is one pure function, `protectedApprovalOk(approval, changedFiles)`, implemented once in scripts/collab/protected-approval.mjs and imported by land-guard.mjs and queue.mjs.

## Phases

### Phase 1: single source and generator
- docs/delivery/ in vitana-platform: the rules.
- scripts/delivery/render.mjs renders CLAUDE.md (pointer only), AGENTS.md (scope: three projects), .kiro/steering/*.md. `render --check` exits non-zero on drift; wired as a GitLab job in the platform pipeline.

### Phase 2: rule files
- CLAUDE.md reduced to the pointer (output of Phase 1). Merges under decision 6 bootstrap.
- vitana-v1: confirm on GitLab main that no CLAUDE.md or .claude/CLAUDE.md exists; remove if present.

### Phase 3: protected-file machine path (merges under decision 6 bootstrap)
- scripts/collab/protected-approval.mjs: the predicate above, pure, with tests.
- The protected list exists in three copies. All three get the same two new entries (scripts/collab/protected-approval.mjs and scripts/collab/land-guard.mjs) in this change: scripts/collab/protected-gate-files.json; PROTECTED_GATE_BUILTIN in queue.mjs (lines 94-98, the single-file fallback used by CI and vitana-v1); PROTECTED_GATE_GLOBS in governance.ts (lines 48-61). A parity test asserts the three lists are identical.
- scripts/collab/queue.mjs validateLane (starts at line 213; protected-path check at line 240): a kiro lane may declare paths that reach a protected gate file only when its handoff.md has sparring_verdict converged and a protected_files list covering the glob. This is a design-time pre-check. It does not decide the merge.
- scripts/collab/queue.mjs scopeCheck (starts at line 946; protected-file check at line 1034): accepts a protected-file change when protectedApprovalOk is true, using the full predicate at merge time; otherwise refused as today.
- scripts/collab/land-guard.mjs mergeDecision (line 108) and the merge command (lines 268-287): accepts a protected change when protectedApprovalOk is true.
- services/gateway/src/services/project-manager/governance.ts: the hard refusal at lines 191-198 is NOT changed. The Project Manager keeps refusing every protected gate file, so it stays an independent layer. Only the PROTECTED_GATE_GLOBS list (lines 48-61) gains the two entries.
- .claude/rules/collaboration.md section 3a (lines 138-146): rewritten to the predicate.
- Tests: protected-approval.test.mjs proves (a) converged plan + different-seat accept + plan names file → accepted; (b) author = reviewer → refused; (c) plan not converged → refused; (d) file not named in protected_files → refused; (e) plan hash mismatch → refused. A land-guard test proves the merge command refuses a protected change without approval. A governance test proves the Project Manager still refuses a protected change even with a converged approval. A parity test proves the three lists match. A validateLane test proves the design-time pre-check.
- Acceptance proof: the Phase 3 merge itself is the bootstrap; the first protected change after Phase 3 (any) must merge under the predicate with no owner step, and its record is in docs/validation/.

### Phase 4: local-partner retirement
- .claude/rules/collaboration.md:193, .claude/skills/plan-sparring/SKILL.md:63 (and the vitana-v1 variant): remove "owner answers Gate 1" text; point to CI convergence.
- CLAUDE.md:38 removed by Phase 2.

### Phase 5: pipeline shadow-to-live flip
- The value is set in scripts/eng/pipeline-gen.mjs:146 (`DELIVERY_MODE: 'shadow'`). The flip adds a field `delivery_mode` per repository in config/delivery/services.json (not present today; initially "shadow"), and pipeline-gen.mjs:146 reads it instead of the literal. Rendered output changes accordingly; pipeline-gen --check stays the drift gate.
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
| GitLab delivery mode | shadow today (config/delivery/services.json has no delivery_mode field yet; Phase 5 adds it) | Zero-human claim applies after the Phase 5 flip |

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
- The predicate tests pass; the parity test passes across the three protected lists; the Project Manager refusal test passes.
- No local-partner Gate 1 text in the three files named in Phase 4.
- Phase 5 flip has its prerequisite evidence before the flip.
<!-- plan:end -->
