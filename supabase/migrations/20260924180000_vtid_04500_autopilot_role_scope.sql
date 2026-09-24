-- VTID-04500 (Community Autopilot CA-2): give every Autopilot suggestion a real role_scope.
--
-- role_scope existed (default 'any') but nothing ever set it, so every row —
-- a member's personal suggestion and a Dev Autopilot finding alike — read as
-- 'any'. This backfills existing rows and sets the scope on every future insert,
-- whichever writer inserts (the TypeScript generator, the SQL analyzers, the
-- onboarding seed, the dev scanners).
--
--   source_type = 'community'            -> 'community'
--   user_id IS NULL (system findings)    -> 'developer'
--   anything else                        -> left as written
--
-- Additive and idempotent: only rows still at 'any' (or NULL) are touched.

UPDATE public.autopilot_recommendations
   SET role_scope = 'community'
 WHERE source_type = 'community'
   AND (role_scope IS NULL OR role_scope = 'any');

UPDATE public.autopilot_recommendations
   SET role_scope = 'developer'
 WHERE user_id IS NULL
   AND source_type IS DISTINCT FROM 'community'
   AND (role_scope IS NULL OR role_scope = 'any');

CREATE OR REPLACE FUNCTION public.autopilot_recommendations_set_role_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF NEW.role_scope IS NULL OR NEW.role_scope = 'any' THEN
    IF NEW.source_type = 'community' THEN
      NEW.role_scope := 'community';
    ELSIF NEW.user_id IS NULL THEN
      NEW.role_scope := 'developer';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopilot_recommendations_role_scope ON public.autopilot_recommendations;
CREATE TRIGGER trg_autopilot_recommendations_role_scope
  BEFORE INSERT ON public.autopilot_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.autopilot_recommendations_set_role_scope();

COMMENT ON FUNCTION public.autopilot_recommendations_set_role_scope() IS
  'VTID-04500: community suggestions get role_scope=community, system findings (user_id NULL) get developer, on insert.';
