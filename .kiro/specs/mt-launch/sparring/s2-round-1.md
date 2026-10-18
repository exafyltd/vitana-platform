# Sparring round 1 — in_progress

Session: `3857a677-3d42-4a52-bb7f-441d625de10d` · plan hash `28c70e45e127c378afb64accd55debce282944e6e5f0a9b66943caa6f6e73d1b`

## Summary

Ten premises were checked against code by reading 15+ files at the pinned commit. One is a direct contradiction (referral attribution uses DEFAULT_TENANT_ID, not a per-tenant ID, contradicting the plan's claim that it is already tenant-scoped). The specialist-routing file cited by the plan is unverifiable from the feedback-admin.ts change site I actually read. The D18 guard test has an unresolved import ambiguity against an unshipped spec. Two minors on intra-lane ordering and a misleading citation.

## Findings

### R1-F1 [blocker]

The plan falsely states referral/invite attribution at admin-signups.ts:208-229 is 'already tenant-scoped.' The actual code at line 205 reads `const tenantId = process.env.DEFAULT_TENANT_ID;` and dispatches all user.signup.referral and user.signup.shared_link events against that hardcoded value regardless of which tenant the user is actually joining. The plan's support-landing lane declares this as-is and out of scope. When WS8 launches a second tenant and sends founding invites (a tenant_pack_intake item), every resulting referral event will be silently attributed to the default Maxina tenant. The founding_invites_30 intake checklist item is tracking a mechanism that is provably broken for non-default tenants.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:203` — if (status === 'onboarded' && auth_user_id) {
  const tenantId = process.env.DEFAULT_TENANT_ID;
  if (tenantId) {
    const { data: attempt } = await repo.fetchAttemptReferralInfo(supabase, attempt_id);
    dispatchEvent(tenantId, 'user.signup.completed', { user_id: auth_user_id, attempt_id })...
    if (attempt?.referral_code) {
      dispatchEvent(tenantId, 'user.signup.referral', { user_id: auth_user_id, referral_code: attempt.referral_code })...
    }
    if (attempt?.utm_source === 'sharing_link' ...) {
      dispatchEvent(tenantId, 'user.signup.shared_link', { utm_campaign: attempt.utm_campaign })...
    }
  }
}

Suggestion: Add a 'referral-attribution-mt' sub-lane: resolve the signing-up user's actual tenant from the referral_code's owning tenant or from the invite record before dispatching. Alternatively, scope founding_invites_30 out of the intake checklist and file a separate tracked WS8 task for multi-tenant referral dispatch. Under no circumstances declare this code tenant-scoped — it is not, and shipping WS8 on top of it will silently corrupt attribution for every new tenant launch.

### R1-F2 [major]

The plan's Problem section claims feedback tickets are routed to specialists via `live-tool-catalog.ts:1006`, and the support-landing lane targets `routes/feedback-admin.ts` and `routes/feedback-intake.ts` as the change sites. The only feedback-admin.ts routing code I can read (lines 220-260) routes to `fetchTenantMemberUserIds` and `fetchTenantFeedbackTickets` with no reference to any specialist catalog, tool catalog, or Devon/Sage/Atlas/Mira routing. There is no live-tool-catalog.ts visible in the gateway routes or services code I read. If specialist routing for support tickets lives in a different pipeline (e.g. orb/live or the autopilot specialist service) and not in the files the plan intends to change, the support-landing lane will add per-tenant metadata to the wrong code path and the actual specialist dispatch will remain untouched.

