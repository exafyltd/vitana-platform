// VTID-04643: screenshot the Run Tests tab (desktop 1400x900, mobile 390x844)
// and exercise it: start without a reason (refused with the reason message),
// then with a reason (started + appears in recent runs); tick a Playwright
// project and start staging E2E; open "Not launchable". Nothing live.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18643';
const OUT = process.env.OUT_DIR || __dirname;
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/testing-qa/run-tests/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tq-launch-card', { timeout: 15000 });
  if (tag === 'mobile') { const c = page.locator('.sidebar .collapse-btn').first(); if (await c.count()) { await c.click().catch(() => {}); await page.waitForTimeout(300); } }
  const cards = await page.locator('.tq-launch-card').count();
  await page.screenshot({ path: `${OUT}/run-tests-${tag}.png`, fullPage: tag === 'desktop' });
  // No reason -> refused.
  const first = page.locator('.tq-launch-card').filter({ hasText: 'Gateway + services unit tests' });
  await first.getByRole('button', { name: 'Start' }).click();
  await first.locator('.tq-sv-fail').waitFor({ timeout: 5000 });
  const refusal = await first.locator('.tq-sv-fail').textContent();
  // With a reason -> started.
  await first.getByRole('textbox').fill('verify main after merge');
  await first.getByRole('button', { name: 'Start' }).click();
  await first.locator('.tq-launch-ok').waitFor({ timeout: 5000 });
  const recentAfter = await page.locator('.tq-table').last().locator('tbody tr').count();
  // Staging E2E with a project.
  const e2e = page.locator('.tq-launch-card').filter({ hasText: 'End-to-end (Playwright) on staging' });
  await e2e.getByLabel('Hub — Shared').check();
  await e2e.getByRole('textbox').fill('smoke the hub');
  await e2e.getByRole('button', { name: 'Start' }).click();
  await e2e.locator('.tq-launch-ok').waitFor({ timeout: 5000 });
  await page.locator('.tq-details summary').click();
  const notLaunchable = await page.locator('.tq-details tbody tr').count();
  await page.screenshot({ path: `${OUT}/run-tests-after-${tag}.png`, fullPage: tag === 'desktop' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await browser.close();
  console.log(JSON.stringify({ tag, cards, refusal, recentAfter, notLaunchable, horizontalOverflow: overflow, errors }));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
