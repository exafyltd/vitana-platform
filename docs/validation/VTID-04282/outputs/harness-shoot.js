// VTID-04282: screenshot the Autopilot tabs against the local harness,
// desktop 1400x900 and mobile 390x844; click a supervisor tile to prove
// the cross-tab navigation. Nothing live.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18482';
const OUT = process.env.OUT_DIR || __dirname;
const TABS = (process.env.TABS || 'live,scanners,impact-rules,auto-approve,registry,growth').split(',');
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  const report = [];
  for (const tab of TABS) {
    await page.goto(`${BASE}/command-hub/autopilot/${tab}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ap-sup-strip .ap-sup-tile', { timeout: 15000 });
    await page.waitForTimeout(600);
    if (tag === 'mobile') {
      // The Command Hub sidebar is desktop-first (pre-existing); collapse it as a phone user would.
      const collapse = page.locator('.sidebar .collapse-btn').first();
      if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
    }
    await page.screenshot({ path: `${OUT}/${tab}-${tag}.png` });
    for (const [sel, name] of [['.ap-sup-strip', 'strip'], ['.ap-sup-findings', 'findings'], ['.ap-sup-autonomy', 'autonomy'], ['.ap-live-grid', 'livegrid']]) {
      const el = page.locator(sel).first();
      if (tag === 'desktop' && await el.count()) await el.screenshot({ path: `${OUT}/${tab}-${name}-${tag}.png` }).catch(() => {});
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const alerts = await page.$$eval('.ap-sup-strip .ap-sup-alert', (els) => els.length);
    const findings = await page.$$eval('.ap-sup-finding', (els) => els.length);
    report.push({ tab, alerts, findings, horizontalOverflow: overflow });
  }
  // Interaction: click the "Open findings" tile on Live -> should switch to Scanners.
  await page.goto(`${BASE}/command-hub/autopilot/live/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ap-sup-tile[role="button"]');
  await page.getByRole('button', { name: 'Open findings: open the scanners tab' }).click();
  await page.waitForTimeout(500);
  const urlAfterClick = page.url();
  await browser.close();
  console.log(JSON.stringify({ tag, report, urlAfterClick, errors }, null, 1));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
