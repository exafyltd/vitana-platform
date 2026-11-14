# Sparring round 1 — in_progress

Session: `92c6fbcd-fe6a-42c0-ac74-468c11b2fc50` · plan hash `983c925ca7b3de1517fe73e0fadd8e1b88219ead4100d57f68f1b5f1115f38c0`

## Summary

Verified 10+ premises against the code at the review pin. Most factual claims about existing files and line numbers hold. Three findings raised: one blocker-level concern about the IAM deny-list approach in the Organizations management account, one major design gap in the invariant check's bootstrap behavior, and two minor issues (a premise inaccuracy and overly broad engineering-account access). The vitana-v1 repo is not pinned in this review session, so several v1 premises could not be verified but are noted as a limitation rather than a finding.

## Findings

### R1-F1 [blocker]

The `kiro-staging-operator` role in account 472838866351 uses a deny-list of enumerated production ARNs to protect production. The plan itself states this account is the Organizations management account where SCPs do not apply. A deny-list in the management account means: (1) any production resource not on the list is writable by Kiro from day one; (2) every new production resource added later (a new ECS service, a new secret, a new Aurora instance) is writable until someone remembers to update the deny list; (3) there is no SCP backstop. The plan defers the stronger control (separate staging account) but provides no reconciliation mechanism, no drift detection, and no CI check that the deny list is complete relative to the actual production inventory. Given that the entire point of this plan is to remove human gates, the last human-independent safety net for production resources in this account is a static list of ARNs that can go stale.

- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:128` — AWS_REGION: eu-central-1
        AWS_ACCOUNT_ID: '472838866351'
        AWS_PAGER: ''
        MIGRATION_FILE: ${{ inputs.migration_file }}
- `exafyltd/vitana-platform:.kiro/steering/vitana-owner-autonomy.md:40` — | 1 | Applying a database migration. The owner must approve ... because staging shares the production database ... | 7 | Verification would need a write to a live or shared system (production Supabase, gateway, community content) |

Suggestion: Either (a) mandate an allow-list approach for `kiro-staging-operator` (grant access only to staging-prefixed resources by ARN, deny everything else), or (b) add a required CI step that inventories every production resource in 472838866351 and fails when the deny list is missing any of them, run on every PR that touches `infra/kiro-access/**`. Document the staleness risk and the reconciliation frequency. The deferred separate-staging-account DEC should have a target date.

### R1-F2 [major]

The plan states the mechanical invariant check (`gate-invariants.mjs`) 'fails closed and cannot be changed in the same PR that changes the files it protects (it reads its expectations from the merge-base).' On the `machine-gate-protected` PR itself — the first and most critical PR, which defines the two-model merge rule and all gate invariants — the merge-base (main) has no `gate-invariants.mjs` and no expectations file. The check is therefore either (a) inert/skipped (no expectations to enforce, so the first version can be arbitrarily wrong), or (b) fails (file not found, so the bootstrap merge cannot satisfy 'every check green'). The plan does not specify which behavior applies or how the bootstrap reconciles it. The claim about the check's properties is misleading as stated because it does not hold for the check's own introduction.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:167` — - name: Lane scope
          run: |
            git show "$BASE:scripts/collab/queue.mjs" > "$RUNNER_TEMP/queue.mjs"
            if git cat-file -e "$BASE:scripts/collab/protected-gate-files.json" 2>/dev/null; then
              git show "$BASE:scripts/collab/protected-gate-files.json" > "$RUNNER_TEMP/protected-gate-files.json"
            fi
            node "$RUNNER_TEMP/queue.mjs" scope-check ...
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:107` — /** Merge decision from the gates. */
export function mergeDecision({ review, checks, behindBy, protectedFiles = [] }) {
  if (protectedFiles.length) return { ok: false, code: 1, reason: `protected gate file(s) changed ...` };

Suggestion: Specify the bootstrap behavior explicitly: (1) on the `machine-gate-protected` PR, `gate-invariants.mjs` skips when merge-base has no expectations (the check cannot protect its own introduction); (2) the plan should note this limitation and state that the owner instruction + reviewer-agent accept is the sole authority for this first PR; (3) consider a post-merge verification step that reads `gate-invariants.mjs` from main after merge and confirms all expected invariants are present.

### R1-F3 [minor]

H5 claims '3 failed fix-forwards park the lane with `next_actor: owner`' and cites `collaboration.md:247-248` among its sources. But collaboration.md line 248 actually reads '`next_actor: claude` only when Claude is available', not `next_actor: owner`. The plan's characterization is correct for `driver.md:52` (which does say `next_actor: owner`) but incorrect when attributed to collaboration.md. The existing rules are themselves inconsistent between these two files; the plan should acknowledge the discrepancy rather than flatten it.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:247` — Reading for diagnosis is fine. A database change is a migration file in the lane's PR. Blocked → fix forward; after 3
attempts park with the five-part stop message (§7); `next_actor: claude` only when Claude is available.
- `exafyltd/vitana-platform:.kiro/pipeline/driver.md:51` — 3 attempts per lane; the 4th failure parks the lane (`parked`, `parked_from`, `next_actor: owner`) with the
    five-part message.

Suggestion: Correct the H5 citation: attribute `next_actor: owner` to `driver.md:52` only, and note that `collaboration.md:248` says `next_actor: claude`. The `rules-platform` lane should resolve this inconsistency (both files are in its scope).

### R1-F4 [minor]

The `kiro-engineering-admin` role gets AdministratorAccess in account 841276716213 with explicit denies only on instance/volume deletion and bucket/object deletion. The engineering account holds Secrets Manager secrets including `vitana/engineering/gitlab/root-password`, `runner-token`, and `github-mirror-token` (a GitHub fine-grained read-only token for both repos). AdministratorAccess grants `secretsmanager:GetSecretValue` on all of these, meaning the Kiro automation principal can read the GitLab root password and the GitHub token. The delete denies do not cover read access to credentials.

- `exafyltd/vitana-platform:.kiro/specs/eng-gitlab-m1/plan.md:86` — GitLab machine: Ubuntu 24.04 ... Secrets Manager (KMS key `alias/vitana-engineering`): `vitana/engineering/gitlab/root-password`, `runner-token`, `github-mirror-token`.
- Backups: bucket `vitana-engineering-gitlab-backups-<account id>` (SSE-KMS, versioned, objects expire after 30 days).

Suggestion: Consider a narrower policy (the actions Kiro actually needs — SSM session, EC2 describe, Terraform state read/write, etc.) instead of AdministratorAccess. At minimum, add an explicit Deny on `secretsmanager:GetSecretValue` for the credential secrets (`vitana/engineering/gitlab/root-password`, `runner-token`, `github-mirror-token`) so the automation principal cannot read them.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
