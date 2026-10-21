-- BOOTSTRAP-NAV-MOBILE-DRIFT-FIXES: repoint Mobile catalog entries that pointed
-- at dead/legacy routes (the desktop-app inventory surfaced these). Each entry
-- keeps its trigger phrases; only the route is corrected to a real, live SPA
-- path so the Navigator stops landing members on redirect-only routes and the
-- coverage "broken routes" count reflects reality.
--
-- All scoped to the shared Mobile catalog (platform='mobile', tenant_id IS NULL).
-- UPDATEs are idempotent and affect 0 rows where a screen_id isn't present.
--
-- impact-allow-solo-migration: pure data correction in the existing nav_catalog
-- table (the runtime already reads it). No code change required.
BEGIN;

-- Home sub-screens whose routes now redirect to /home → point at /home directly.
UPDATE nav_catalog SET route = '/home', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL
    AND screen_id IN ('HOME.MATCHES', 'HOME.AI_FEED', 'HOME.CONTEXT', 'HOME.ACTIONS');

-- Legacy health-tracker routes → live Health pages.
UPDATE nav_catalog SET route = '/health', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'HEALTH.TRACKER';
UPDATE nav_catalog SET route = '/health/my-biology', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'HEALTH.BIOMARKER_RESULTS';

-- Settings entries that moved under the Assistant / to renamed routes.
UPDATE nav_catalog SET route = '/assistant?tab=autopilot', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'SETTINGS.AUTOPILOT';
UPDATE nav_catalog SET route = '/assistant?tab=voice', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'SETTINGS.VOICE_AI';
UPDATE nav_catalog SET route = '/connectors', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id IN ('SETTINGS.CONNECTED_APPS', 'SETTINGS.SOCIAL');
UPDATE nav_catalog SET route = '/support', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'SETTINGS.SUPPORT';

-- Inbox / messages / reminders renamed routes.
UPDATE nav_catalog SET route = '/inbox', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'MESSAGES.OVERVIEW';
UPDATE nav_catalog SET route = '/reminders', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'INBOX.REMINDERS';

-- Cart renamed to the universal cart.
UPDATE nav_catalog SET route = '/universal-cart', updated_at = now()
  WHERE platform = 'mobile' AND tenant_id IS NULL AND screen_id = 'DISCOVER.CART';

COMMIT;
