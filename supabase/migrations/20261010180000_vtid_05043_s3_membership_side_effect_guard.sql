-- VTID-05043 (Track S / S3, Migration A of 3): membership side-effect guard + tenants.open_signup.
--
-- Apply order: A (this file) -> B (data-fixups/20261010180100_vtid_05043_s3_backfill_drifted_memberships.sql)
--              -> C (20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql),
-- in one RUN-MIGRATION session, after the owner approves (staging shares the production database).
--
-- 1. public.membership_side_effects_suppressed() reads the transaction-local setting
--    vitana.suppress_membership_side_effects. The four AFTER INSERT triggers on
--    public.user_tenants that fire on a new primary membership (welcome chat, founding seat,
--    onboarding autopilot seed, personal live room) get it in their WHEN clause, so a data
--    fix-up can insert memberships without messaging, seeding or seat-claiming for real members.
--    The guard lives in the WHEN clause, not in the four function bodies: re-emitting those
--    bodies risks reverting live drift (the welcome-chat function has two versions); the WHEN
--    clause touches no body. Trigger names, timing and functions are unchanged, so the
--    ci_welcome_* health RPC (checks the welcome trigger by name and tgenabled = 'O') stays green.
--    The setting is only ever set with set_config(..., true) — transaction-local. Never with
--    ALTER DATABASE / ALTER ROLE. The helper is SECURITY INVOKER and only reads that setting, so it
--    keeps the default EXECUTE: the trigger WHEN clause runs it as whichever role inserts the
--    membership (authenticated through switch_to_tenant_by_slug, service_role from the gateway).
-- 2. public.tenants.open_signup: which tenants a signed-in user may join by themselves through
--    switch_to_tenant_by_slug (Migration C). Exactly maxina and alkalma today.
--
-- Rollback: docs/validation/VTID-05043/rollback-s3-guard.sql (open_signup is kept, inert).

-- impact-allow-solo-migration: lands dark; the gateway code that relies on it ships in the
-- separate VTID-05043 PR3, merged only after this is applied.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.membership_side_effects_suppressed()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(current_setting('vitana.suppress_membership_side_effects', true), '') = 'on'
$$;

COMMENT ON FUNCTION public.membership_side_effects_suppressed() IS
  'VTID-05043: true while the transaction-local setting vitana.suppress_membership_side_effects '
  'is ''on'' (set_config(..., true) only). Used in the WHEN clause of the four primary-membership '
  'triggers on public.user_tenants so data fix-ups do not message, seed or claim seats.';

DROP TRIGGER IF EXISTS welcome_chat_on_primary_membership ON public.user_tenants;
CREATE TRIGGER welcome_chat_on_primary_membership
  AFTER INSERT ON public.user_tenants
  FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed())
  EXECUTE FUNCTION public.fire_welcome_chat_on_membership();

DROP TRIGGER IF EXISTS founding_seat_on_primary_membership ON public.user_tenants;
CREATE TRIGGER founding_seat_on_primary_membership
  AFTER INSERT ON public.user_tenants
  FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed())
  EXECUTE FUNCTION public.claim_founding_seat_on_membership();

DROP TRIGGER IF EXISTS seed_onboarding_autopilot_on_primary_membership ON public.user_tenants;
CREATE TRIGGER seed_onboarding_autopilot_on_primary_membership
  AFTER INSERT ON public.user_tenants
  FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed())
  EXECUTE FUNCTION public.seed_onboarding_autopilot_on_membership();

DROP TRIGGER IF EXISTS trg_create_user_live_room ON public.user_tenants;
CREATE TRIGGER trg_create_user_live_room
  AFTER INSERT ON public.user_tenants
  FOR EACH ROW
  WHEN (NEW.is_primary = true AND NOT public.membership_side_effects_suppressed())
  EXECUTE FUNCTION public.create_user_live_room();

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS open_signup boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.open_signup IS
  'VTID-05043: a signed-in user may join this tenant by themselves (switch_to_tenant_by_slug). '
  'false = membership only through an admin or an invitation.';

DO $$
DECLARE n int;
BEGIN
  UPDATE public.tenants SET open_signup = true WHERE slug IN ('maxina', 'alkalma');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN
    RAISE EXCEPTION 'VTID-05043: expected to open exactly 2 tenants (maxina, alkalma), updated %', n;
  END IF;
END $$;

COMMIT;
