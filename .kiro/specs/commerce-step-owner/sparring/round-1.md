# Sparring round 1 — in_progress

Session: `cc9a79de-e669-416e-bcd3-ed6a7056d041` · plan hash `f1eb1e17e2542f4cf3adaed7e092a65400fcf0cc830ae748e1eb79dfcb4cf5ad`

## Summary

I verified the plan's premises about the gateway checklist module, Commerce MCP shaping, verification codes, partner review, and existing tests. All file locations and code shapes match. One substantive logic issue in the proposed `stepOwner` verification mapping, plus two minor gaps.

## Findings

### R1-F1 [major]

The proposed `stepOwner` verification logic uses the union `step.missing ∪ step.detail.missing` with 'first match wins' priority, checking supplier codes (email_not_verified, domain_proof) before assistant codes (facts_changed). When `verificationIsStale` fires (line 264-267), `step.missing` is overwritten to `['facts_changed']` but `step.detail` is preserved from the stored row, so `step.detail.missing` still contains the old verification's codes (e.g. `email_not_verified`). The union will contain both `facts_changed` and stale codes like `email_not_verified`. Because the supplier codes are checked first, the step owner would be `supplier` when `assistant` is correct (the assistant should re-run `check_verification` against the new facts).

- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-checklist.ts:258` — const row = stored.get(key);
    if (row && isStepStatus(row.status)) {
      status = row.status;
      if (row.detail && typeof row.detail === 'object') detail = row.detail;
      if (key === 'verification' && verificationIsStale(row.detail, input.org)) {
        status = 'todo';
        missing = ['facts_changed'];
      }
    }
- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-service.ts:723` — const detail = {
      level_required: required,
      level_reached: outcome.level_reached,
      checks,
      missing: outcome.missing,

Suggestion: Either (a) when `facts_changed` is present in `step.missing`, ignore `step.detail.missing` entirely (the stale codes are meaningless once facts changed), or (b) give `facts_changed` priority over all supplier codes in the match order — e.g. check `facts_changed` → `assistant` before checking `email_not_verified` → `supplier`.

### R1-F2 [minor]

The verification step can carry a `website` missing code (prepended at partner-onboarding-service.ts:720 when the org has no website host). The plan's stepOwner verification mapping does not enumerate `website`, so it falls through to the 'unknown code → supplier' default. In reality the assistant can set the website via `update_business`. The safe default is not harmful (it won't promise something the AI cannot do), but it is inaccurate — the supplier would see verification listed under 'Only you can do this' when the assistant could resolve it.

- `exafyltd/vitana-platform:services/gateway/src/services/partner-onboarding-service.ts:719` — const outcome = computeVerification(required, checks);
    if (!host) outcome.missing.unshift('website');

Suggestion: Add `website` to the assistant-owned codes in the stepOwner verification mapping (the assistant can call `update_business` to set it). Alternatively, document it in the table test so the unknown-code fallback is a conscious choice.

### R1-F3 [minor]

The plan says shapeStatus will add `owner` to `next_action`, but `nextAction` can return the pseudo-step `business_type` for typeless orgs (line 370), which is not a ChecklistStep and has no stepOwner. The plan does not specify what `owner` value `next_action` gets in the typeless case.

- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:370` — if (typeless) return { step: 'business_type', tool: 'update_business', supplier_action: null, link: null };
- `exafyltd/vitana-platform:services/gateway/src/services/commerce-mcp.ts:444` — const typeless = !checklist && org.partner_type == null;
    const suggested = shapeSuggested(org, suggestions);
    const action = nextAction(checklist, typeless, `${portalUrl}/commerce?org=${org.id}`);

Suggestion: Specify that `next_action.owner` is `'assistant'` when typeless (the tool is `update_business`), or null when there is no next step. Add a test case for the typeless path.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
