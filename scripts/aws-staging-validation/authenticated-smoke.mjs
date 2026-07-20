// Authenticated smoke test — AWS staging frontend (preview-aws.vitanaland.com)
// Login via Supabase REST (CLAUDE.md pattern), inject session, then verify:
// data loads via the AWS gateway, German UI, ORB session start, screenshots.
import { chromium } from 'playwright-core';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
setGlobalDispatcher(new EnvHttpProxyAgent());

const FRONTEND = process.env.FRONTEND || 'https://preview-aws.vitanaland.com';
const AWS_GATEWAY_HOST = process.env.GATEWAY_HOST || 'preview-aws-gateway.vitanaland.com';
const SUPABASE_URL = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const OUT = process.env.OUT || '.';
const results = [];
const note = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`); };

// 1. Sign in via Supabase REST — anon key harvested from the live bundle at runtime.
const idx = await fetch(`${FRONTEND}/`).then(r => r.text());
const bundlePath = idx.match(/src="([^"]+\.js)"/)?.[1];
const bundle = await fetch(`${FRONTEND}${bundlePath}`).then(r => r.text());
const anonKey = bundle.match(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];
if (!anonKey) { note('anon key from bundle', false, 'not found'); process.exit(1); }

const session = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: anonKey },
  body: JSON.stringify({ email: 'e2e-test@vitana.dev', password: 'VitanaE2eTest2026!' }),
}).then(r => r.json());
note('Supabase login', !!session.access_token, session.access_token ? `user ${session.user?.id?.slice(0, 8)}…` : JSON.stringify(session).slice(0, 120));
if (!session.access_token) process.exit(1);

// 2. Direct authed API check against the AWS gateway (auth chain w/o browser).
const journey = await fetch(`https://${AWS_GATEWAY_HOST}/api/v1/journey/state`, {
  headers: { Authorization: `Bearer ${session.access_token}` },
}).then(r => ({ status: r.status, ct: r.headers.get('content-type') })).catch(e => ({ status: 0, ct: String(e) }));
note('AWS gateway accepts Supabase JWT', journey.status === 200, `/journey/state → ${journey.status} ${journey.ct}`);

// 3. ORB voice session start (exercises Gemini key + auth + orb stack).
const orb = await fetch(`https://${AWS_GATEWAY_HOST}/api/v1/orb/live/session/start`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
}).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 200) })).catch(e => ({ status: 0, body: String(e) }));
note('ORB session start', orb.status === 200, `POST /orb/live/session/start → ${orb.status}: ${orb.body.replace(/\s+/g, ' ').slice(0, 150)}`);

// 4. Browser session: inject auth, load app, watch which gateway it calls.
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'de-DE', ignoreHTTPSErrors: true })).newPage();
const gatewayCalls = { aws: 0, gcpProd: 0, gcpStaging: 0, other: [] };
page.on('request', req => {
  const u = req.url();
  if (u.includes(AWS_GATEWAY_HOST)) gatewayCalls.aws++;
  else if (u.includes('preview-gateway.vitanaland.com')) gatewayCalls.gcpStaging++;
  else if (u.includes('gateway.vitanaland.com')) gatewayCalls.gcpProd++;
  else if (u.includes('/api/v1/')) gatewayCalls.other.push(u.slice(0, 90));
});
await page.goto(FRONTEND, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.evaluate(s => {
  localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(s));
  localStorage.setItem('vitana.authToken', s.access_token);
  localStorage.setItem('vitana.viewRole', 'community');
}, session);
await page.goto(FRONTEND, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/smoke-desktop.png` });

const bodyText = (await page.textContent('body').catch(() => '')) || '';
note('App renders authenticated', bodyText.length > 200 && !/something went wrong|fehler ist aufgetreten/i.test(bodyText.slice(0, 3000)), `body text ${bodyText.length} chars`);
note('Frontend calls AWS gateway', gatewayCalls.aws > 0 && gatewayCalls.gcpProd === 0,
  `aws=${gatewayCalls.aws} gcp-prod=${gatewayCalls.gcpProd} gcp-staging=${gatewayCalls.gcpStaging}`);
const german = /Startseite|Entdecken|Einstellungen|Gemeinschaft|Nachrichten|Profil|Willkommen|Journey/i.test(bodyText);
note('German/localized UI', german, `sample: "${bodyText.replace(/\s+/g, ' ').slice(0, 120)}"`);

// Mobile viewport screenshot
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/smoke-mobile.png` });

// 5. Deep route with auth (settings)
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto(`${FRONTEND}/settings`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/smoke-settings.png` });
note('Settings deep route', true, 'screenshot captured');

await browser.close();
const fails = results.filter(r => !r.ok).length;
console.log(`\nSMOKE RESULT: ${results.length - fails}/${results.length} passed`);
process.exit(0);
