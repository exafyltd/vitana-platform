// VTID-04421: screenshot Conversation → Monitor's Suggestion outcomes section,
// desktop 1400x900 and mobile 390x844, against the local harness. Nothing live.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = 'http://127.0.0.1:18521';
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/conversation/monitor/`, { waitUntil: 'networkidle' });
  const heading = page.locator('h3', { hasText: 'Suggestion outcomes' }).first();
  await heading.waitFor({ timeout: 15000 });
  if (tag === 'mobile') {
    const collapse = page.locator('.sidebar .collapse-btn').first();
    if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
  }
  await heading.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${__dirname}/monitor-offers-${tag}.png` });
  await page.locator('h3', { hasText: 'Suggestion outcomes' }).first().locator('xpath=..').locator('button', { hasText: '30 d' }).click();
  await page.waitForTimeout(300);
  const tiles = await page.locator('h3', { hasText: 'Suggestion outcomes' }).first().locator('xpath=..').locator('.conv-metric-tile').allInnerTexts();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await browser.close();
  return { tag, tiles: tiles.map((t) => t.replace(/\n/g, ' | ')), horizontalOverflow: overflow, errors };
}
(async () => { const out = [await run({ width: 1400, height: 900 }, 'desktop'), await run({ width: 390, height: 844 }, 'mobile')]; console.log(JSON.stringify(out, null, 1)); })().catch((e) => { console.error(e); process.exit(1); });
