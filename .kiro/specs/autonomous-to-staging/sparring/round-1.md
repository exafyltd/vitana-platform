# Sparring round 1 — in_progress

Session: `01e8f715-215c-4c57-a081-651f835939e4` · plan hash `1b2c18bea5b8e1e813986aea6455d92cbef78e80176d305a053a8f064822338f`

## Summary

The plan is ambitious and largely well-researched. Most premises about the current system hold. However, there are several significant gaps: the bootstrap mechanism for merging protected gate files autonomously is unspecified (today's code unconditionally blocks them), staging and production Aurora share an AWS account with only naming-convention IAM as the boundary, and the scope-check enforcement creates a chicken-and-egg problem for the lanes that must change it. These need resolution before implementation.

## Findings

### R1-F1 [blocker]

The plan says lanes touching protected gate files 'merge under the current §3a rule with this plan's owner instruction plus a reviewer-agent accept', but does not specify the actual merge mechanism. Today, `land-guard.mjs:108-109` unconditionally refuses ANY merge that touches a protected gate file — no amount of reviewer accepts or owner instructions unlocks it programmatically. `governance.ts:15-19` confirms: 'a PR that changes a protected gate file is ALWAYS refused in code (protected_gate_file): no review ever unlocks it programmatically; the owner's instruction naming the plan is the out-of-band authority.' The only way to merge these PRs today is `gh pr merge --admin`, which `collaboration.md:274-277` limits to governance-artifact false positives. The plan doesn't specify who performs this admin override in an autonomous flow, or whether the land-guard code itself is modified first (which is itself a protected gate file).

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:107` — export function mergeDecision({ review, checks, behindBy, protectedFiles = [] }) {
  if (protectedFiles.length) return { ok: false, code: 1, reason: `protected gate file(s) changed (${protectedFiles.join(', ')}): §7b needs a Claude review or an owner instruction; not merged by the guard` };
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:15` — a PR that changes a protected gate file is ALWAYS refused in code
(`protected_gate_file`): no review ever unlocks it programmatically; the
owner's instruction naming the plan is the out-of-band authority, recorded
in the lane log (VTID-05408 §5). Defense-in-depth with queue.mjs
scope-check, which refuses the same files independently.

Suggestion: Specify the bootstrap merge mechanism explicitly. Options: (1) The owner merges the first protected-gate lane (`machine-gate-protected`) manually or via `gh pr merge --admin`, accepting that this one step is human-in-the-loop by design. (2) Add a new workflow or land-guard path that accepts the owner-instruction record (e.g. a signed handoff.md entry) as programmatic authority. Either way, the plan must say exactly how the code that blocks protected-gate merges is itself merged.

### R1-F2 [blocker]

The `queue.mjs` scope-check (line 1033-1034) unconditionally rejects protected gate files for any non-claude executor. The plan says these lanes use `executor: claude` 'with no fixed seat' and go to the exceptions path while Claude Code is unavailable. But the exceptions path (`collaboration.md:228`) says 'Only protected gate files (§3a) still wait for owner/Claude review.' So these lanes cannot execute autonomously under the current rules — they are blocked waiting for Claude, which the plan says is retired. The plan must resolve this contradiction before any lane touching a protected gate file can proceed.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1032` — if (fm.executor === 'claude') continue;
// VTID-05276 (plan §4.3): a protected gate file never passes for a non-claude lane, whatever its reviewer.
else if (matchesAny(f, PROTECTED_GATE_PATHS)) errors.push(`${f} is a protected gate file ...`);
else if (!matchesAny(f, GOVERNANCE_PATHS)) continue;
else if (fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && trustedFrom) continue;
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:226` — unavailable, every job that goes to Claude today goes to the **exceptions seat `exafyltd`**: end-of-rotation
reassigns, parks, stale claims, `executor: claude` items, re-plan of parked plans, STAGING-VERIFY fix-forward (max
3, then park). Only protected gate files (§3a) still wait for owner/Claude review.

Suggestion: Either (a) make the `machine-gate-protected` lane the very first lane and have it land with a human-assisted merge (which changes the scope-check to accept the two-model rule for subsequent lanes), or (b) explicitly state that the owner (human) assists the bootstrap lanes that change the gate enforcement code itself. The plan should acknowledge this is a one-time human step rather than claiming the whole flow is autonomous from the start.

### R1-F3 [major]

The plan places the isolated staging Aurora cluster (`vitana-aurora-staging`) in AWS account `472838866351`, which is the same account where the production Aurora cluster runs (confirmed by RUN-MIGRATION.yml line 130: `AWS_ACCOUNT_ID: '472838866351'`). The only isolation between staging and production is IAM naming patterns (`*-staging*` vs `*-prod*`, `*-awsdr`). A single naming mistake, wildcard in a policy, or IAM misconfiguration gives the autonomous `kiro-staging-operator` role access to the production database. For a plan whose purpose is removing all human gates before staging, soft IAM-name boundaries in a shared account are insufficient.

- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:128` — env:
  AWS_REGION: eu-central-1
  AWS_ACCOUNT_ID: '472838866351'
  AWS_PAGER: ''
  MIGRATION_FILE: ${{ inputs.migration_file }}

Suggestion: Use a separate AWS account for the staging data plane. AWS Organizations makes this straightforward and provides a hard account boundary. Alternatively, if cost/complexity rules that out, add explicit resource-ARN deny statements (not name patterns) for the specific production Aurora cluster ARN, production secret ARNs, and the production Supabase project ref, and require an SCP (Service Control Policy) at the OU level that prevents the staging role from ever touching the production cluster.

### R1-F4 [major]

The two-model reviewer gate for protected gate files uses models exclusively from the same provider family (Anthropic Claude). The current chain is `claude-sonnet-5.5`, `claude-opus-5.5`, `claude-sonnet-4.5` (governance.ts lines 39-43). Two models from the same family reviewing self-modifying gate code may share systematic blind spots. This replaces a human review — which provides genuine independence — with a same-family model pair, which is a weaker control for the files that define the gates themselves.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:39` — export const REVIEWER_AGENT_MODELS: readonly string[] = Object.freeze([
  'claude-sonnet-5.5',
  'claude-opus-5.5',
  'claude-sonnet-4.5',
]);

Suggestion: Either (a) require at least one reviewer model from a different provider family (e.g. a frontier model from a second vendor) to provide genuine independence, or (b) add a mechanical invariant check (a script that parses the protected gate files and verifies the critical properties — e.g. the protected list is non-empty, the deny patterns are present) that runs as a required CI check independent of the model review, or (c) acknowledge this as a risk with a compensating control (e.g. a nightly audit that diffs protected gate files and alerts the owner).

### R1-F5 [minor]

H5 cites `collaboration.md:243-245` for '3 failed fix-forwards park the lane with next_actor: owner', but those lines are about §7a restrictions on mutating AWS calls ('no mutating AWS call (ECS, ELB, ECR, IAM...'). The fix-forward parking rule is actually at collaboration.md lines 247-248.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:243` — tools) and no mutating AWS call (ECS, ELB, ECR, IAM or Secrets Manager writes). A merge under §7b is not a
     session-tool write; staging deploys only through its workflow.

Reading for diagnosis is fine. A database change is a migration file in the lane's PR. Blocked → fix forward; after 3
attempts park with the five-part stop message (§7); `next_actor: claude` only when Claude is available.

Suggestion: Correct the citation to `collaboration.md:247-248` and `driver.md:52`.

### R1-F6 [minor]

The plan introduces a `quarantined` lane state but does not specify an OASIS event for it. CLAUDE.md ALWAYS rule 1 requires OASIS as the single source of truth for task state and lifecycle. A new state transition without an OASIS event violates this governance rule.

- `exafyltd/vitana-platform:CLAUDE.md:98` — ### Source of Truth & Governance
1. **Always treat OASIS as the single source of truth** for task state, lifecycle, and governance.
2. **Always verify VTID existence** before execution, deployment, or automation.

Suggestion: Add an `oasis.lane.quarantined` event (or similar) to the quarantine lane specification, emitted on every transition into and out of quarantine, with the lane key, reason, and VTID.

### R1-F7 [major]

The plan gives Kiro `AdministratorAccess` in account `841276716213` (`kiro-engineering-admin`). The plan describes this as 'the engineering account', but the plan never verifies what resources exist in this account or confirms it is non-production. If any production or customer-facing resource exists in `841276716213`, full admin access is a security exposure. The plan's own risk section acknowledges 'Admin role in the engineering account' but asserts 'production in 472838866351 stays denied' without verifying that no production resource lives in `841276716213`.

- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:128` — env:
  AWS_REGION: eu-central-1
  AWS_ACCOUNT_ID: '472838866351'

Suggestion: Add a premise verification step: enumerate the resources and services in account `841276716213` and confirm it contains no production, customer-facing, or data-bearing resources. If it does, scope the role down from AdministratorAccess to the specific services needed. At minimum, name the account's purpose and contents in the plan.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
