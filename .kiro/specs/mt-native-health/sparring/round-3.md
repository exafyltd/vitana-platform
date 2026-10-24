# Sparring round 3 — escalated

Session: `fca982e6-f8a0-4fc9-8e6e-78d23ba39b48` · plan hash `2ebd4325364eb56ad1cda12df77257435e295843eb38ec0421c4944bc67db0ab`

## Summary

The revision is substantially improved and correctly addresses my prior findings: R1-F1 (one-notification=one-tenant, cross-tenant copy out of scope), R1-F2/F4 (flag-flip read/write hazard explicitly mitigated in Risks), and R1-F3 (isHealthTable imported, inventory committed as fixture). R2-F1 is correctly accepted and given a concrete disposition (signature change). I verified the core premises against the pinned code and they hold. Two issues remain: (1) the R2-F1 disposition keeps `.single()` on `fetchVitanaIndexScoreForDate`, which will throw PGRST116 for any user whose scores exist under multiple tenants for the same date — the exact split-data scenario this spec fixes — and needs an explicit `.single()`→`.maybeSingle()` change plus null-handling; (2) the wearables "already user-keyed" classification (b) blesses tenant-unaware wearable reads without canonicalization, an inconsistency with the tenant-keyed health invariant.

## Findings

### R3-F1 [major]

The R2-F1 disposition changes fetchVitanaIndexScoreForDate's signature to (sb, userId, date) filtering user_id + home tenant, but does not address the `.single()` at health-repository.ts:52. `.single()` asserts EXACTLY one row; for a dual member with vitana_index_scores rows written under two tenant_ids for the same date (the split-write hazard this whole spec exists to remedy, and which the sibling reader health-action-initiative-repository.ts:53-54 filters by tenant_id+user_id+date with `.maybeSingle()` — proving the table is (tenant,user,date)-keyed), the converted /summary query filtered by home tenant + user_id can return either zero rows (score stored under the other tenant) or, if tenant filter is dropped, throw PGRST116 on multiple rows. Either way the current `.single()` semantics break the moment the accessor conversion lands for a dual member.

- `exafyltd/vitana-platform:services/gateway/src/routes/health-repository.ts:51` — export async function fetchVitanaIndexScoreForDate(sb: SupabaseClient, date: string) { return sb.from('vitana_index_scores').select('*').eq('date', date).single(); }
- `exafyltd/vitana-platform:services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts:53` — export async function fetchVitanaIndexScoreForDate(sb, tenantId, userId, date) { return sb.from('vitana_index_scores').select('score_total').eq('tenant_id', tenantId).eq('user_id', userId).eq('date', date).maybeSingle(); }
- `exafyltd/vitana-platform:supabase/migrations/20260423081500_vitana_index_scores_rls_simplify.sql:33` — CREATE POLICY vitana_index_scores_user_policy ON public.vitana_index_scores FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

Suggestion: Extend the R2-F1 disposition explicitly: change `.single()` to `.maybeSingle()` in the converted reader, and state the intended semantics for a dual member whose score for a date lives under a non-home tenant (return the home-tenant row if present, else null rather than error — never the non-home tenant's row). Add a test: ab_dual with a score under T_A and none under home tenant → /summary returns null (or the merged home view), and does NOT throw. This prevents a runtime 500 on the member-facing /summary endpoint at flag-flip time.

### R3-F2 [minor]

The inventory classifies wearable_rollup_7d and wearable_daily_metrics as '(b) already user-keyed, no injection', but these readers filter by user_id ONLY with no tenant_id at all (routes/wearables-repository.ts:71-81). This means wearable rollup/daily metrics are currently tenant-unaware: the same rows are visible in whichever tenant session the user is in, with no home-tenant canonicalization like every other health series gets in this spec. Blessing them as (b) without comment silently contradicts the program invariant that 'health identity is keyed by tenant' (premise 1), and the lineage guard the spec adds does not cover these because they are user-keyed, not tenant-scoped.

- `exafyltd/vitana-platform:services/gateway/src/routes/wearables-repository.ts:71` — export async function fetchWearableRollup7d(sb, userId) { return sb.from('wearable_rollup_7d').select('*').eq('user_id', userId).maybeSingle(); } export async function fetchRecentWearableDailyMetrics(sb, userId, limit) { return sb.from('wearable_daily_metrics').select(...).eq('user_id', userId)... }

Suggestion: Add an explicit note to the inventory's (b) category explaining WHY wearable rollup/daily metrics are intentionally tenant-unaware (e.g. they are a cross-tenant personal aggregate owned by the device owner, not tenant data), or reclassify them as needing a tenant column with a separate decision. As written, the classification is a silent exception to the tenant-keyed invariant the rest of the spec enforces.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The disposition is correct and accounted for the sole caller being member-facing (not service-role). The signature-change approach is coherent with the sibling reader. One residual gap is re-raised as R3-F1 (the .single() semantics under the conversion).
- R1-F1: acknowledged — The revision correctly narrows the contract to one-notification=one-tenant and explicitly scopes per-tenant copy out. The across-tenant fetch only widens device reach; payload stays caller-built. Sound.
- R1-F2: acknowledged — The risk statement now accurately describes the off-state limit(1).maybeSingle() fallback as non-deterministic for dual members and gates the flip on backfill post-check. Sound.
- R1-F4: acknowledged — Writers and readers now convert together in one PR behind one flag, with the split-write hazard documented (rows outside home tenant left unread, merge deferred to Health Hub). Sound.
- R1-F3: acknowledged — The guard now imports isHealthTable from mt-identity (no local list) and commits the inventory as a fixture that is regenerated each build, so predicate and inventory cannot silently diverge. Sound.
