# Sparring round 1 — in_progress

Session: `591783a3-f420-43e1-aae2-c6cc444d1664` · plan hash `4016cdd3f74d625ae1f2ddfb9ef072b29819278a491e57bc2cca25dfdfd3836f`

## Summary

The plan is a rule-text-only change (governance class) granting Kiro "primary executor" authority via a new §7d plus the steering/automation texts pointing at it. Most factual premises about today's system hold (verified: §7a/§7b forbid merge except per-PR owner instruction; steering/automations hand routine lanes to next_actor: claude; reviewer B leaves verified/merge to Claude Code; queue.mjs restricts governance paths to executor: claude and does not yet honour governance: true; RUN-MIGRATION.yml is workflow_dispatch with MIGRATION_FREEZE and defaults to supabase; automations live in vitana-platform). Several real gaps remain that must be fixed before implementation.

## Findings

### R1-F1 [blocker]

The plan grants unattended standing merges (B.4, 'interactive or automation') for non-governance lanes, replacing §7b's explicit per-PR owner instruction. The authority trigger (A) is 'the owner's instruction to start a workstream, or a plan's policy approval converged-auto-v1, or a Gate 1 yes' — but this plan's approval is converged-auto-v1, an LLM policy, NOT an owner 'yes'. Removing the human per-PR merge gate is a material access change (§D.6), yet the owner is never asked to authorise it; converged-auto-v1 is not owner approval. This contradicts the plan's own §C statement that 'Changing Kiro's own guard rails is a material access change (§D)'.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:174` — the owner has **explicitly instructed this specific merge in the conversation** (a standing "merge my lanes" does not count — it is per PR, or per a named set the owner lists)
- `exafyltd/vitana-platform:CLAUDE.md:66` — A plan sparred by `PLAN-SPAR.yml` whose session converged is approved by the policy `converged-auto-v1` ... it is not sent to the owner.

Suggestion: Require the owner's explicit instruction to enable the standing merge authority itself (a distinct owner 'yes' to §7d B.4, not policy approval), or keep §7b's per-PR/per-set owner merge instruction until the Project Manager runs live. Otherwise treat removal of the per-PR merge gate as a §D.6 stop requiring the owner's explicit yes before B.4 becomes effective.

### R1-F2 [major]

B.4's merge conditions say only 'the merge deploys to staging only' with no mechanical guard naming which workflows/labels must be green and none prohibiting a merge that triggers an AWS-PROD-* job. §7b guards this by naming AWS-STAGE-DEPLOY-GATEWAY.yml and other AWS-STAGE-*/preview workflows and forbidding PUBLISH/AWS-PROD-DEPLOY-*. Since automations now merge unattended and all seats share one GitHub identity, an automation cannot reliably verify the merge is staging-only, creating a production-deploy risk from an unattended run.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:177` — the PR targets `main` and its deploy path is **staging only** (`AWS-STAGE-DEPLOY-GATEWAY.yml` and the other `AWS-STAGE-*` / preview workflows). Production (PUBLISH, `publish-to-prod.sh`, any `AWS-PROD-DEPLOY-*`) is **still forbidden to Kiro**

Suggestion: Spell out the concrete staging-only guard in B.4: name the allowed stage workflow globs, require verification that the merged branch is main and no AWS-PROD-*/PUBLISH workflow is among the triggered deploy paths, and require recording which workflows the merge will trigger. Do not leave 'staging only' as an unverifiable assertion for unattended automations.

### R1-F3 [major]

B.6 allows Kiro to dispatch RUN-MIGRATION.yml for an owner-approved migration, but MIGRATION_TARGET default resolves to 'supabase' — which the plan's own Today §3 calls a shared production database. B.6 does not require the session to verify the resolved target or treat a Supabase/Aurora apply as a production write covered by §D.1/§D.2. This lets an interactive session perform a production database write under a 'staging' framing, exactly the production-write risk the plan elsewhere insists stays behind owner approval.

- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:9` — which database. 'default' follows the repo variable MIGRATION_TARGET (unset = supabase, today's path unchanged)
- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:59` — default|'') TARGET="${TARGET_VAR:-supabase}" ;;

Suggestion: Add an explicit target check to B.6: the session must not dispatch when the resolved target is a production database unless that production write is covered by the owner's production approval; require the recorded migration-approval to name the target; clarify whether a Supabase/Aurora apply is a 'new production database migration' requiring §D.2.

### R1-F4 [major]

Both this plan and retire-claude-code's rules-platform/rules-v1 lanes edit the same files (collaboration.md, CLAUDE.md roles paragraph, vitana-load-project-rules.md, vitana-kiro-notes.md, vitana-standing-rules.md, vitana-collaboration.md, automations/*.md). The plan asserts lane ordering ('depends_on is per spec') prevents concurrent edits, but a lane-level depends_on does not guarantee byte-level non-overlap, and both rewrite §7/§7a/§7b. A merge that drops retire-claude-code's §7c (production boundary) is a real, unguarded risk.

- `exafyltd/vitana-platform:.kiro/specs/retire-claude-code/lanes/rules-platform.md:11` — paths: - .claude/rules/collaboration.md - CLAUDE.md - .kiro/steering/vitana-load-project-rules.md - .kiro/steering/vitana-kiro-notes.md ... - .kiro/automations/exafy.md ... - .kiro/steering/vitana-standing-rules.md - .kiro/steering/vitana-collaboration.md

Suggestion: State the exact byte-level relationship between §7d and §7c (e.g. §7d appended after §7c, §7/§7a/§7b inherited unchanged), and add a test asserting the merged collaboration.md still contains both §7c and §7d. Confirm rules-platform/rules-v1 are merged AND green before this plan's lanes build.

### R1-F5 [major]

B.2 grants the executing Kiro session authority to self-allocate a VTID via POST /api/v1/vtid/allocate when a lane lacks one. Today §7a forbids the executor from allocating VTIDs ('CI and the coordinator do'), and CI (PLAN-SPAR) allocates on convergence. Moving allocation into the executing session's hands undermines the mechanical, non-self-interested allocation path even if the vtid_ledger trigger still checks for a converged record.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:159` — They never: - allocate a VTID (CI and the coordinator do), take a `_plan` claim of a plan they did not author, or edit another lane's file

Suggestion: Keep VTID allocation with the coordinator (_plan claim holder) or CI; have the session treat a missing VTID as a plan-coordination defect fixed via coordinator action / a new sparring round, not a new self-allocation authority for the executor.

### R1-F6 [minor]

The Tests grep ('no remaining text tells Kiro to hand a routine step to Claude Code') will fail as stated: §A itself keeps next_actor: claude for 'legacy executor: claude lanes until retire-claude-code retires them', and the automation files still reference Claude Code ('The Project Manager (or, until it runs, Claude Code) merges...', 'next_actor: claude') until rules-platform merges. The acceptance is self-contradicting unless scoped precisely.

- `exafyltd/vitana-platform:.kiro/automations/jtadic.md:74` — next_actor: claude ... The Project Manager (or, until it runs, Claude Code) merges verified lanes
- `exafyltd/vitana-platform:.kiro/automations/exafy.md:60` — stop and go to step 9 with `next_actor: claude` and the reason

Suggestion: Scope the grep to only the specific 'routine step' hand-back patterns being removed in §7d-targeted texts, and explicitly whitelist the legacy executor: claude and owner-governance references the plan itself retains.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
