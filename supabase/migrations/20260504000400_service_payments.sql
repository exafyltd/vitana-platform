-- Dance specialized market — Phase D1.5 (VTID-DANCE-D1)
-- Sketched-but-empty service_payments table from the original plan, now
-- shaped for Stripe Connect escrow on paid lessons (Phase D6 wires the
-- Stripe webhook + escrow state machine; this migration just lands the
-- schema so D6 can build on it).

CREATE TABLE IF NOT EXISTS public.service_payments (
  payment_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_vitana_id    text NOT NULL,
  payee_vitana_id    text NOT NULL,
  match_id           uuid REFERENCES public.intent_matches(match_id) ON DELETE SET NULL,
  external_ref       jsonb,            -- { kind: 'live_room'|'meetup', id: '<uuid>' } when paying for an event seat rather than a 1:1 match
  amount_cents       int NOT NULL CHECK (amount_cents > 0),
  currency           text NOT NULL DEFAULT 'EUR',
  fee_basis_points   int,              -- platform fee bps; resolved via entitlements helper at booking time
  stripe_pi_id       text,             -- payment intent id
  stripe_transfer_id text,             -- payout to seller's connected account
  state              text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','authorized','captured','released','refunded','disputed','cancelled')),
  escrow_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_payments_payee_idx ON public.service_payments (payee_vitana_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_payments_payer_idx ON public.service_payments (payer_vitana_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_payments_state_idx ON public.service_payments (state, escrow_until)
  WHERE state IN ('authorized','captured');

COMMENT ON TABLE public.service_payments IS
  'Stripe Connect escrow ledger for paid lessons (intent matches) and paid events (live_rooms/meetups). Phase D6 wires the webhook + state machine; this is the schema-only foundation.';
