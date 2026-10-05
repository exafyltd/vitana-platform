-- VTID-04741 (follow-up 4): confirm_recommendation_commission() refreshes
-- the commission's amounts from the order at the moment of payment. A network
-- can correct an order's commission or currency after the pending row was
-- written (e.g. a retry after a missing wallet), so the payout is recomputed
-- from the order's current commission_cents and currency at the row's
-- recorded rate_applied (never today's settings) inside the same locked
-- transaction (Codex review of #3820). CREATE OR REPLACE only.

CREATE OR REPLACE FUNCTION public.confirm_recommendation_commission(p_commission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row         recommendation_commissions%ROWTYPE;
  v_order_state text;
  v_order_cents integer;
  v_currency    text;
  v_payout      bigint;
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

  -- The order must still be a sale at the moment of payment. The order row is
  -- locked too, so a cancellation that commits first is seen here (nothing
  -- is paid) and one that arrives later waits for this payment to commit,
  -- then reverses it as paid. Lock order: commission, then order; nothing
  -- locks them the other way round.
  SELECT state, commission_cents, upper(coalesce(currency, 'EUR'))
    INTO v_order_state, v_order_cents, v_currency
    FROM product_orders WHERE id = v_row.product_order_id FOR UPDATE;
  IF v_order_state IS DISTINCT FROM 'converted' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'order_not_converted', 'order_state', v_order_state);
  END IF;

  -- The amounts follow the order as it is NOW (a network may correct the
  -- commission or currency after the row was written), at the rate recorded
  -- when the commission was made — never today's settings.
  v_payout := round(coalesce(v_order_cents, 0) * v_row.rate_applied)::bigint;
  IF v_payout <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'status', 'order_no_commission');
  END IF;
  IF v_payout <> v_row.payout_amount_minor OR v_currency <> v_row.currency
     OR v_order_cents <> v_row.vitana_commission_cents THEN
    UPDATE recommendation_commissions
       SET payout_amount_minor = v_payout, currency = v_currency, vitana_commission_cents = v_order_cents
     WHERE id = v_row.id;
    v_row.payout_amount_minor := v_payout;
    v_row.currency := v_currency;
    v_row.vitana_commission_cents := v_order_cents;
  END IF;

  -- Test, service and automation accounts can never earn (CLAUDE.md NEVER
  -- rules 43-45). Checked again here because an account can be registered
  -- as one during the hold; such a commission is closed, never paid.
  IF EXISTS (SELECT 1 FROM service_bot_accounts WHERE user_id = v_row.recommender_user_id)
     OR EXISTS (SELECT 1 FROM notification_test_actors WHERE user_id = v_row.recommender_user_id) THEN
    UPDATE recommendation_commissions
       SET status = 'skipped_ineligible', reversal_reason = 'excluded_account'
     WHERE id = v_row.id;
    INSERT INTO oasis_events (topic, service, role, source, status, message, metadata)
    VALUES ('marketplace.recommendation.commission_skipped_invalid_referral', 'discover', 'GATEWAY', 'recommendation-commissions',
            'info', 'referral does not count: excluded_account (at confirmation)',
            jsonb_build_object('orderId', v_row.product_order_id, 'commissionId', v_row.id,
                               'recommenderId', v_row.recommender_user_id, 'reason', 'excluded_account'));
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_excluded_account');
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
