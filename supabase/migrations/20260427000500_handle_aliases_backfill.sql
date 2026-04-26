-- Vitana ID — Release A · 6/9
-- Backfill handle_aliases from every existing profiles.handle.
--
-- This MUST run before the vitana_id backfill (7/9) so the generator can
-- safely treat handle_aliases as authoritative when checking for collisions.
-- Once a value is in handle_aliases, it can never appear as a new vitana_id.

INSERT INTO public.handle_aliases (old_handle, user_id, created_at)
SELECT
  p.handle,
  p.user_id,
  COALESCE(p.created_at, now())
FROM public.profiles p
WHERE p.handle IS NOT NULL
  AND p.handle <> ''
ON CONFLICT (old_handle) DO NOTHING;