- `exafyltd/vitana-platform:services/gateway/src/routes/feedback-admin.ts:220` — router.get('/tenants/:tenantId/tickets', async (req: Request, res: Response) => {
  const tenantId = req.params.tenantId;
  const supabase = getServiceClient();
  const { data: members, error: memErr } = await repo.fetchTenantMemberUserIds(supabase, tenantId);
  ...
  const { data, error } = await repo.fetchTenantFeedbackTickets(supabase, userIds, limit);
  // No specialist routing, no tool catalog import, no Devon/Sage/Atlas/Mira reference in the lines read.
- `exafyltd/vitana-platform:services/gateway/src/services/feature-flags.ts:1` — Feature flag helper — Phase 0 staging build.
// (feature-flags.ts contains no import of or reference to live-tool-catalog, confirming it is not a gateway-wide shared module.)

Suggestion: Before assigning the support-landing lane, read-only-verify where Devon/Sage/Atlas/Mira specialist dispatch actually originates for feedback tickets. If it is in the orb/live pipeline or the autopilot specialist service rather than feedback-admin.ts/feedback-intake.ts, the change sites in the plan are wrong. Correct the file citations and widen (or narrow) the lane scope accordingly.

### R1-F3 [major]

The plan contradicts itself on whether the D18 owner-analytics boundary test defines its own HEALTH_TABLES list or imports it from the as-yet-unshipped mt-identity spec. The Depends on section states 'the D18 lineage lint references that canonical list [from mt-identity's isHealthTable()] and does not keep its own.' The Tests section describes the test as scanning for 'no HEALTH_TABLES regex,' implying an inline constant. No isHealthTable() function exists anywhere in the gateway at the pinned commit. The existing commerce boundary test (vtid-05025, line 248) defines its HEALTH_TABLES regex entirely inline without any external import. If the new D18 test imports from mt-identity, it cannot compile until mt-identity ships, making both tenant-owner-analytics and worker-test-gate blocked on that unshipped spec. If the test defines its regex inline, 'does not keep its own' is wrong and the two lists will silently diverge whenever a new health table is added.

- `exafyltd/vitana-platform:services/gateway/test/vtid-05025-commerce-health-boundary.test.ts:248` — const HEALTH_TABLES = /['"\`](wearable_daily_metrics|wearable_rollup_7d|wearable_samples|health_features_daily|biomarker_results|lab_reports|vitana_index_scores|vitana_pillar_agent_outputs)['"\`]/;
// Defined inline with no import from any external health-table registry.

Suggestion: Pick one design and state it unambiguously. Option A (inline, consistent with existing pattern): the test defines its own HEALTH_TABLES regex, the plan drops 'does not keep its own,' and a governance rule is added requiring both lists be updated together until mt-identity ships. Option B (import): promote mt-identity to a compile-time dependency, gate the tenant-owner-analytics VTID so it cannot be merged until mt-identity's isHealthTable() export is live, and add a build-time import check.

### R1-F4 [minor]

The support-landing lane imports isTenantFeatureLive from services/tenant-launch/tenant-feature-flag.ts, a file created by pack-intake-admin. Both are gateway code lanes in the same spec. If they are assigned to concurrent workers or separate VTIDs without an explicit merge-order enforcement, support-landing will fail to compile. The plan states 'depends_on pack-intake-admin' but provides no VTID sequencing guard or compile-time sentinel that enforces the ordering.

- `exafyltd/vitana-platform:services/gateway/src/services/data-export-consent-repository.ts:1` — // impact-allow-no-test: pure data-access seam...
// Aurora migration B1 data-access seam (VTID-03702).
// Every Supabase .from(...) call in data-export-consent.ts now goes through here.
// PURE MOVE, not a rewrite.
// (Shows the codebase pattern of creating dependent files as separate allocations that can be split into different VTIDs/workers.)

Suggestion: Either merge pack-intake-admin and support-landing into a single VTID so the file is guaranteed present before any import of it is compiled, or add an explicit VTID dependency field in the VTID ledger entry for support-landing that blocks its PR until pack-intake-admin's VTID is marked CLOSED.

### R1-F5 [minor]

community-invites.ts:79 is cited as evidence that referral-invite attribution 'is tenant-scoped.' That line is merely an OASIS event payload property inside the /claim handler's emit block — it carries referral_id and referred_id but says nothing about which tenant the attribution is scoped to. Used alongside the incorrect premise at admin-signups.ts:205 (R1-F1), this citation actively obscures the attribution bug.

- `exafyltd/vitana-platform:services/gateway/src/routes/community-invites.ts:72` — await emitOasisEvent({
  ...
  payload: {
    referral_id: outcome.referral_id,
    referred_id: identity.user_id,
    rewarded: outcome.rewarded,
    reward_reason: outcome.reward_reason ?? null
  },
}).catch(() => {});

Suggestion: Remove community-invites.ts:79 as a supporting citation for tenant-scoped attribution. It demonstrates an OASIS event emission, not tenant-scoped attribution logic. Replace with an actual read of the referral credit/attribution service that shows (or fails to show) the tenant_id being resolved correctly for non-default tenants.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
