-- VTID-05156 rollback — by hand, owner's go only.
-- Restores the pre-VTID-05156 grant from
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql. The original migration
-- never granted PUBLIC or anon, so nothing else is restored.
-- Note: the gateway route POST /api/v1/health/wearables/ingest stays 410
-- until the code is rolled back too.
GRANT EXECUTE ON FUNCTION public.health_ingest_wearable_samples(jsonb) TO authenticated;
