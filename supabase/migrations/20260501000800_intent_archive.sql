-- Vitana Intent Engine — P2-A · 9/9
-- VTID-01973
--
-- Archive table scaffolding. P2-A creates the table only — the lazy
-- archival job (scan intent_matches for state IN ('closed','fulfilled',
-- 'declined') AND created_at < now() - interval '90 days', move to
-- archive, delete from live) lands in P2-C.
--
-- Same shape as intent_matches so the archive can be queried with the
-- same SQL when support engineers need a long-tail lookup.

CREATE TABLE IF NOT EXISTS public.intent_matches_archive (
  match_id                    uuid PRIMARY KEY,
  intent_a_id                 uuid,
  intent_b_id                 uuid,
  vitana_id_a                 text,
  vitana_id_b                 text,
  external_target_kind        text,
  external_target_id          uuid,
  kind_pairing                text,
  score                       numeric(4,3),
  match_reasons               jsonb,
  compass_aligned             boolean,
  surfaced_to_a_at            timestamptz,
  surfaced_to_b_at            timestamptz,
  mutual_reveal_unlocked_at   timestamptz,
  state                       text,
  created_at                  timestamptz,
  updated_at                  timestamptz,
  archived_at                 timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.intent_matches_archive IS
  'Lazy archive for closed/fulfilled/declined intent_matches older than 90 days. Populated by a scheduled job in P2-C. Same column shape as intent_matches plus archived_at.';

CREATE INDEX IF NOT EXISTS intent_matches_archive_vitana_a_idx
  ON public.intent_matches_archive (vitana_id_a, archived_at DESC)
  WHERE vitana_id_a IS NOT NULL;

CREATE INDEX IF NOT EXISTS intent_matches_archive_vitana_b_idx
  ON public.intent_matches_archive (vitana_id_b, archived_at DESC)
  WHERE vitana_id_b IS NOT NULL;

-- Read-only RLS. Owners can read their archived matches by either side.
ALTER TABLE public.intent_matches_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY intent_matches_archive_read ON public.intent_matches_archive
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_intents ia
       WHERE ia.intent_id = intent_matches_archive.intent_a_id
         AND ia.requester_user_id = auth.uid()
    )
    OR
    (intent_b_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_intents ib
       WHERE ib.intent_id = intent_matches_archive.intent_b_id
         AND ib.requester_user_id = auth.uid()
    ))
  );
