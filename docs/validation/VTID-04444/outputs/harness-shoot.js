// VTID-04444: screenshot Assistant → Metrics (Learning health) at 1400x900 and 390x844.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18531';
const OUT = __dirname;
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/assistant/metrics/`, { waitUntil: 'networkidle' });
  if (tag === 'mobile') {
    const collapse = page.locator('.sidebar .collapse-btn').first();
    if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
  }
  await page.waitForSelector('.conv-metric-tile', { timeout: 15000 });
  const tile = page.locator('.conv-metric-tile', { hasText: 'Users with themes' }).first();
  await tile.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/learning-${tag}.png` });
  const tiles = await page.$$eval('.conv-metric-tile', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await browser.close();
  console.log(JSON.stringify({ tag, tiles, horizontalOverflow: overflow, errors }));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
