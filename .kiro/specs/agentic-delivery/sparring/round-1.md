# Sparring round 1 — in_progress

Session: `b80e315e-68b7-4e3b-ae79-d876722af78c` · plan hash `96532c9344f186c42b6033894a70732e7ee6e3284425f10882cf43e3336e75fe`

## Summary

Verified 8 premise groups against the pinned code. All core premises hold. Found one governance gap (production Workers deploy on every landing without PUBLISH) and one misleading-metadata issue in the unchanged recording script.

## Findings

### R1-F1 [major]

DEPLOY-CLOUDFLARE-WORKERS deploys production Workers on every push to `main`. After the cut, every GitLab landing triggers a mirror push to GitHub `main`, which triggers this workflow – meaning every landing automatically deploys production Workers, bypassing PUBLISH. This violates the plan's own principle 5 ('Production stays the owner's PUBLISH after Gate 2'). The plan flags it as 'owner decision C2' but does not resolve it at the cut, and it is not in the cutover checklist (§8.1). Leaving this unresolved means every landing from cut-day onwards is an ungoverned production deployment of Workers code.

- `exafyltd/vitana-platform:services/gateway/src/routes/operator.ts:2298` — await triggerWorkflow('exafyltd/vitana-platform', 'AWS-PROD-DEPLOY-GATEWAY.yml', 'main', { reason: `Command Hub PUBLISH (${vtid}): promote AWS staging ${stagingCommit.slice(0, 7)} by ${identity.user_id}`, deploy_mode: 'promote-staging', expected_commit: stagingCommit, });

Suggestion: Either (a) add DEPLOY-CLOUDFLARE-WORKERS to the disable list at the cut and move its deploy to PUBLISH / T5, or (b) require the owner to decide C2 *before* the cut and record the decision as a gate in the cutover checklist (§8.1). If the owner accepts the exception, document it explicitly as a known governance deviation in §4.

### R1-F2 [minor]

`record-oasis.sh` hard-codes `workflow: "STAGING-VERIFY.yml"` in the OASIS event metadata (line 40). The plan says this script runs 'unchanged' on GitLab. After the cut, every STAGING-VERIFY OASIS event will claim it came from the GitHub workflow `STAGING-VERIFY.yml` even though it ran on a GitLab pipeline. While `publish-gate.ts` does not filter by `workflow` (it filters by `topic`, `service`, `commit`), this pollutes the audit trail and misleads anyone querying OASIS for provenance.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/record-oasis.sh:27` — jq -c --arg run "${RUN_URL:-}" '{ ... metadata: { ... workflow: "STAGING-VERIFY.yml", ... } }' "$RESULTS" > "$BODY_FILE"
- `exafyltd/vitana-platform:services/gateway/src/services/testing/publish-gate.ts:135` — .like('topic', 'staging.verify.%').eq('metadata->>service', service).eq('metadata->>commit', commit)

Suggestion: Accept a `WORKFLOW` env var in `record-oasis.sh` (defaulting to `STAGING-VERIFY.yml` for backward compatibility) and set it to the GitLab pipeline URL or job name in the T2 template. This keeps the script compatible with both hosts during shadow mode.

### R1-F3 [minor]

The PUBLISH frontend leg (`operator.ts:2342-2348`) dispatches `AWS-PROD-DEPLOY-FRONTEND.yml` on `main` of vitana-v1 without pinning a commit SHA. After the cut, GitHub `main` is a mirror of GitLab `main` with up to ~1 minute of propagation delay. If a new landing on GitLab is mirrored to GitHub between the PUBLISH dispatch and the workflow's checkout, the frontend builds from a commit that was not the one STAGING-VERIFY verified. This race exists today but is widened by the asynchronous mirror.

- `exafyltd/vitana-platform:services/gateway/src/routes/operator.ts:2326` — await triggerWorkflow(FRONTEND_REPO, 'AWS-PROD-DEPLOY-FRONTEND.yml', 'main', { reason: `publish-both via Command Hub (${vtid}, gateway ${stagingCommit.slice(0, 7)})` }, FRONTEND_TOKEN);

Suggestion: Note this as a known pre-existing gap (it's not new with the cut) and schedule the fix for T5, which promotes by digest. No action needed at the cut if the owner accepts the pre-existing risk.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
