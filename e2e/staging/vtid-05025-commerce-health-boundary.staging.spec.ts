// VTID-05025 — Health Hub WP1 / D12: no device-derived health data in commerce.
//
// Commerce (Discover feed and search) must never be personalised by a
// member's wearable data. Before this change search inferred 'insomnia' or
// 'low-hrv' from a 7-day sleep/HRV rollup and ranked products by it. The
// unit suite (test/vtid-05025-commerce-health-boundary.test.ts) proves the
// logic; this spec proves the deployed staging gateway still serves the
// signed-in Discover surfaces and that search never reports a
// device-derived condition.
//
// Read-only: './staging-guard' (copied in by the runner) aborts every write;
// the only POST is the sign-in itself. Both requests are GETs.
import { test, expect } from './staging-guard';

const SUPABASE = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const DEVICE_DERIVED = ['insomnia', 'low-hrv'];

test('signed-in Discover feed and search work and never use a device-derived condition', async ({ request }) => {
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

  const feed = await request.get(`${gateway}/api/v1/discover/feed?limit=5`, { headers: auth });
  expect(feed.status(), 'signed-in discover feed').toBe(200);
  expect((await feed.json()).ok).toBe(true);

  const search = await request.get(`${gateway}/api/v1/discover/search?q=sleep&limit=5`, { headers: auth });
  expect(search.status(), 'signed-in discover search').toBe(200);
  const body = await search.json();
  expect(body.ok).toBe(true);
  expect(DEVICE_DERIVED, 'search used a device-derived condition').not.toContain(body.applied_filters?.user_condition);
});
