# Go / no-go before the first VTID insert (preview-gateway-recovery)
Status as of 2026-11-18. A NO on any line in part A means no insert. Part B lists what can only be verified after allocation.

## A. Prerequisites that must be true before the first insert
Each line is evidence, not intent.

Done (verified, evidence on this branch):
- [x] Aurora staging restore applied 13:56 UTC, pinned commit 9fa0d390 (artifacts/apply-2026-11-18T1356Z.txt)
- [x] PostgREST proxy on revision 24, bound to postgrest-jwt-secret-WiEKX3; staging key 200, production key 401 (artifacts/proxy-rev24-2026-11-18.txt)
- [x] Preview IAM roles: task (Bedrock only) and execution (six secrets only)
- [x] Staging-only secrets postgrest-service-role-key and preview-sparring-token exist (values never printed)
- [x] Operator: arn:aws:iam::472838866351:user/j.tadic@vitanaland.com, not root (verified this session)
- [x] #5110 (claude/gateway-preview-safe-mode) merged with current main d8b8a8c5e0 (commit 11eaf909af, fast-forward, no force)
- [x] Gateway Jest shards 1–4 green on the merged head (run before any VTID)
- [x] PLAN-SPAR change rebased on main (commit cf021a2443); its two test files pass 9/9 locally
- [x] Staging suite for runtime-profile prepared: artifacts/staging-tests-runtime-profile.pending.json (VTID-PENDING, 3 tests)
- [x] Transfer bucket vitana-recovery-transfer-472838866351 kept until recovery acceptance

Not yet true (must become true before insert):
- [ ] Rule 55 confirmed in writing by the rule owner: one complete preview recovery sparring run with allocation disabled covers both VTIDs. Not given by me; not given in any document I can read.
- [ ] The ledger owner's documented allocation procedure for runtime-profile and plan-spar-token. The repo documents only the mechanism: a direct insert into vtid_ledger as vitana_governance_owner carrying metadata.sparring_exempt_reason (docs/validation/VTID-04868/plan-B-sparring.md:143). No executable procedure exists in the repo. The ledger is the canonical database, so the insert is the owner's to run.
- [x] Reviewer availability confirmed in a session where it can run. 2026-11-18: shell denied. 2026-11-19T11:15Z (KIRO 12, kiro-jtadic-202611191115-a88f): vitana-lane-reviewer on claude-opus-5.5 ran its allowed read-only git commands with no refusal (artifacts/observed-2026-11-19T1120Z.md §5).
- [ ] Owner's decision on the staging deploy consequence of merging #5110 (see Part C, item 1).
- [ ] Owner's decision on the overnight preview deployment (Part C, item 3). Until it is decided, steps 8 and 10 of plan.md §7 cannot be run as written, because the service they create already exists in another shape.
- [ ] Written go for the inserts, with the time they are made.

## B. Checks that depend on allocation (cannot pass before the insert)
- [ ] validate-pr on #5110: needs the VTID in the PR title (CI check failing now, exit 10)
- [ ] change-suite on #5110: needs docs/validation/<VTID>/staging-tests.json and the VTID in the title (CI failing now: "PR changes gateway deploy paths but its title names no VTID")
- [ ] PR-GATE on the PLAN-SPAR lane branch: needs a VTID-titled PR. The push guard refuses to publish the lane without one, so the branch exists only as the artifact on this plan branch (artifacts/plan-spar-token.patch).
- [ ] Binding reviewer-agent accept on each final head: needs the PR, the VTID and a reviewer that can run.
- [ ] Owner's instruction naming the plan for the protected PLAN-SPAR change: given in writing 2026-11-18.
- [ ] Post-merge: deploy smoke and STAGING-VERIFY on the merge commit.
- [ ] Covering recovery sparring verdict, after plan-spar-token is on main.

## C. Decisions for the owner before the first merge
1. **Deploy consequence of merging #5110.** Its services/gateway paths trigger AWS-STAGE-DEPLOY-GATEWAY on push to main. That workflow updates vitana-gateway, which has 0 tasks since 2026-11-17, and its smoke step curls preview-aws-gateway for env=staging and the commit (AWS-STAGE-DEPLOY-GATEWAY.yml smoke step). With 0 tasks the smoke cannot pass, so STAGING-VERIFY cannot pass on that merge. My reading of the workflow; to confirm by running the deploy. Options: accept a red staging deploy for this merge under a written decision, or delay the merge until the owner decides to bring vitana-gateway back.
2. **Order of the PLAN-SPAR token secret.** Proxy revision 24 is already live, so the proxy prerequisite is met. Add PLAN_SPAR_GATEWAY_TOKEN only after the preview is deployed; otherwise every PLAN-SPAR run fails on the preview.

3. **The preview gateway deployed 2026-11-18 22:23Z by d.stevanovic@vitanaland.com** (artifacts/observed-2026-11-19T1120Z.md). It differs from plan step 8 in four ways: image `b48f95b2df52` (main of 2026-11-13, no `GATEWAY_API_ONLY` code, so the full gateway with its background jobs runs); the shared `vitana-ecs-task-role` / `vitana-ecs-task-execution-role` instead of the two preview roles; no `GATEWAY_SERVICE_TOKEN`, so the preview sparring token is not wired; and listener rule 9 (`/api/v1/*` on the preview host) instead of the sparring-only paths, which also moves the staging frontend's API calls onto this task. Its data bindings are staging-only (PostgREST proxy, staging JWT and service-role secrets) and allocation is off. Options: (a) keep it as an interim and replace it at step 8 with the plan's task definition, roles and narrow rule; (b) have the operator who made it scale it to 0 and delete rule 9 now, then follow the plan as written. Recommendation: (b) for rule 9 and the shared roles (they widen what the preview can reach beyond the approved plan); the task itself can stay at 1 if the owner prefers (a) for the rest. Either way it is the operator's or owner's live change, not Kiro's.

## D. Insert plan (after A is complete)
1. Insert runtime-profile (ledger owner, metadata.sparring_exempt_reason set). Record time T0.
2. Insert plan-spar-token the same way. Record T0 for both.
3. The 24-hour follow-up clock runs from T0 to the covering verdict.
