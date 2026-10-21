// VTID-04426: screenshot the brain inspector (Tool catalog tile) in Conversation → Simulator and
// Conversation → Journey Context against the local harness, desktop 1400x900
// and mobile 390x844: load the session list, click the session, capture the
// inspector. Nothing live.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18526';
const OUT = __dirname;
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  const report = [];
  for (const [route, name] of [['conversation/simulator', 'simulator']]) {
    await page.goto(`${BASE}/command-hub/${route}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.conv-brain', { timeout: 15000 });
    if (tag === 'mobile') {
      const collapse = page.locator('.sidebar .collapse-btn').first();
      if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
    }
    await page.locator('.conv-brain .conv-brain__btn--ghost').first().click();
    await page.waitForSelector('.conv-brain__row', { timeout: 10000 });
    await page.locator('.conv-brain__row').first().click();
    await page.waitForSelector('.conv-brain__detail .conv-metric-tile', { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.locator('.conv-brain').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/${name}-${tag}.png` });
    await page.screenshot({ path: `${OUT}/${name}-${tag}-full.png`, fullPage: true });
    await page.locator('.conv-brain h3, .conv-brain h4, .conv-brain .conv-heading').filter({ hasText: 'Tools, errors and outcome' }).first().scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: `${OUT}/${name}-${tag}-tools.png` });
    const candRows = await page.$$eval('.conv-brain__detail table tr', (els) => els.map((e) => e.innerText.replace(/\t/g, ' | ')).filter((t) => /returned|suppressed|errored|skipped|outranked|spoken/.test(t)));
    const tiles = await page.$$eval('.conv-brain__detail .conv-metric-tile', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')));
    const warn = await page.$$eval('.conv-brain__detail .conv-metric-tile--warn', (els) => els.length);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    report.push({ name, candRows, tiles, warn, horizontalOverflow: overflow });
  }
  await browser.close();
  console.log(JSON.stringify({ tag, report, errors }, null, 1));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
