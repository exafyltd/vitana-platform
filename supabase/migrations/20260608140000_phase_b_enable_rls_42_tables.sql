-- PHASE B: enable RLS on the 42 RLS-disabled public tables  (2026-06-08)
-- Mapping (grep of vitana-v1 + command-hub frontends + edge functions) showed only ONE of these
-- tables is read by a client: handle_aliases (anon, public profile page). The other 41 are touched
-- only by the gateway via service_role, which BYPASSES RLS — so enabling RLS (deny-all to clients)
-- closes the anon read exposure with zero app impact.

BEGIN;

-- 41 SERVER-ONLY tables: enable RLS with NO policy => deny-all to anon/authenticated -----------------
ALTER TABLE IF EXISTS public.bootstrap_cache              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.consolidator_runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.gemini_call_log              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_compass_boost         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_compatibility         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_kinds                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_match_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_scope_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_supply_seeded         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.intent_tier_required         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.livekit_test_cases           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.livekit_test_results         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.livekit_test_runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m04    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m05    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m06    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m07    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m08    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m09    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m10    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m11    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2026m12    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2027m01    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2027m02    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2027m03    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log_y2027m04    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory_audit_log             ENABLE ROW LEVEL SECURITY;  -- partitioned parent, if present (future partitions inherit)
ALTER TABLE IF EXISTS public.news_items                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.service_payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.test_cycles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.test_results                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.test_runs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_ratings                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_reputation              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.vitana_id_reserved           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.voice_architecture_reports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.voice_healing_dedupe         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.voice_healing_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.voice_healing_quarantine     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.voice_healing_shadow_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.voice_healing_spec_memory    ENABLE ROW LEVEL SECURITY;

-- 1 CLIENT-READ table: handle_aliases is read by anon on the public profile page --------------------
-- It is a public old_handle -> user_id resolver (no sensitive data). Enable RLS + public read.
ALTER TABLE IF EXISTS public.handle_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS handle_aliases_public_read ON public.handle_aliases;
CREATE POLICY handle_aliases_public_read ON public.handle_aliases
  FOR SELECT TO anon, authenticated USING (true);

COMMIT;
