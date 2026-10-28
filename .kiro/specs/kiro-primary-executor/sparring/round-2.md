# Sparring round 2 — in_progress

Session: `591783a3-f420-43e1-aae2-c6cc444d1664` · plan hash `f6d2c74306e70c06d683cd067d9959fea47865372ad9e0c675db96bfc5ec2163`

## Summary

The revision addresses all six R1 findings coherently, and I verified the key premises against the code. The staging-only cutover freeze (AUTO-DEPLOY.yml, DEPLOY.yml, supabase-functions-deploy.yml) is real and time-based; the unfrozen DEPLOY-CLOUDFLARE-WORKERS.yml is real; RUN-MIGRATION default target resolves to the production Supabase project; per-PR §7b merge instruction and §7a VTID-allocation forbiddance both hold. Two new material gaps remain in B.6 (migration apply): (1) the "or approved a plan or Gate 1 message" clause is ambiguous enough to let a converged-auto-v1 (LLM-policy, silently approved, not owner) plan authorise a §D.2 production database write, contradicting B.6's own "owner has explicitly approved" first bullet and §A's careful owner-yes handling; and (2) the allow_non_transactional mode of RUN-MIGRATION.yml is never constrained or surfaced to the owner, so an approved file could apply non-transactionally with no meaningful rollback. A minor residual: the B.4 staging-only check is a self-certified text rule with no mechanical/CI enforcement (explicitly deferred to a follow-up plan).

## Findings

### R2-F1 [major]

B.6 permits dispatch of RUN-MIGRATION.yml when the owner 'approved a plan or Gate 1 message that lists both by path and target', but this plan's §A and CLAUDE.md establish that a 'plan' can be approved by the LLM policy converged-auto-v1 WITHOUT the owner ever seeing it ('it is not sent to the owner'). That clause therefore lets a policy-approved (not owner-approved) plan listing a migration path+target serve as the §D.2 production-write approval, directly contradicting B.6's own first bullet ('the owner has explicitly approved that file and its target') and §D.2 ('a new production database migration the owner has not already approved'). §A carefully fixes an analogous ambiguity for §7d activation by requiring the owner's Gate 1 'yes'; B.6 has no equivalent owner-only guard for the far more sensitive production write.

- `exafyltd/vitana-platform:CLAUDE.md:66` — A plan sparred by `PLAN-SPAR.yml` whose session converged is approved by the policy `converged-auto-v1` (recorded on the sparring record and accepted by the `vtid_ledger` gate); it is not sent to the owner.
- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:11` — target: description: 'Target database (default = repo variable MIGRATION_TARGET, unset = supabase)' ... default: default

Suggestion: Restrict the B.6 approval source to an explicit owner Gate 1 'yes' (or an explicit in-conversation owner instruction naming the file and target). Clarify that a converged-auto-v1 policy-approved plan does NOT by itself authorise a migration apply, matching §A's owner-yes handling.

### R2-F2 [major]

B.6 requires a rollback file and read-only pre/post checks but never constrains or surfaces the RUN-MIGRATION.yml `allow_non_transactional` input. When true, the Aurora apply runs statement-by-statement WITHOUT a transaction (CREATE INDEX CONCURRENTLY etc.), so a mid-file failure leaves partial DDL with no atomic rollback — the 'rollback file' the plan requires may not reverse it. The owner approving 'the file and target' is not told the apply will run non-transactionally, and the recorded `migration-approval:` line captures only word/date/path/hash/target, not this destructive-irreversible modality (§D.3).

- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:17` — allow_non_transactional: description: 'Aurora only: run a file with CREATE INDEX CONCURRENTLY etc. statement by statement, without a transaction' ... default: false
- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:160` — One Data API transaction for the whole file; any failure rolls back and exits 1 naming the statement (VTID-03174)...

Suggestion: Add to B.6: a non-transactional apply requires the owner's approval to name it (and the recorded migration-approval: line must state allow_non_transactional true/false), or forbid allow_non_transactional for any migration without an explicitly owner-approved irreversible-action decision.

### R2-F3 [minor]

The B.4 staging-only check is a self-certified text rule performed by the same automation/Kiro session that merges, with no independent mechanical or CI enforcement (the plan moves 'Enforcing B.4/B.6 in code' to Out of Scope follow-up). The check requires the session to enumerate every push-to-main workflow and read each cutover_gate's freeze logic 'on main' — a live hand-verification with no tool backing. The first merge whose diff touches a newly-added unfrozen live-deploy workflow (the DEPLOY-CLOUDFLARE-WORKERS pattern) is exactly when a defect would ship, and correctness depends on an LLM session doing the enumeration correctly, unattended.

- `exafyltd/vitana-platform:.github/workflows/DEPLOY-CLOUDFLARE-WORKERS.yml:12` — on: push: branches: [ main ] paths: - 'cloudflare/**' - '.github/workflows/DEPLOY-CLOUDFLARE-WORKERS.yml'
- `exafyltd/vitana-platform:.github/workflows/AUTO-DEPLOY.yml:50` — cutover_gate: ... if [ "${GITHUB_EVENT_NAME}" = "workflow_dispatch" ]; then ... elif [ "$NOW_EPOCH" -ge "$CUTOVER_EPOCH" ]; then ... frozen=true

Suggestion: Given this plan is rule-text only, at minimum have the follow-up plan (code enforcement) land in the same sprint as §7d activation, and state in §7d that the staging-only check must use a workflow-enumeration tool/script rather than manual reading; otherwise keep production deploy boundaries behind a mechanically-enforced gate rather than a session's self-certified list.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
