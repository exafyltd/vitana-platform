-- VTID-04741 — recommender commissions are held, then confirmed or reversed.
-- docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md §8.5 (plan step 4).
--
-- Until now a converted order credited the recommender's wallet immediately and
-- nothing ever reversed it. Now:
--   pending   → a conversion exists; nothing paid yet; confirm_after set
--   credited  → confirmed and paid to the wallet (confirmed_at)
--   reversed  → the order was refunded/cancelled/charged back before payment
-- A network-approved conversion (e.g. Awin approved) is already past the
-- retailer's return window and confirms at once; other conversions wait the
-- configured window.
--
-- Live data at authoring time: 0 recommendation_commissions rows.

ALTER TABLE public.recommendation_commissions
  DROP CONSTRAINT IF EXISTS recommendation_commissions_status_check;
ALTER TABLE public.recommendation_commissions
  ADD CONSTRAINT recommendation_commissions_status_check
  CHECK (status IN ('pending', 'credited', 'skipped_ineligible', 'failed', 'reversed'));

ALTER TABLE public.recommendation_commissions
  ADD COLUMN IF NOT EXISTS confirm_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_recommendation_commissions_due
  ON public.recommendation_commissions (confirm_after)
  WHERE status = 'pending';

-- Return window for conversions a network has not already approved.
INSERT INTO public.admin_settings (key, value)
VALUES ('recommendation_commission_return_window_days', '{"days": 30}'::jsonb)
ON CONFLICT (key) DO NOTHING;
