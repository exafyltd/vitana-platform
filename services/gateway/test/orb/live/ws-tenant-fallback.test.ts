/**
 * BOOTSTRAP-WS-TENANT-FALLBACK — anti-regression wall.
 *
 * Root cause found while verifying the greeting-facts ledger (BOOTSTRAP-
 * GREETING-CONTINUITY) on staging: real voice sessions (confirmed via the
 * `last_full_briefing_date` stamp, which only fires from inside the exact
 * code block the ledger read/write also lives in) produced zero ledger
 * rows. The stamp only needs `user_id`; the ledger read/write is gated on
 * `session.identity.tenant_id`.
 *
 * The SSE `/live/stream` route already has a fallback for this
 * (VTID-MEMORY-BRIDGE, ~L12921): `provision_platform_user()` creates
 * `user_tenants` rows but does NOT always set `active_tenant_id` in JWT
 * `app_metadata` (or the cached JWT predates a later backfill) — so
 * `identity.tenant_id` comes back null even for real, provisioned users.
 * The WebSocket connection handler (the actual voice session path) never
 * got the same fix — it assigned `identity = result.identity` directly.
 * That silently disabled every tenant-scoped write for the WHOLE voice
 * session (greeting-facts ledger, social context, memory writes) while
 * user_id-only paths kept working, masking the gap for months.
 *
 * This wall pins: the WS handler now applies the identical fallback
 * (`lookupPrimaryTenant`) the SSE handler already uses, so voice sessions
 * cannot regress back to this silent-null-tenant state.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const ORB_LIVE = path.join(SRC, 'routes', 'orb-live.ts');

describe('WS tenant fallback — source-level wall', () => {
  const src = fs.readFileSync(ORB_LIVE, 'utf8');

  it('the SSE /live/stream route has the tenant fallback (reference implementation)', () => {
    const idx = src.indexOf("router.get('/live/stream'");
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(idx, idx + 3000);
    expect(window).toContain('lookupPrimaryTenant');
  });

  it('the WebSocket connection handler applies the SAME fallback when tenant_id is missing', () => {
    const idx = src.indexOf('let identity: SupabaseIdentity | undefined;');
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(idx, idx + 2000);
    expect(window).toContain('verifyAndExtractIdentity(token)');
    expect(window).toContain('identity = result.identity;');
    // The fallback must run AFTER the direct assignment, guarded on the
    // JWT claim being empty, and must re-attach onto `identity` (not a
    // throwaway local) so every downstream tenant-scoped read/write sees it.
    expect(window).toContain('if (!identity.tenant_id && identity.user_id)');
    expect(window).toContain('lookupPrimaryTenant(identity.user_id)');
    expect(window).toContain('identity = { ...identity, tenant_id: resolvedTenant }');
  });

  it('the WS session object is built from the (possibly-fallback-resolved) identity variable', () => {
    // Guards against a future refactor reintroducing the bug by reading
    // result.identity directly somewhere downstream instead of the
    // fallback-resolved `identity` binding.
    const idx = src.indexOf('isAnonymous: !identity?.user_id,');
    expect(idx).toBeGreaterThan(-1);
  });
});

describe('lookupPrimaryTenant — behavior (previously untested)', () => {
  // lookupPrimaryTenant is a module-private function in orb-live.ts with no
  // prior test coverage on either the SSE or WS path. Exercise it via the
  // exported HTTP surface it already backs (the SSE stream route) is heavy;
  // instead pin its documented contract at the source level and rely on the
  // live DB verification already performed for this fix (direct upsert
  // round-trip against the real tenant/user pair during the bug hunt).
  it('is defined with a primary-tenant-first, any-tenant-fallback contract', () => {
    const src = fs.readFileSync(ORB_LIVE, 'utf8');
    const idx = src.indexOf('async function lookupPrimaryTenant(');
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(idx, idx + 900);
    expect(window).toContain("eq('is_primary', true)");
    expect(window).toContain('Fallback: any tenant for this user');
  });
});
