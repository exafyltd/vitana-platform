# Responses to sparring round 2 (session 2, `b452b935-bde6-4df0-b1cc-646732601aa8`)

```json
[
  {
    "finding_id": "R3-F1",
    "disposition": "accepted",
    "rationale": "Verified services/gateway/src/services/automation-handlers/health-wellness-repository.ts:90-92: fetchActiveProductsByTopicKeys(sb, categories, limit) reads products by is_active + overlaps('topic_keys') with no tenant parameter; its only caller is AP-0615 runHealthAwareProductRecs (health-wellness.ts:271), where the automation context already destructures const { supabase, tenantId } = ctx (:261) and passes that tenant to the sibling fetchRecentRecommendations (:264). It was already listed as DISCOVERY in design 'What exists' and tasks P2; the plan now states the threading explicitly: the function gains a tenantId parameter fed from ctx.tenantId and goes through the discovery predicate, with no new tenant resolution path. The inventory sweep covers services/gateway/src/** and the build-failing lint fails if it stays unannotated. Citations corrected to the full automation-handlers path and :90-92 in plan.md Problem 10/Fix, design.md and tasks.md P2; discover-shared-predicate lane log.",
    "deferred_to": null
  },
  {
    "finding_id": "R3-F2",
    "disposition": "accepted",
    "rationale": "Verified: no CREATE FUNCTION public.is_member or public.tenant_id_for_policies exists in supabase/migrations/**; public.current_tenant_id() exists (20260218000000_fix_maxina_signup_tenant_association.sql:33, EXECUTE to authenticated and service_role :105-106) and the inline membership pattern exists (20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:65). Decision: this spec's migrations depend on no mt-identity function. supplier_tenant_relationships member read = inline EXISTS on user_tenants for auth.uid(). The products_select/merchants_select replacement = is_active AND (NOT public.discover_tenant_gate_enabled() OR distribution = 'network' OR EXISTS active relationship for merchant_id AND tenant_id = public.current_tenant_id()), where the new discover_tenant_gate_enabled() is STABLE SECURITY DEFINER with SET search_path = public, pg_catalog and returns coalesce(tenant_settings.feature_flags->'mt'->>'discover_tenant_gate', false) for current_tenant_id(), false for a NULL tenant or a missing row. Gate off (the default, every tenant today) => the policy equals today's is_active-only result; gate on with a NULL (signed-out) tenant => network rows only, never an error. pgTAP pins all three plus 'no is_member() reference'. Adopting mt-identity's helpers later is a tracked follow-up, and mt-identity is removed as a prerequisite in plan.md Depends on and requirements.md. Updated plan.md Fix/Tests/Depends on, design.md, tasks.md D1/D4, requirements.md, supplier-relationships-db lane log.",
    "deferred_to": null
  },
  {
    "finding_id": "R3-F3",
    "disposition": "accepted",
    "rationale": "Verified services/gateway/src/routes/discover-recommendations-repository.ts:22-23 fetchActiveProductForRecommendation reads products by id + is_active only, used by the Recommend & Earn share-link mint (routes/discover-recommendations.ts). design.md (:8) and tasks.md Allowed paths (:43) already carried the full path and classify it DISCOVERY; plan.md Problem 2 used the short form and now cites the full path, and tasks P2 states the intent: a T_B recommender cannot mint a share link for a T_A-only product.",
    "deferred_to": null
  }
]
```
