# Sparring round 2 — in_progress

Session: `5e927bc9-b53f-44fe-8949-d8aee8d1a817` · plan hash `e25b797725f88abd42bcc60524a1dd5aad472aae9bcf81bd7a163a4d38e7a94b`

## Summary

The revised plan correctly addressed both R1-F1 (recommendations table now in inventory) and R1-F2 (vitana-v1 premise pre-flight). Key premises about the notification stack, MIGRATION-QUEUE, health.ts GET /summary, and the integrations-repository conflict target all hold. However, the plan's "five verified sites" for health-tenant-accessor conversion is incomplete: two additional repositories (voice-tools/health-log-repository.ts and orb-tools/health-depth-tools-repository.ts) write health_features_daily, biomarker_results, lab_reports, and wearable_samples with the same session-tenant pattern — including a zero-UUID fallback — and read vitana_index_scores and biomarker_results without any tenant filter. These are class (a) sites that must appear in the inventory or be explicitly classified.

## Findings

### R2-F1 [major]

The plan's health-tenant-accessor lane names 'five verified sites' for conversion to healthDb, but at least two additional repositories write to health_features_daily with the same tenant_id conflict target and use the same session-tenant fallback (or a zero-UUID fallback): voice-tools/health-log-repository.ts (upsertHealthFeatureDaily at :28, fetchUserTenantIdForVoiceLog at :20, fetchVitanaIndexScoreTotal at :24 reading vitana_index_scores without tenant filter) and orb-tools/health-depth-tools-repository.ts (upsertHealthFeatureDaily at :29, fetchTenantIdForUser at :21, plus writes to wearable_samples/:88, lab_reports/:95, biomarker_results/:99 and reads of vitana_index_scores/:25,118 and biomarker_results/:135 without tenant filter). Both use service-role admin clients (no RLS) and fall back to DEFAULT_TENANT_ID '00000000-0000-0000-0000-000000000000' (health-depth-tools.ts:95,131; health-log.ts:146). If the five named sites are converted to healthDb but these two are not, voice-tool and orb-tool health writes continue using the session/zero-UUID tenant while reads use the frozen home tenant, creating split or orphaned health data for dual members.

- `exafyltd/vitana-platform:services/gateway/src/services/voice-tools/health-log-repository.ts:20` — export async function fetchUserTenantIdForVoiceLog(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchVitanaIndexScoreTotal(sb: SupabaseClient, userId: string, date: string) {
  return sb.from('vitana_index_scores').select('score_total').eq('user_id', userId).eq('date', date).maybeSingle();
}

export async function upsertHealthFeatureDaily(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    ...
  },
) {
  return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' });
}
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/health-depth-tools-repository.ts:21` — export async function fetchTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchVitanaIndexScoreTotal(sb: SupabaseClient, userId: string, date: string) {
  return sb.from('vitana_index_scores').select('score_total').eq('user_id', userId).eq('date', date).maybeSingle();
}

export function upsertHealthFeatureDaily(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    ...
  },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' });
}
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/health-depth-tools-repository.ts:77` — export async function fetchHealthFeatureValue(sb: SupabaseClient, tenantId: string, userId: string, date: string, featureKey: string) {
  return sb
    .from('health_features_daily')
    .select('feature_value')
    .eq('tenant_id', tenantId)
    ...
}
...
export function insertWearableSamples(...) {
  return sb.from('wearable_samples').insert(rows);
}
...
export async function insertLabReport(...) {
  return sb.from('lab_reports').insert(...);
}
...
export function insertBiomarkerResult(...) {
  return sb.from('biomarker_results').insert(row);
}
...
export async function fetchBiomarkerResults(sb: SupabaseClient, userId: string, limit: number, query?: string) {
  let q = sb
    .from('biomarker_results')
    .select('name, biomarker_code, value, unit, ref_range_low, ref_range_high, status, measured_at')
    .eq('user_id', userId)
    .order('measured_at', { ascending: false })
    .limit(limit);
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/health-depth-tools.ts:95` — const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';
...
async function resolveHealthTenantId(id: OrbToolIdentity, sb: SupabaseClient): Promise<string> {
  if (id.tenant_id) return id.tenant_id;
  const { data, error } = await repo.fetchTenantIdForUser(sb, id.user_id);
  ...
  return (data as { tenant_id?: string } | null)?.tenant_id ?? DEFAULT_TENANT_ID;
}
- `exafyltd/vitana-platform:services/gateway/src/services/voice-tools/health-log.ts:140` —     // Resolve tenant via user_tenants fallback (mirrors integrations.ts).
    let tenantId = input.tenant_id;
    if (!tenantId) {
      const { data: tenantRow } = await repo.fetchUserTenantIdForVoiceLog(admin, input.user_id);
      tenantId = (tenantRow?.tenant_id as string | undefined) ?? null;
    }
    const effectiveTenantId = tenantId ?? '00000000-0000-0000-0000-000000000000';
    ...
    const { error: featErr } = await repo.upsertHealthFeatureDaily(admin, {
      tenant_id: effectiveTenantId,
      ...

Suggestion: Add voice-tools/health-log-repository.ts and orb-tools/health-depth-tools-repository.ts to the health-tenant-accessor inventory with (a)/(b)/(c) classifications for every health-table call site. Both repos' tenant-resolution helpers (fetchUserTenantIdForVoiceLog, resolveHealthTenantId) and all their health-table writers/readers must convert to healthDb in the same PR and flag as the other five sites, or be explicitly classified (c) with documented justification. The zero-UUID fallback must be replaced by the healthDb resolver.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The revised plan adds recommendations to the (a) class with the fetchRecommendationsForDate and fetchRecentRecommendations conversions documented.
- R1-F2: acknowledged — Accepted and addressed. Task N0 now writes the path listing to docs/validation/<VTID>/vitana-v1-premises.md before any test is written, and parks on missing file.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
