-- D10 hotfix: direct_share rows fail the original intent_matches_check
-- constraint because they have intent_b_id=null AND external_target_kind=null
-- (no internal pairing, no external target — just a vitana_id_b recipient).
--
-- Relax the constraint to admit a third valid shape: kind_pairing='direct_share'
-- AND vitana_id_b IS NOT NULL.

ALTER TABLE public.intent_matches
  DROP CONSTRAINT IF EXISTS intent_matches_check;

ALTER TABLE public.intent_matches
  ADD CONSTRAINT intent_matches_check
  CHECK (
    (intent_b_id IS NOT NULL AND external_target_kind IS NULL)
    OR
    (intent_b_id IS NULL AND external_target_kind IS NOT NULL AND external_target_id IS NOT NULL)
    OR
    (kind_pairing = 'direct_share' AND vitana_id_b IS NOT NULL)
  );

COMMENT ON CONSTRAINT intent_matches_check ON public.intent_matches IS
  'Original (P2-A): internal pairing OR external target, never both. D10: also allow direct_share rows where intent_b_id is null but vitana_id_b is set (the share recipient).';
