// VTID-04842 — Commerce AI setup is switched on for the staging gateway
// (COMMERCE_AI_SETUP_ENABLED=true in AWS-STAGE-DEPLOY-GATEWAY.yml).
//
// Read-only: './staging-guard' (copied in by the runner) aborts every write;
// the only POST is the sign-in itself. The test signs in as the test user and
// reads /api/v1/commerce/ai-setup/status — the endpoint the Commerce portal
// reads to lead with "Set up with AI". Drafting and creating are left to the
// owner's own run on staging (owner decision 2026-10-02).
import { test, expect } from './staging-guard';

const SUPABASE = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';

test('the staging gateway reports Commerce AI setup switched on', async ({ request }) => {
  const email = process.env.TEST_USER_EMAIL ?? '';
  const password = process.env.TEST_USER_PASSWORD ?? '';
  test.skip(!email || !password, 'TEST_USER_EMAIL / TEST_USER_PASSWORD not provided');
  const gateway = process.env.STAGING_GATEWAY_URL ?? '';
  const frontend = process.env.STAGING_FRONTEND_URL ?? '';
  expect(gateway, 'STAGING_GATEWAY_URL').toBeTruthy();
  expect(frontend, 'STAGING_FRONTEND_URL').toBeTruthy();

  // Unauthenticated: mounted and behind sign-in.
  const anon = await request.get(`${gateway}/api/v1/commerce/ai-setup/status`);
  expect(anon.status()).toBe(401);

  // The publishable Supabase key ships in the staging frontend bundle.
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

  const res = await request.get(`${gateway}/api/v1/commerce/ai-setup/status`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, enabled: true });
});
