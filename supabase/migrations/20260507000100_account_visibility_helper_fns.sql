-- E5 — server-side helpers for the existing profiles.account_visibility jsonb
-- column (introduced in 20260421000000_add_account_profile_fields.sql).
--
-- The jsonb column already exists with private-first defaults for sensitive
-- fields (firstName, lastName, dateOfBirth, gender, email, phone, address).
-- Today the visibility filter is enforced only client-side. These two SQL
-- helpers let routes (and future RLS policies on profile-derived views)
-- enforce visibility server-side without re-implementing the tier logic.
--
-- Tiers are linear: public > connections > private. A viewer can read a
-- field iff the field's tier is "public", OR the viewer is the subject
-- ("self"), OR the tier is "connections" and the viewer is friends with
-- the subject. The helper returns a tri-state relationship.

CREATE OR REPLACE FUNCTION public.get_viewer_relationship(
  p_viewer  uuid,
  p_subject uuid
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_viewer IS NULL THEN 'stranger'
    WHEN p_viewer = p_subject THEN 'self'
    WHEN EXISTS (
      -- Mutual-follow defines a "connection" today: both directions present
      -- in user_follows. user_follows is the canonical follow graph
      -- (20251001094733_dee87b34-...sql).
      SELECT 1
        FROM public.user_follows uf1
        JOIN public.user_follows uf2
          ON uf2.follower_id = uf1.following_id
         AND uf2.following_id = uf1.follower_id
       WHERE uf1.follower_id = p_viewer
         AND uf1.following_id = p_subject
    ) THEN 'connection'
    ELSE 'stranger'
  END;
$$;

COMMENT ON FUNCTION public.get_viewer_relationship(uuid, uuid) IS
  'Returns ''self'' | ''connection'' | ''stranger''. Used by visibility filters that gate per-field profile data. ''connection'' = mutual follow in user_follows (both directions present).';

-- can_read_profile_field(subject, viewer, field_key, default_tier).
-- Reads profiles.account_visibility -> field_key, falling back to
-- p_default_tier when the key is absent (covers users who joined before a
-- new visibility key was added).
CREATE OR REPLACE FUNCTION public.can_read_profile_field(
  p_subject      uuid,
  p_viewer       uuid,
  p_field_key    text,
  p_default_tier text DEFAULT 'private'
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  WITH rel AS (
    SELECT public.get_viewer_relationship(p_viewer, p_subject) AS r
  ),
  tier AS (
    SELECT COALESCE(
             (SELECT account_visibility ->> p_field_key
                FROM public.profiles
               WHERE user_id = p_subject),
             p_default_tier
           ) AS t
  )
  SELECT CASE
    WHEN (SELECT r FROM rel) = 'self' THEN true
    WHEN (SELECT t FROM tier) = 'public' THEN true
    WHEN (SELECT t FROM tier) = 'connections' AND (SELECT r FROM rel) = 'connection' THEN true
    ELSE false
  END;
$$;

COMMENT ON FUNCTION public.can_read_profile_field(uuid, uuid, text, text) IS
  'Returns true if viewer is allowed to see a profile field. Tiers: public > connections > private. Used by gateway visibility filter and (future) RLS policies on profile-derived views.';
