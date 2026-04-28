-- Dance specialized market — Phase D10 (VTID-DANCE-D10)
-- Idempotency for direct intent-post shares: a sharer can't accidentally
-- spam a recipient by clicking Share twice. Additive partial UNIQUE index
-- on intent_matches over (intent_a_id, vitana_id_b) WHERE kind_pairing
-- = 'direct_share'. Doesn't conflict with the existing UNIQUE index on
-- (intent_a_id, intent_b_id, external_target_kind, external_target_id).

CREATE UNIQUE INDEX IF NOT EXISTS intent_matches_direct_share_uniq
  ON public.intent_matches (intent_a_id, vitana_id_b)
  WHERE kind_pairing = 'direct_share' AND vitana_id_b IS NOT NULL;

COMMENT ON INDEX public.intent_matches_direct_share_uniq IS
  'D10 share idempotency: a single intent can be direct-shared to a given vitana_id at most once.';
