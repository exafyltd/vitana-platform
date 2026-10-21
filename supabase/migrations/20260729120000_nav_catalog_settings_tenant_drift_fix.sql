-- BOOTSTRAP-NOVA-SONIC-VOICE-NAV-FIX: while auditing the Navigator catalog
-- for broken routes (nav_catalog entries whose route no longer exists as a
-- real SPA path, same check the admin /coverage endpoint runs), found one
-- pre-existing drift unrelated to the Nova regression: SETTINGS.TENANT
-- (Mobile-only) points at '/settings/tenant', which App.tsx never
-- registers — only '/settings/tenant-role' (already covered by the
-- SETTINGS.TENANT_ROLE catalog entry, mobile + desktop) and the unrelated
-- dev-only '/dev/settings/tenants' exist. Any voice or catalog-driven
-- redirect to SETTINGS.TENANT lands on a dead route.
--
-- Repoints the route to the real, live page — same pattern as
-- 20260616130000_nav_catalog_mobile_drift_fixes.sql (several catalog
-- entries already legitimately share one destination route, e.g.
-- HOME.MATCHES/HOME.AI_FEED/HOME.CONTEXT/HOME.ACTIONS all → '/home').
--
-- impact-allow-solo-migration: pure data correction in the existing
-- nav_catalog table (the runtime already reads it). No code change required.
BEGIN;

UPDATE nav_catalog SET route = '/settings/tenant-role', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'SETTINGS.TENANT';

-- Second, unrelated drift found in the same audit: the navigate_to_screen
-- tool schema (services/gateway/src/orb/live/tools/live-tool-catalog.ts)
-- tells the model to send a `groupId` argument "for COMM.GROUP_DETAIL" —
-- one static description, not platform-specific. The Mobile catalog row's
-- route template ('/comm/groups/:groupId') matches that param name, but
-- the Desktop row used ':id' instead, so param substitution
-- (orb-tools-shared.ts, `route.replace(/:(\w+)/, (_, name) => args[name])`)
-- always found `args['id']` missing on Desktop voice sessions and rejected
-- the navigation with "missing required parameter(s) id" — the model was
-- never told to send `id` for this screen. Route param names are internal
-- to this substitution (React Router matches by URL position once the
-- placeholder is filled in, not by the name the catalog happened to use),
-- so renaming the placeholder to match the tool schema is a safe, purely
-- cosmetic-to-the-router data fix.
UPDATE nav_catalog SET route = '/comm/groups/:groupId', updated_at = now()
  WHERE platform = 'desktop' AND tenant_id IS NULL AND screen_id = 'COMM.GROUP_DETAIL';

-- Same class of bug, same tool schema doc ("`match_id` for
-- INTENTS.MATCH_DETAIL"): the Mobile row already uses ':match_id', but
-- Desktop used ':id' and could never receive it from the model.
UPDATE nav_catalog SET route = '/intents/match/:match_id', updated_at = now()
  WHERE platform = 'desktop' AND tenant_id IS NULL AND screen_id = 'INTENTS.MATCH_DETAIL';

COMMIT;
