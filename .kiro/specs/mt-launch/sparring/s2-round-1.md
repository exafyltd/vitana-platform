# Sparring round 1 — in_progress

Session: `0de6a378-b304-4d63-b75b-3813dfcfbf75` · plan hash `64f27219d58cc11c0aef2e5946a635e6bd1fc20b86f57235d7c02e9b84d15a8c`

## Summary

Five findings: one blocker (path ambiguity that breaks the gateway build), two majors (underspecified D18 allowlist; no runtime guard on missing tenant_content_overrides dependency), two minors (OASIS event tenant gap in /claim; SECURITY DEFINER without pinned search_path). All premises verified are cited from files read with read_file.

## Findings

### R1-F1 [blocker]

The path `services/tenant-launch/tenant-feature-flag.ts` places the file outside the gateway TypeScript build tree. No `services/tenant-launch/` directory exists; all three importing lanes are declared as gateway code and will fail to compile.

- `exafyltd/vitana-platform:services/gateway/src/services/data-export-consent.ts:83` — async function tenantExportPolicy(tenantId: string): Promise<boolean> {
- `exafyltd/vitana-platform:services/gateway/src/services/data-export-consent-repository.ts:24` — export async function fetchTenantSettingsFeatureFlags(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_settings').select('feature_flags').eq('tenant_id', tenantId).maybeSingle();
}

Suggestion: The plan models `isTenantFeatureLive` on `data-export-consent.ts` and `data-export-consent-repository.ts`, both of which live at `services/gateway/src/services/`. The plan must replace the abbreviated path `services/tenant-launch/tenant-feature-flag.ts` with the full repo-relative path `services/gateway/src/services/tenant-launch/tenant-feature-flag.ts`. As written, an implementor who follows the path literally creates a new top-level `services/tenant-launch/` sibling directory outside the gateway tsconfig root, breaking TypeScript compilation in all three importing lanes: `pack-intake-admin`, `tenant-owner-analytics`, and `support-landing`.

### R1-F2 [major]

The D18 owner-analytics lineage guard claims 'deny-by-default allowlist (unknown table = health, fail-closed)' but never enumerates which tables ARE on the permitted allowlist, leaving the implementor with no specification.

- `exafyltd/vitana-platform:services/gateway/test/vtid-05156-people-match-health-boundary.test.ts:23` — const HEALTH_TABLES = /['`"](wearable_daily_metrics|wearable_rollup_7d|wearable_samples|health_features_daily|biomarker_results|lab_reports|vitana_index_scores|vitana_pillar_agent_outputs)['`"]/;
- `exafyltd/vitana-platform:services/gateway/test/vtid-05025-commerce-health-boundary.test.ts:18` — 4. A source scan of the commerce modules finds no wearable opt-in, no
 *      wearable field read and no health-data table.

Suggestion: The two existing boundary tests (VTID-05025, VTID-05156) use named deny-lists of specific health table identifiers. The plan escalates to an allowlist model but never states which tables owner-analytics IS permitted to read (e.g. `product_analytics_events`, `product_analytics_daily_rollups`, `tenant_pack_intake`). Without that explicit list the implementor will either invent the allowlist (silently expanding the permitted surface) or fall back to the deny-list pattern the plan claims to supersede. The plan must enumerate the permitted-table allowlist in the Tests section.

### R1-F3 [major]

The publish path to `tenant_content_overrides` has no runtime guard; the dark flag is the sole protection against a write to a non-existent table if the flag is accidentally enabled before WS5 ships.

- `exafyltd/vitana-platform:supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql:18` — create table if not exists public.product_analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_name text not null,
  tenant_id uuid not null,
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:205` — const tenantId = process.env.DEFAULT_TENANT_ID;
        if (tenantId) {
          const { data: attempt } = await repo.fetchAttemptReferralInfo(supabase, attempt_id);

          dispatchEvent(tenantId, 'user.signup.completed', {

Suggestion: The migration directory (confirmed by reading `20260612140000_BOOTSTRAP_product_analytics_events.sql`) shows a comparable analytics table with its own migration; no equivalent migration for `tenant_content_overrides` is present at the pinned commit, as the plan itself acknowledges. The existing dispatch patterns in `admin-signups.ts` show no table-existence guards before invoking downstream writes. If `mt.launch_pipeline` is accidentally set `true` on staging before WS5 merges, the publish code will throw an uncaught PostgREST `42P01` error. The publish function must add an explicit `to_regclass('public.tenant_content_overrides') IS NOT NULL` guard (or a clean `DEPENDENCY_NOT_READY` application error) independent of the flag state.

### R1-F4 [minor]

The `community-invites.ts` `/claim` path emits an OASIS event (line 79) with no `tenant_id` in its payload; the `support-landing` attribution fix targets `admin-signups.ts` but does not cover this invite-attribution event.

- `exafyltd/vitana-platform:services/gateway/src/routes/community-invites.ts:73` — await emitOasisEvent({
          vtid: 'SYSTEM',
          type: (outcome.rewarded ? 'community_autopilot.invite.rewarded' : 'community_autopilot.invite.attributed') as any,
          source: 'community-autopilot',
          status: 'info',
          message: `Invite attributed${outcome.rewarded ? `, inviter credited ${outcome.credits}` : ''}`,
          payload: { referral_id: outcome.referral_id, referred_id: identity.user_id, rewarded: outcome.rewarded, reward_reason: outcome.reward_reason ?? null },
        }).catch(() => {});
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:205` — const tenantId = process.env.DEFAULT_TENANT_ID;
        if (tenantId) {
          dispatchEvent(tenantId, 'user.signup.completed', {

Suggestion: The `support-landing` lane fixes `admin-signups.ts` to resolve the real tenant before dispatching signup events. But `community-invites.ts:73-80` fires `emitOasisEvent` on invite attribution with `vtid: 'SYSTEM'` and no `tenant_id` anywhere in the payload. For a non-default-tenant founding invite, this event remains permanently unattributed to the correct tenant even after the fix ships. The lane must also resolve the owning tenant from the invite record in `community-invites.ts` and include it in the OASIS event payload; the required Jest test should cover this code path.

### R1-F5 [minor]

`get_tenant_launch_readiness` is specified as SECURITY DEFINER without a pinned `search_path`, which is the standard Postgres search_path hijacking vector (CVE-2018-1058 pattern).

- `exafyltd/vitana-platform:supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql:1` — -- BOOTSTRAP-PRODUCT-ANALYTICS: raw product analytics event store.
--
-- Dedicated pipeline for product/behavior analytics (Assistant usage, click
-- journeys, feature adoption, interests, friction). Deliberately separate
-- from oasis_events
- `exafyltd/vitana-platform:services/gateway/src/services/data-export-consent-repository.ts:24` — export async function fetchTenantSettingsFeatureFlags(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_settings').select('feature_flags').eq('tenant_id', tenantId).maybeSingle();
}

Suggestion: A comparable cross-tenant read surface (`product_analytics_events`) uses the gateway repository pattern rather than a SECURITY DEFINER RPC. When SECURITY DEFINER is unavoidable, the migration must include `SET search_path = public, pg_catalog` in the function body (or via `ALTER FUNCTION ... SET search_path`) to prevent search_path hijacking. The `20261101110100_mt_launch_tenant_content_pipeline.sql` migration must include this guard and must state which role owns the function, confirming that role holds only SELECT on `tenant_pack_intake` and `tenant_content_pipeline`.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
