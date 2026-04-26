-- Vitana ID — Release A · 4/9
-- Schema additions: profiles columns, app_users mirror column, handle_aliases table, fuzzy index.
--
-- Note on NOT NULL ordering: vitana_id starts NULLABLE here. The backfill
-- migration (7/9) populates every existing row, then sets NOT NULL + CHECK.
-- This gives us a safe ordering: column-add → backfill → constraint.

-- 1. Profiles canonical columns.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS vitana_id text,
  ADD COLUMN IF NOT EXISTS vitana_id_locked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.vitana_id IS
  'Permanent global user identifier. Speakable, language-neutral, ASR-friendly. Single source of truth across all systems. Mirrored to app_users.vitana_id by trigger.';
COMMENT ON COLUMN public.profiles.vitana_id_locked IS
  'true once the user has confirmed their pick on the onboarding card. Once true, never reset. New endpoint /vitana-id/confirm rejects with 409 when already locked.';

-- Unique index on vitana_id (case-insensitive identity is enforced at write
-- via lowercase normalization in the generator and validator).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_vitana_id_unique_idx
  ON public.profiles (vitana_id);

-- 2. app_users mirror column. Read-replica only — populated by trigger from
-- profiles.vitana_id. Application code MUST NEVER write this directly.
-- (No UNIQUE constraint here: profiles.vitana_id is the source.)
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS vitana_id text;

COMMENT ON COLUMN public.app_users.vitana_id IS
  'Read-only mirror of profiles.vitana_id. Maintained by trigger profiles_vitana_id_mirror_to_app_users. Do not write from app code — will silently de-sync.';

-- 3. Legacy handle preservation. Every old name-based handle (e.g.
-- @draganalexander) lands here so existing /profiles/<handle> URLs and
-- historical support tickets still resolve via the resolver and via
-- frontend 301 redirects.
CREATE TABLE IF NOT EXISTS public.handle_aliases (
  old_handle text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS handle_aliases_user_id_idx
  ON public.handle_aliases (user_id);

COMMENT ON TABLE public.handle_aliases IS
  'Permanent record of every legacy handle that ever pointed at a user. Used by the recipient resolver (0.92 score boost) and by the frontend catch-all router for 301 redirects. Never deleted.';

-- 4. Fuzzy display_name index for the resolver. GIN trigram on the
-- unaccented lowercase display_name supports similarity() at write time
-- without scanning the whole table. Single index — keep IO discipline
-- per the Supabase IO playbook.
CREATE INDEX IF NOT EXISTS profiles_display_name_trgm_idx
  ON public.profiles
  USING gin ((lower(public.unaccent(display_name))) gin_trgm_ops);
