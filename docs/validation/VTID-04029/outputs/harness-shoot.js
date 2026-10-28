// VTID-04029: open the Dev Autopilot page against the local harness, find the
// awaiting_approval card, open its diff, screenshot; then approve and
// screenshot the card carrying the PR link. Desktop + mobile.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18429';
const OUT = process.env.OUT_DIR || __dirname;
const EXEC = '4f7d5ea4-1111-4222-8333-444455556666';

async function run(viewport, tag, approve) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/__reset`);
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/autopilot/live/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const card = page.locator(`#autopilot-live-exec-${EXEC}`);
  await card.waitFor({ timeout: 15000 });
  await card.scrollIntoViewIfNeeded();
  const before = await card.innerText();

  await card.locator('button', { hasText: 'Diff' }).click();
  await page.waitForSelector('.dev-autopilot-diff-patch', { timeout: 10000 });
  await page.waitForTimeout(250);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/approval-diff-${tag}.png` });
  const diffLines = await page.$$eval('.dev-autopilot-diff-patch > div', (els) => els.length);

  let after = null;
  if (approve) {
    await card.locator('button', { hasText: 'Approve' }).click();
    await page.waitForFunction((id) => {
      const el = document.getElementById('autopilot-live-exec-' + id);
      return el && /PR #3382/.test(el.innerText) && /\bCI\b/.test(el.innerText);
    }, EXEC, { timeout: 10000 });
    await page.waitForTimeout(300);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/approval-approved-${tag}.png` });
    after = await card.innerText();
  }
  console.log(JSON.stringify({ tag, before: before.split('\n').slice(0, 6), diffLines, after: after ? after.split('\n').slice(0, 6) : null, errors }, null, 2));
  await browser.close();
}

(async () => {
  await run({ width: 1400, height: 900 }, 'desktop', true);
  await run({ width: 390, height: 844 }, 'mobile', false);
})().catch((e) => { console.error(e); process.exit(1); });
