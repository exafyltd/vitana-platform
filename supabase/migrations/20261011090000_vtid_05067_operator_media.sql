-- VTID-05067 — images pasted, dropped or picked into the Command Hub Operator Console.
--
-- operator_media: one row per stored image (the bytes live in the PRIVATE Supabase
-- Storage bucket `operator-media` at <user_id>/<thread_id>/<uuid>.<ext>; the bucket is
-- created through the Storage API by scripts/supabase/setup-operator-media-bucket.mjs,
-- never by an INSERT into storage.buckets). The gateway checks the owner here and
-- re-signs a 1-hour URL per view; URLs are never stored.
--
-- kiro_runs.attachments: the images a Kiro run was sent with ([{ media_id, mime_type }]).
-- Nullable and only written when a run has images, so runs started before this
-- migration (and the gateway before it is applied) are unaffected.
--
-- Service role only: RLS on, no policies, anon/authenticated revoked (the gateway reads
-- and writes; no client access). Admin-only Operator Console data.
-- impact-allow-solo-migration: new table + one nullable column read and written only by the gateway in the same PR.

CREATE TABLE IF NOT EXISTS public.operator_media (
  id           uuid PRIMARY KEY,
  user_id      text NOT NULL,
  thread_id    text NOT NULL,
  object_path  text NOT NULL UNIQUE,
  mime_type    text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_media_user_thread
  ON public.operator_media (user_id, thread_id, created_at DESC);

ALTER TABLE public.operator_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operator_media FROM anon, authenticated;

ALTER TABLE public.kiro_runs ADD COLUMN IF NOT EXISTS attachments jsonb;

COMMENT ON TABLE public.operator_media IS
  'VTID-05067: images pasted/dropped into the Command Hub Operator Console; bytes in the private Storage bucket operator-media. Service role only (gateway).';
COMMENT ON COLUMN public.kiro_runs.attachments IS
  'VTID-05067: the images the run was sent with, [{ media_id, mime_type }] (operator_media ids); null when none.';
