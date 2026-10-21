-- VTID-04741 (follow-up): confirm and reverse a held recommendation commission
-- in ONE transaction each.
--
-- Doing it as separate gateway calls left two gaps (Codex review of #3820):
--   * a crash between "mark credited" and the wallet credit left a commission
--     reading paid with no money moved, and nothing ever retried it;
--   * the "after-payout" warning could be marked as reported while the event
--     insert itself failed, so the exception went silent for good.
-- Both functions lock the commission row (FOR UPDATE), so a confirm and a
-- reversal of the same order serialize: whichever runs second sees the
-- other's result. A failure anywhere rolls the whole step back.
--
-- No table or data changes. Execute is granted to service_role only.

CREATE OR REPLACE FUNCTION public.confirm_recommendation_commission(p_commission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row         recommendation_commissions%ROWTYPE;
  v_order_state text;
  v_account_id  uuid;
  v_credit      jsonb;
  v_ledger_id   uuid;
BEGIN
  SELECT * INTO v_row FROM recommendation_commissions WHERE id = p_commission_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'not_pending', 'current_status', v_row.status);
  END IF;

  -- The order must still be a sale at the moment of payment.
  SELECT state INTO v_order_state FROM product_orders WHERE id = v_row.product_order_id;
  IF v_order_state IS DISTINCT FROM 'converted' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'order_not_converted', 'order_state', v_order_state);
  END IF;

  SELECT id INTO v_account_id
    FROM wallet_accounts
   WHERE user_id = v_row.recommender_user_id AND currency = upper(v_row.currency);
  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RECOMMENDER_WALLET_NOT_FOUND');
  END IF;

  v_credit := credit_wallet_for_earning(
    v_account_id,
    v_row.payout_amount_minor,
    upper(v_row.currency),
    'recommendation_commission',
    v_row.product_order_id::text,
    'Recommendation commission',
    jsonb_build_object(
      'product_recommendation_id', v_row.product_recommendation_id,
      'rate_applied', v_row.rate_applied,
      'vitana_commission_cents', v_row.vitana_commission_cents
    )
  );
  IF NOT coalesce((v_credit->>'ok')::boolean, false) THEN
    -- Nothing was written: the row stays pending for the next run.
    RETURN jsonb_build_object('ok', false, 'error', coalesce(v_credit->>'error', 'WALLET_CREDIT_FAILED'));
  END IF;

  v_ledger_id := nullif(v_credit->>'ledger_entry_id', '')::uuid;
  IF v_ledger_id IS NULL THEN
    -- Idempotent duplicate: the order was already credited once; record that entry.
    SELECT id INTO v_ledger_id
      FROM wallet_ledger_entries
     WHERE reference_type = 'recommendation_commission' AND reference_id = v_row.product_order_id::text
     LIMIT 1;
  END IF;

  UPDATE recommendation_commissions
     SET status = 'credited', confirmed_at = now(), wallet_ledger_entry_id = v_ledger_id
   WHERE id = v_row.id;

  PERFORM increment_product_recommendation_stats(v_row.product_recommendation_id, v_row.payout_amount_minor);

  RETURN jsonb_build_object('ok', true, 'status', 'credited', 'ledger_entry_id', v_ledger_id,
                            'duplicate', coalesce((v_credit->>'duplicate')::boolean, false));
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_recommendation_commission(p_order_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row  recommendation_commissions%ROWTYPE;
  v_paid boolean;
BEGIN
  SELECT * INTO v_row FROM recommendation_commissions WHERE product_order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'status', 'none');
  END IF;

  IF v_row.status = 'pending' THEN
    -- A wallet credit for this order means it was paid, whatever the row says.
    SELECT EXISTS (
      SELECT 1 FROM wallet_ledger_entries
       WHERE reference_type = 'recommendation_commission' AND reference_id = p_order_id::text
    ) INTO v_paid;
    IF NOT v_paid THEN
      UPDATE recommendation_commissions
         SET status = 'reversed', reversed_at = now(), reversal_reason = p_reason
       WHERE id = v_row.id;
      INSERT INTO oasis_events (topic, service, role, source, status, message, metadata)
      VALUES ('marketplace.recommendation.commission_reversed', 'discover', 'GATEWAY', 'recommendation-commissions',
              'info', 'recommendation commission reversed before payment: ' || p_reason,
              jsonb_build_object('orderId', p_order_id, 'commissionId', v_row.id, 'reason', p_reason));
      RETURN jsonb_build_object('ok', true, 'status', 'reversed');
    END IF;
  ELSIF v_row.status <> 'credited' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'already_final');
  END IF;

  -- Paid. Not clawed back here (clawback policy is architecture D-11): the
  -- exception is reported exactly once, and the marker and the event commit together.
  IF v_row.reversal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'status', 'paid_needs_clawback', 'reported', false);
  END IF;
  UPDATE recommendation_commissions SET reversal_reason = p_reason WHERE id = v_row.id;
  INSERT INTO oasis_events (topic, service, role, source, status, message, metadata)
  VALUES ('marketplace.recommendation.commission_reversal_after_payout', 'discover', 'GATEWAY', 'recommendation-commissions',
          'warning', 'order undone after the commission was paid: ' || p_reason,
          jsonb_build_object('orderId', p_order_id, 'commissionId', v_row.id, 'reason', p_reason));
  RETURN jsonb_build_object('ok', true, 'status', 'paid_needs_clawback', 'reported', true);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_recommendation_commission(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_recommendation_commission(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_recommendation_commission(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_recommendation_commission(uuid, text) TO service_role;
