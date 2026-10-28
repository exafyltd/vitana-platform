-- VTID-05055 — Health Hub Phase 0 / D8: a partner health link is created only
-- when the MEMBER confirms it.
--
-- Until now POST /api/v1/admin/partner-health/inbox/:id/confirm-match wrote a
-- partner_customer_links row AND a partner_health_test_orders row for whatever
-- user id staff typed in. The member was never asked, and the order reached
-- their orders list, calendar (VTID-04997 trigger), ORB tools and wake brief
-- at once. From now on staff only PROPOSE (member_link_status =
-- 'pending_member'); the gateway notifies the member; the link + order are
-- created by fn_confirm_partner_link_request() below, called by the gateway
-- when the member confirms in the app.
--
-- Additive only: new nullable columns, one partial index, one function, one
-- notification-type seed. No drops, no RLS policy changes (the inbox stays
-- service-role only, VTID-03885), no backfill: links created before this
-- change stay as they are (owner decision 2026-10-10).

-- 1. Proposal columns on the quarantine inbox ------------------------------
ALTER TABLE public.partner_health_result_inbox
  ADD COLUMN IF NOT EXISTS member_link_status TEXT
    CHECK (member_link_status IN ('pending_member', 'confirmed', 'declined')),
  ADD COLUMN IF NOT EXISTS proposed_user_id UUID,
  ADD COLUMN IF NOT EXISTS proposed_tenant_id UUID,
  ADD COLUMN IF NOT EXISTS proposed_test_name TEXT,
  ADD COLUMN IF NOT EXISTS proposed_external_order_ref TEXT,
  ADD COLUMN IF NOT EXISTS proposed_by_admin_id UUID,
  ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS member_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS member_declined_user_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.partner_health_result_inbox.member_link_status IS 'VTID-05055: NULL = no proposal; pending_member = staff proposed a member, waiting for that member; confirmed = the member confirmed (link + order created by fn_confirm_partner_link_request); declined = the member said "not me" (row stays unresolved in the staff inbox).';
COMMENT ON COLUMN public.partner_health_result_inbox.proposed_user_id IS 'VTID-05055: the member staff proposed for this result. Only this user can confirm or decline.';
COMMENT ON COLUMN public.partner_health_result_inbox.proposed_tenant_id IS 'VTID-05055: tenant of the proposal. Membership is re-checked inside fn_confirm_partner_link_request.';
COMMENT ON COLUMN public.partner_health_result_inbox.proposed_test_name IS 'VTID-05055: test_name the order gets when the member confirms.';
COMMENT ON COLUMN public.partner_health_result_inbox.proposed_external_order_ref IS 'VTID-05055: external_order_ref the order gets when the member confirms.';
COMMENT ON COLUMN public.partner_health_result_inbox.proposed_by_admin_id IS 'VTID-05055: the staff member who proposed the link. Never returned to the member.';
COMMENT ON COLUMN public.partner_health_result_inbox.proposed_at IS 'VTID-05055: when the proposal was made.';
COMMENT ON COLUMN public.partner_health_result_inbox.member_decided_at IS 'VTID-05055: when the member confirmed or declined.';
COMMENT ON COLUMN public.partner_health_result_inbox.member_declined_user_ids IS 'VTID-05055: every member who declined this row; staff cannot propose the same member again.';

-- 2. Member reads are scoped by user ---------------------------------------
CREATE INDEX IF NOT EXISTS partner_health_result_inbox_pending_member_idx
  ON public.partner_health_result_inbox (proposed_user_id)
  WHERE member_link_status = 'pending_member';

-- 3. The member's confirm, in one transaction ------------------------------
-- Writes exactly what confirm-match wrote before VTID-05055 (link with
-- match_confidence 'manual_confirmed' + order with status 'processing' +
-- inbox resolution), but from the stored proposal and only for the proposed
-- member. Any error rolls the whole function back, so the row stays
-- 'pending_member' and the member can retry.
CREATE OR REPLACE FUNCTION public.fn_confirm_partner_link_request(p_inbox_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row      public.partner_health_result_inbox%ROWTYPE;
  v_link_id  uuid;
  v_order_id uuid;
  v_now      timestamptz := now();
BEGIN
  SELECT * INTO v_row
    FROM public.partner_health_result_inbox
   WHERE id = p_inbox_id
     AND proposed_user_id = p_user_id
     AND member_link_status = 'pending_member'
     AND resolved = false
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_tenants ut
     WHERE ut.user_id = p_user_id
       AND ut.tenant_id = v_row.proposed_tenant_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_in_tenant');
  END IF;

  INSERT INTO public.partner_customer_links (
    tenant_id, user_id, partner_id, external_customer_ref,
    match_confidence, matched_by_admin_id, matched_at, raw
  ) VALUES (
    v_row.proposed_tenant_id,
    p_user_id,
    v_row.partner_id,
    CASE WHEN jsonb_typeof(v_row.raw_payload -> 'external_customer_ref') = 'string'
         THEN v_row.raw_payload ->> 'external_customer_ref' END,
    'manual_confirmed',
    v_row.proposed_by_admin_id,
    v_now,
    v_row.raw_payload
  )
  RETURNING id INTO v_link_id;

  INSERT INTO public.partner_health_test_orders (
    tenant_id, user_id, partner_id, partner_customer_link_id,
    external_order_ref, test_name, status
  ) VALUES (
    v_row.proposed_tenant_id,
    p_user_id,
    v_row.partner_id,
    v_link_id,
    v_row.proposed_external_order_ref,
    v_row.proposed_test_name,
    'processing'
  )
  RETURNING id INTO v_order_id;

  UPDATE public.partner_health_result_inbox
     SET member_link_status   = 'confirmed',
         resolved             = true,
         resolved_by_admin_id = v_row.proposed_by_admin_id,
         resolved_order_id    = v_order_id,
         resolved_at          = v_now,
         member_decided_at    = v_now
   WHERE id = v_row.id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id, 'link_id', v_link_id);
END;
$$;

COMMENT ON FUNCTION public.fn_confirm_partner_link_request(uuid, uuid) IS 'VTID-05055: the member confirms a staff-proposed partner link. Locks the inbox row, re-checks tenant membership, creates the link + order and resolves the row in one transaction. Called only by the gateway (service_role).';

REVOKE ALL ON FUNCTION public.fn_confirm_partner_link_request(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_confirm_partner_link_request(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_confirm_partner_link_request(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirm_partner_link_request(uuid, uuid) TO service_role;

-- 4. Switch on the partner_link_request notification ------------------------
-- Same shape as VTID-04926: without this the VTID-04674 guard auto-registers
-- the type as OFF on first send and the member never hears about the request.
-- Approved with the VTID-05055 plan (owner, 2026-10-10). Idempotent; an admin
-- who later turns it off keeps it off, except a row the guard auto-registered
-- as off before this migration ran, which is switched on.
INSERT INTO public.notification_type_controls (tenant_id, type, source_key, enabled, reason)
SELECT t.tenant_id, x.type, '', true, 'VTID-05055: member confirms a partner health link (owner-approved plan)'
  FROM public.tenants t
 CROSS JOIN (VALUES ('partner_link_request')) AS x(type)
ON CONFLICT (tenant_id, type, source_key) DO NOTHING;

UPDATE public.notification_type_controls
   SET enabled = true,
       auto_registered = false,
       reason = 'VTID-05055: member confirms a partner health link (owner-approved plan)',
       updated_at = now()
 WHERE type IN ('partner_link_request')
   AND source_key = ''
   AND auto_registered = true
   AND enabled = false;
