-- =============================================================================
-- VTID-04859: Founding 1000 — the first 1,000 members get a free Premium year
-- =============================================================================
-- Owner decisions 2026-10-01 (rewards & engagement plan, Phase 2;
-- docs/business-model/BUSINESS-MODEL.md §11):
--   * the first 1,000 members receive a full year of Premium, announced as
--     worth EUR 119.88 (12 x EUR 9.99); cost ceiling accepted.
--
-- What this migration does
--   1. founding_members — one row per Founding Member: their seat number
--      (1..1000, in signup order), how their year is covered, when it ends,
--      and when they saw the celebration (celebrated_at).
--   2. claim_founding_seat(user, tenant) — assigns the next seat and grants
--      the year, idempotently (a second call returns the same seat):
--        * registered test/service accounts (service_bot_accounts,
--          notification_test_actors, e2e-%@% / @vitanatest.exafy.io
--          addresses, the system bot) never get a seat
--          (CLAUDE.md rules 43-45);
--        * an active Stripe subscription is never overwritten: seat only
--          (grant_source 'stripe_active');
--        * a member who already received the 12-month launch grant keeps it
--          and is not extended (grant_source 'launch_auto_grant_2026');
--        * everyone else gets Premium until max(current end, now + 365 days)
--          (grant_source 'founding_1000').
--      Seats are serialised with an advisory lock, so two signups can never
--      take the same number, and the 1,001st member gets SOLD_OUT.
--   3. A trigger on user_tenants (primary membership, same shape as
--      welcome_chat_on_primary_membership) claims the seat at signup. It can
--      never block the membership insert.
--   4. Backfill: every existing primary member, in signup order.
--   5. mark_founding_celebrated(user) — the app calls it (through the
--      gateway) when the member closes the celebration.
--   6. The old FOUNDING code (first 500, 90 days, never redeemed) is
--      deactivated: the founding year is automatic, no code needed.
--
-- Apply: RUN-MIGRATION.yml (workflow_dispatch), after approval. The backfill
-- grants Premium to existing members without a subscription.
-- =============================================================================

BEGIN;

-- 1. Table ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.founding_members (
  user_id        uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  seat_number    integer NOT NULL UNIQUE CHECK (seat_number BETWEEN 1 AND 1000),
  grant_source   text NOT NULL CHECK (grant_source IN ('founding_1000', 'launch_auto_grant_2026', 'stripe_active')),
  granted_until  timestamptz,
  value_cents    integer NOT NULL DEFAULT 11988,
  celebrated_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.founding_members IS
  'VTID-04859: the first 1,000 members (Founding Members). seat_number in signup order; value_cents = 12 x EUR 9.99.';

ALTER TABLE public.founding_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS founding_members_select_own ON public.founding_members;
CREATE POLICY founding_members_select_own ON public.founding_members
  FOR SELECT USING (auth.uid() = user_id);
REVOKE ALL ON public.founding_members FROM anon, authenticated;
GRANT SELECT ON public.founding_members TO authenticated;
GRANT ALL ON public.founding_members TO service_role;

-- 2. claim_founding_seat ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_founding_seat(
  p_user_id   uuid,
  p_tenant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_max_seats   constant integer := 1000;
  v_existing    public.founding_members%ROWTYPE;
  v_tenant_id   uuid := p_tenant_id;
  v_sub         public.user_subscriptions%ROWTYPE;
  v_seat        integer;
  v_source      text;
  v_until       timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'USER_REQUIRED');
  END IF;

  SELECT * INTO v_existing FROM public.founding_members WHERE user_id = p_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true,
      'seat_number', v_existing.seat_number, 'max_seats', v_max_seats,
      'grant_source', v_existing.grant_source, 'granted_until', v_existing.granted_until,
      'value_cents', v_existing.value_cents, 'celebrated_at', v_existing.celebrated_at
    );
  END IF;

  IF p_user_id = '00000000-0000-0000-0000-000000000001'::uuid
     OR EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = p_user_id)
     -- Same e2e address patterns _notif_is_test_actor() treats as test accounts.
     OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id
                AND (u.email ILIKE 'e2e-%@%' OR u.email ILIKE '%@vitanatest.exafy.io')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_ELIGIBLE');
  END IF;

  IF v_tenant_id IS NULL THEN
    SELECT tenant_id INTO v_tenant_id
    FROM public.user_tenants
    WHERE user_id = p_user_id AND is_primary = true
    LIMIT 1;
  END IF;
  IF v_tenant_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_TENANT');
  END IF;

  -- One seat at a time, platform-wide.
  PERFORM pg_advisory_xact_lock(hashtext('vtid_04859_founding_1000'));

  -- Re-check under the lock (a concurrent call for the same member).
  SELECT * INTO v_existing FROM public.founding_members WHERE user_id = p_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true,
      'seat_number', v_existing.seat_number, 'max_seats', v_max_seats,
      'grant_source', v_existing.grant_source, 'granted_until', v_existing.granted_until,
      'value_cents', v_existing.value_cents, 'celebrated_at', v_existing.celebrated_at
    );
  END IF;

  SELECT COALESCE(max(seat_number), 0) + 1 INTO v_seat FROM public.founding_members;
  IF v_seat > v_max_seats THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SOLD_OUT', 'max_seats', v_max_seats);
  END IF;

  SELECT * INTO v_sub
  FROM public.user_subscriptions
  WHERE tenant_id = v_tenant_id AND user_id = p_user_id
  FOR UPDATE;

  IF v_sub.user_id IS NOT NULL
     AND v_sub.stripe_subscription_id IS NOT NULL
     AND v_sub.status IN ('active', 'trialing', 'past_due') THEN
    -- A paying member keeps their subscription untouched.
    v_source := 'stripe_active';
    v_until  := v_sub.current_period_end;
  ELSIF v_sub.user_id IS NOT NULL
     AND v_sub.metadata->>'source' = 'launch_auto_grant_2026'
     AND v_sub.status = 'active'
     AND v_sub.current_period_end > now() THEN
    -- Already received a full free year at launch; not extended.
    v_source := 'launch_auto_grant_2026';
    v_until  := v_sub.current_period_end;
  ELSE
    v_source := 'founding_1000';
    v_until  := GREATEST(
      COALESCE(CASE WHEN v_sub.status = 'active' THEN v_sub.current_period_end END, now()),
      now() + interval '365 days'
    );

    INSERT INTO public.user_subscriptions (
      tenant_id, user_id, plan_key, status,
      current_period_start, current_period_end, metadata
    ) VALUES (
      v_tenant_id, p_user_id, 'premium', 'active',
      now(), v_until,
      jsonb_build_object('source', 'founding_1000', 'seat_number', v_seat, 'vtid', 'VTID-04859')
    )
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
      plan_key             = 'premium',
      status               = 'active',
      current_period_end   = EXCLUDED.current_period_end,
      cancel_at_period_end = false,
      metadata             = public.user_subscriptions.metadata
                             || jsonb_build_object('source', 'founding_1000', 'seat_number', v_seat, 'vtid', 'VTID-04859'),
      updated_at           = now();

    INSERT INTO public.paywall_events (tenant_id, user_id, feature_key, action, current_plan, context)
    VALUES (
      v_tenant_id, p_user_id, 'subscription', 'redeemed', 'premium',
      jsonb_build_object('campaign', 'founding_1000', 'seat_number', v_seat,
                         'granted_until', v_until, 'grant_value_cents', 11988)
    );
  END IF;

  INSERT INTO public.founding_members (user_id, tenant_id, seat_number, grant_source, granted_until)
  VALUES (p_user_id, v_tenant_id, v_seat, v_source, v_until);

  RETURN jsonb_build_object(
    'ok', true, 'already', false,
    'seat_number', v_seat, 'max_seats', v_max_seats,
    'grant_source', v_source, 'granted_until', v_until,
    'value_cents', 11988, 'celebrated_at', NULL
  );
