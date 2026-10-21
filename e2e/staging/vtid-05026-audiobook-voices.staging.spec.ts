// VTID-05026 — who reads each Audiobook episode on staging.
//
// Russian and Serbian are read by Google voices (each behind its own switch,
// both on in staging); the other nine languages by Amazon Polly. A status
// code cannot tell the providers apart, so this spec reads the gateway's own
// statement (X-Audiobook-Voice-Provider) for all eleven languages, and proves
// Serbian — which had no voice at all before — now returns real audio in its
// own language.
//
// Read-only: './staging-guard' (copied in by the runner) aborts every write;
// the only POST is the sign-in itself. Requesting an episode renders audio on
// the staging gateway and writes nothing to the database. Google cost is
// bounded by the per-task daily cap and by one topic per language.
//
// Timeout: a cold Google render of a ~2,000-character Russian lesson measured
// 26.5 s (Serbian, 1,539 characters: 10.8 s) through the same client on
// 2026-10-10, so each request gets 120 s.
import { test, expect } from './staging-guard';

const SUPABASE = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const TOPIC = 'T251';
const EXPECTED: Record<string, 'google' | 'polly'> = {
  ru: 'google',
  sr: 'google',
  de: 'polly',
  en: 'polly',
  fr: 'polly',
  es: 'polly',
  pt: 'polly',
  pl: 'polly',
  tr: 'polly',
  zh: 'polly',
  ar: 'polly',
};

test('ru and sr are read by Google, the other nine by Polly', async ({ request }) => {
  test.setTimeout(900_000);
  const email = process.env.TEST_USER_EMAIL ?? '';
  const password = process.env.TEST_USER_PASSWORD ?? '';
  // Not a skip: a skipped check passed silently once already.
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

  const wrong: string[] = [];
  for (const [lang, provider] of Object.entries(EXPECTED)) {
    const res = await request.get(`${gateway}/api/v1/journey/audiobook/topics/${TOPIC}/audio?lang=${lang}`, {
      headers: auth,
      timeout: 120_000,
    });
    const h = res.headers();
    const got = `${res.status()} ${h['content-type'] ?? '-'} provider=${h['x-audiobook-voice-provider'] ?? '-'} narration=${h['x-audiobook-narration-locale'] ?? '-'}`;
    if (
      res.status() !== 200 ||
      h['content-type'] !== 'audio/mpeg' ||
      h['x-audiobook-voice-provider'] !== provider ||
      h['x-audiobook-narration-locale'] !== lang
    ) {
      const body = res.status() === 200 ? '' : ` ${(await res.text()).slice(0, 200)}`;
      wrong.push(`${lang}: expected 200 audio/mpeg provider=${provider} narration=${lang}, got ${got}${body}`);
      continue;
    }
    expect((await res.body()).length, `${lang} audio is too short`).toBeGreaterThan(10_000);
  }
  expect(wrong, 'languages read by the wrong provider, or not read').toEqual([]);
});
