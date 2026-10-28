// VTID-04873 — every language reads its own Audiobook narration on staging.
//
// The bug: every non-German episode sent the German script to that
// language's voice ("English TTS talks German"). A status code and a byte
// count cannot tell German audio from English audio, which is how it shipped,
// so this spec reads the gateway's own statement of which language the
// narrated text is written in (X-Audiobook-Narration-Locale) for every one of
// the eleven languages.
//
// Read-only: './staging-guard' (copied in by the runner) aborts every write;
// the only POST is the sign-in itself. Requesting an episode renders audio on
// the staging gateway and writes nothing to the database.
import { test, expect } from './staging-guard';

const SUPABASE = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const TOPIC = 'T251';
// All eleven languages. Serbian gained its voice with VTID-05026 (Google,
// behind its own switch, on in staging); until then it was checked for an
// honest 422 instead.
const VOICED = ['de', 'en', 'fr', 'es', 'pt', 'pl', 'tr', 'zh', 'ar', 'ru', 'sr'];

test('each language narrates in its own language, never German', async ({ request }) => {
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
  for (const lang of VOICED) {
    const res = await request.get(`${gateway}/api/v1/journey/audiobook/topics/${TOPIC}/audio?lang=${lang}`, {
      headers: auth,
      // VTID-05026: a cold Google render (ru, sr) measured up to 26.5 s.
      timeout: 120_000,
    });
    const got = res.headers()['x-audiobook-narration-locale'];
    if (res.status() !== 200 || res.headers()['content-type'] !== 'audio/mpeg' || got !== lang) {
      wrong.push(`${lang}: status ${res.status()}, narration ${got ?? '(none)'}`);
      continue;
    }
    expect((await res.body()).length, `${lang} audio is too short`).toBeGreaterThan(10_000);
  }
  expect(wrong, 'languages not narrated in their own language').toEqual([]);
});
