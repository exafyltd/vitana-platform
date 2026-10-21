// VTID-04396: screenshot the three new Orchestrator panels at 1400x900 and 390x844.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = 'http://127.0.0.1:18484';
const OUT = __dirname;
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/autopilot/orchestrator/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.orch-budget-bar', { timeout: 15000 });
  if (tag === 'mobile') {
    const collapse = page.locator('.sidebar .collapse-btn').first();
    if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const titles = await page.$$eval('.orch-section-title', (els) => els.map((e) => e.textContent));
  const facts = await page.evaluate(() => ({
    budgetTotal: (document.querySelector('.orch-budget-total') || {}).textContent,
    barValue: (document.querySelector('progress.orch-budget-bar') || {}).value,
    overRows: document.querySelectorAll('tr.is-over').length,
    denyPills: document.querySelectorAll('.orch-pill--deny').length,
    escalatePills: document.querySelectorAll('.orch-pill--escalate').length,
    errors: Array.from(document.querySelectorAll('.orch-error')).map((e) => e.textContent),
  }));
  const idx = (t) => titles.findIndex((x) => x && x.startsWith(t));
  for (const [t, n] of [['LLM spend today', 'budgets'], ['Policy shadow', 'shadow'], ['Delegation targets', 'delegations']]) {
    const i = idx(t);
    if (i >= 0) await page.locator('.orch-section').nth(i).screenshot({ path: `${OUT}/orchestrator-${n}-${tag}.png` });
  }
  await browser.close();
  console.log(JSON.stringify({ tag, horizontalOverflow: overflow, titles, facts, pageErrors: errors }, null, 1));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
