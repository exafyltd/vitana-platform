-- VTID-04790: Dev Autopilot deny scope — keep auth/env/credentials locked
-- under the corrected glob matcher.
--
-- The old matcher turned `**/` into `.*` and dropped the slash, so
-- `**/auth*` matched any path whose FILE NAME contains "auth"
-- (oauth2.ts, tenant-role-auth.ts, ...-auth-transition.test.ts). The
-- matcher now follows normal glob rules (`**/auth*` = file name STARTS
-- with "auth"). To keep every file the old rule protected locked, the
-- name-only rules are rewritten to say "contains" explicitly.
--
-- Safe in either order with the code: under the OLD matcher `**/*auth*`
-- denies exactly the same paths as `**/auth*` did. Apply this before the
-- gateway with the new matcher deploys.

UPDATE public.dev_autopilot_config
SET deny_scope = (
      SELECT jsonb_agg(
               CASE elem
                 WHEN '**/auth*'        THEN '**/*auth*'
                 WHEN '**/.env*'        THEN '**/*.env*'
                 WHEN '**/credentials*' THEN '**/*credentials*'
                 WHEN '**/orb-live.ts'  THEN '**/*orb-live.ts'
                 ELSE elem
               END
               ORDER BY ord)
      FROM jsonb_array_elements_text(deny_scope) WITH ORDINALITY AS t(elem, ord)
    ),
    updated_at = now()
WHERE id = 1
  AND deny_scope ?| ARRAY['**/auth*', '**/.env*', '**/credentials*', '**/orb-live.ts'];