END;
$fn$;

COMMENT ON FUNCTION public.claim_founding_seat(uuid, uuid) IS
  'VTID-04859: idempotent Founding seat + free Premium year (first 1,000 members). Service role only.';
REVOKE ALL ON FUNCTION public.claim_founding_seat(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_founding_seat(uuid, uuid) TO service_role;

-- 3. Seat at signup ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_founding_seat_on_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.claim_founding_seat(NEW.user_id, NEW.tenant_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block the membership insert. Surface to logs for ops.
  RAISE WARNING '[founding_1000] claim failed for user % tenant %: % / %',
    NEW.user_id, NEW.tenant_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS founding_seat_on_primary_membership ON public.user_tenants;
CREATE TRIGGER founding_seat_on_primary_membership
  AFTER INSERT ON public.user_tenants
  FOR EACH ROW WHEN (NEW.is_primary = true)
  EXECUTE FUNCTION public.claim_founding_seat_on_membership();

-- 4. mark_founding_celebrated ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_founding_celebrated(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_at timestamptz;
BEGIN
  UPDATE public.founding_members
     SET celebrated_at = COALESCE(celebrated_at, now())
   WHERE user_id = p_user_id
  RETURNING celebrated_at INTO v_at;
  IF v_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_A_FOUNDING_MEMBER');
  END IF;
  RETURN jsonb_build_object('ok', true, 'celebrated_at', v_at);
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_founding_celebrated(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_founding_celebrated(uuid) TO service_role;

-- 5. Retire the old FOUNDING code ------------------------------------------------------
UPDATE public.redemption_codes
   SET is_active = false,
       metadata  = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('superseded_by', 'founding_1000', 'superseded_vtid', 'VTID-04859'),
       updated_at = now()
 WHERE campaign = 'founding_500' AND is_active;

-- 6. Backfill existing members in signup order ------------------------------------------
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ut.user_id, ut.tenant_id
    FROM public.user_tenants ut
    LEFT JOIN public.app_users au ON au.user_id = ut.user_id
    WHERE ut.is_primary = true
    ORDER BY COALESCE(au.created_at, ut.created_at), ut.created_at, ut.user_id
  LOOP
    PERFORM public.claim_founding_seat(r.user_id, r.tenant_id);
  END LOOP;
END
$backfill$;

-- 7. Self-check ----------------------------------------------------------------------
DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.claim_founding_seat(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-04859: claim_founding_seat must not be executable by authenticated';
  END IF;
  IF has_table_privilege('authenticated', 'public.founding_members', 'UPDATE') THEN
    RAISE EXCEPTION 'VTID-04859: authenticated can UPDATE founding_members';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.founding_members fm
    WHERE fm.user_id IN (SELECT user_id FROM public.service_bot_accounts
                         UNION SELECT user_id FROM public.notification_test_actors
                         UNION SELECT id FROM auth.users
                               WHERE email ILIKE 'e2e-%@%' OR email ILIKE '%@vitanatest.exafy.io')
  ) THEN
    RAISE EXCEPTION 'VTID-04859: a test/service account received a Founding seat';
  END IF;
END
$check$;

COMMIT;
