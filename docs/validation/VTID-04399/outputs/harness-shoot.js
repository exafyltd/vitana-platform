// VTID-04399: screenshot Conversation → Monitor (context tiles) against
// the local harness, desktop 1400x900 and mobile 390x844; click a window
// button to prove the picker re-renders. Nothing live.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18499';
const OUT = __dirname;
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  const report = [];
  for (const [route, name] of [['conversation/monitor', 'monitor']]) {
    await page.goto(`${BASE}/command-hub/${route}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.conv-metric-tile', { timeout: 15000 });
    await page.waitForTimeout(500);
    if (tag === 'mobile') {
      const collapse = page.locator('.sidebar .collapse-btn').first();
      if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
    }
    await page.screenshot({ path: `${OUT}/${name}-${tag}.png` });
    await page.screenshot({ path: `${OUT}/${name}-${tag}-full.png`, fullPage: true });
    const tiles = await page.$$eval('.conv-metric-tile', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')));
    const warn = await page.$$eval('.conv-metric-tile--warn', (els) => els.length);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    // Interaction: pick "7 days" and confirm the active button moves.
    await page.getByRole('button', { name: '7 days' }).first().click();
    await page.waitForTimeout(400);
    const active = await page.$eval('.conv-metric-window.is-active', (e) => e.textContent);
    report.push({ name, tiles: tiles.length, warn, horizontalOverflow: overflow, activeAfterClick: active, firstTiles: tiles.slice(0, 6) });
  }
  await browser.close();
  console.log(JSON.stringify({ tag, report, errors }, null, 1));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
