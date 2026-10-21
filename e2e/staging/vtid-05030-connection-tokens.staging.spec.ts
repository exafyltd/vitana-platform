// VTID-05030 — Health Hub WP2 / D1: wearable connection tokens.
//
// The change seals OAuth tokens at rest, refuses to store them without the
// key, wipes them on disconnect and revokes at the vendor. Those paths write,
// so they are proven by the CI suite (test/vtid-05030-connection-tokens.test.ts)
// — never here. This spec is a read-only regression check that the touched
// router still serves on the deployed staging build for a signed-in member.
// It is NOT a grant test: the grants migration is applied only after the
// owner's production approval and is checked then with a read-only
// information_schema query.
//
// Read-only: './staging-guard' (copied in by the runner) aborts every write;
// the only POST is the sign-in itself. Both requests are GETs.
import { test, expect } from './staging-guard';

const SUPABASE = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';

test('signed-in wearables providers and connections still serve, with no token fields', async ({ request }) => {
  test.setTimeout(120_000);
  const email = process.env.TEST_USER_EMAIL ?? '';
  const password = process.env.TEST_USER_PASSWORD ?? '';
  // Not a skip: a skipped check passes silently.
  expect(email && password, 'TEST_USER_EMAIL / TEST_USER_PASSWORD not provided').toBeTruthy();
  const gateway = process.env.STAGING_GATEWAY_URL ?? '';
  const frontend = process.env.STAGING_FRONTEND_URL ?? '';
  expect(gateway, 'STAGING_GATEWAY_URL').toBeTruthy();
  expect(frontend, 'STAGING_FRONTEND_URL').toBeTruthy();

  const html = await (await request.get(`${frontend}/maxina`)).text();
  const src = html.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1] ?? '';
  expect(src, 'no index bundle on the staging frontend').toBeTruthy();
  const bundle = await (await request.get(new URL(src, frontend).toString())).text();
  const key = [...bundle.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)].find((m) => {
    try {
      const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      return p.role === 'anon' && p.ref === 'inmkhvwdcuyhnxkgfvsb';
    } catch {
      return false;
    }
  })?.[0];
  expect(key, 'no Supabase publishable key in the bundle').toBeTruthy();
  const session = await (
    await request.post(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      headers: { apikey: key!, 'Content-Type': 'application/json' },
      data: { email, password },
    })
  ).json();
  expect(session.access_token, 'sign-in failed').toBeTruthy();
  const auth = { Authorization: `Bearer ${session.access_token}` };

  const providers = await request.get(`${gateway}/api/v1/wearables/providers`, { headers: auth });
  expect(providers.status(), 'wearables providers').toBe(200);

  const connections = await request.get(`${gateway}/api/v1/wearables/connections`, { headers: auth });
  expect(connections.status(), 'wearables connections').toBe(200);
  const body = await connections.json();
  expect(body.ok).toBe(true);
  const text = JSON.stringify(body);
  expect(text).not.toContain('access_token');
  expect(text).not.toContain('refresh_token');
});
