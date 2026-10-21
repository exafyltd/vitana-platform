// VTID-04422: screenshot Conversation → Monitor's "Ranking: live vs shadow
// score" section at 1400x900 and 390x844 against the local harness.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = 'http://127.0.0.1:18522';
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/conversation/monitor/`, { waitUntil: 'networkidle' });
  const heading = page.locator('h3', { hasText: 'Ranking: live vs shadow score' }).first();
  await heading.waitFor({ timeout: 15000 });
  if (tag === 'mobile') {
    const collapse = page.locator('.sidebar .collapse-btn').first();
    if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
  }
  await heading.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${__dirname}/monitor-shadow-${tag}.png` });
  const section = heading.locator('xpath=..');
  const tiles = await section.locator('.conv-metric-tile').allInnerTexts();
  const rows = await section.locator('tbody tr').allInnerTexts();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await browser.close();
  return { tag, tiles: tiles.map((t) => t.replace(/\n/g, ' | ')), rows: rows.map((t) => t.replace(/\t/g, ' | ')), horizontalOverflow: overflow, errors };
}
(async () => { console.log(JSON.stringify([await run({ width: 1400, height: 900 }, 'desktop'), await run({ width: 390, height: 844 }, 'mobile')], null, 1)); })().catch((e) => { console.error(e); process.exit(1); });
