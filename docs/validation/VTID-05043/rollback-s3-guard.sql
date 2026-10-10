-- VTID-05043 rollback for Migration A (20261010170000_vtid_05043_s3_membership_side_effect_guard.sql).
-- Recreates the four primary-membership triggers on public.user_tenants exactly as captured live
-- before apply (live-before.sql: WHEN ((new.is_primary = true)), same names, same functions) and
-- drops the helper. tenants.open_signup is kept (inert once Migration C is rolled back).
-- Run after rollback-s3-switch-tenant.sql and rollback-s3-backfill.sql.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS welcome_chat_on_primary_membership ON public.user_tenants;
CREATE TRIGGER welcome_chat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION public.fire_welcome_chat_on_membership();

DROP TRIGGER IF EXISTS founding_seat_on_primary_membership ON public.user_tenants;
CREATE TRIGGER founding_seat_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION public.claim_founding_seat_on_membership();

DROP TRIGGER IF EXISTS seed_onboarding_autopilot_on_primary_membership ON public.user_tenants;
CREATE TRIGGER seed_onboarding_autopilot_on_primary_membership AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION public.seed_onboarding_autopilot_on_membership();

DROP TRIGGER IF EXISTS trg_create_user_live_room ON public.user_tenants;
CREATE TRIGGER trg_create_user_live_room AFTER INSERT ON public.user_tenants FOR EACH ROW WHEN ((new.is_primary = true)) EXECUTE FUNCTION public.create_user_live_room();

DROP FUNCTION IF EXISTS public.membership_side_effects_suppressed();

COMMIT;
