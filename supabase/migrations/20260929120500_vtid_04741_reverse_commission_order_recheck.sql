-- VTID-04741 (follow-up 3): reverse_recommendation_commission() re-checks
-- the order inside its own transaction. The caller's read of the order can be
-- stale (a concurrent Awin sync may have moved it back to converted), so the
-- function locks the product_orders row (commission first, then order, the
-- same order confirm_recommendation_commission() uses) and reverses or reports
-- only while the order is still refunded / cancelled / charged back
-- (Codex review of #3820). CREATE OR REPLACE only: same signature, same
-- grants, no table changes.

CREATE OR REPLACE FUNCTION public.reverse_recommendation_commission(p_order_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row         recommendation_commissions%ROWTYPE;
  v_paid        boolean;
  v_order_state text;
BEGIN
  SELECT * INTO v_row FROM recommendation_commissions WHERE product_order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'status', 'none');
  END IF;

  -- The caller's read of the order can be stale (a later sync may have moved
  -- it back to converted). Lock the order and reverse only if it is still
  -- undone. Lock order: commission, then order (same as the confirm).
  SELECT state INTO v_order_state FROM product_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order_state IS NULL OR v_order_state NOT IN ('refunded', 'cancelled', 'chargeback') THEN
    RETURN jsonb_build_object('ok', true, 'status', 'order_not_reversing', 'order_state', v_order_state);
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
