// VTID-04354: screenshot Autopilot › Orchestrator against the local harness at
// 1400x900 and 390x844, then click the first plane card and a status filter.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18483';
const OUT = __dirname;
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/autopilot/orchestrator/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.orch-agent-card', { timeout: 15000 });
  if (tag === 'mobile') {
    const collapse = page.locator('.sidebar .collapse-btn').first();
    if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
  }
  await page.screenshot({ path: `${OUT}/orchestrator-${tag}.png` });
  await page.screenshot({ path: `${OUT}/orchestrator-${tag}-full.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const counts = await page.evaluate(() => ({
    planes: document.querySelectorAll('.orch-plane-card').length,
    runs: document.querySelectorAll('.orch-table tbody tr').length,
    agents: document.querySelectorAll('.orch-agent-card').length,
    errors: document.querySelectorAll('.orch-error').length,
    tabActive: Array.from(document.querySelectorAll('a, button')).some((e) => /Orchestrator/.test(e.textContent || '')),
  }));
  await page.locator('.orch-plane-card').filter({ hasText: 'self_healing' }).first().click();
  await page.waitForTimeout(600);
  const afterPlane = await page.$$eval('.orch-section-title', (els) => els.map((e) => e.textContent));
  const runRowsAfterPlane = await page.$$eval('.orch-table:not(.orch-policy-table) tbody tr', (els) => els.length);
  for (const [i, n] of [[2, 'agents'], [3, 'grants']]) await page.locator('.orch-section').nth(i).screenshot({ path: `${OUT}/orchestrator-${n}-${tag}.png` });
  if (tag === 'desktop') await page.locator('.orch-section').nth(1).screenshot({ path: `${OUT}/orchestrator-filtered-plane-desktop.png` });
  await browser.close();
  console.log(JSON.stringify({ tag, counts, horizontalOverflow: overflow, afterPlane, runRowsAfterPlane, errors }, null, 1));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
