// VTID-04642: screenshot Overview / Catalog / Runs against the local harness,
// desktop 1400x900 and mobile 390x844, and exercise the interactions: the
// catalog filter + a suite row expanding to its files, the runs filter, and
// an old URL (/testing-qa/unit-tests/) landing on the catalog. Nothing live.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18642';
const OUT = process.env.OUT_DIR || __dirname;
async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  const collapse = async () => {
    if (tag !== 'mobile') return;
    const c = page.locator('.sidebar .collapse-btn').first();
    if (await c.count()) { await c.click().catch(() => {}); await page.waitForTimeout(300); }
  };
  const report = {};
  for (const tab of ['overview', 'catalog', 'runs']) {
    await page.goto(`${BASE}/command-hub/testing-qa/${tab}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.tq-view', { timeout: 15000 });
    await page.waitForTimeout(700);
    await collapse();
    await page.screenshot({ path: `${OUT}/${tab}-${tag}.png`, fullPage: tag === 'desktop' });
    report[tab] = {
      horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
      loadingLeft: await page.locator('text=Loading').count(),
      errors: await page.locator('.tq-view .error-text').count(),
      tables: await page.locator('.tq-table').count(),
    };
  }
  // Catalog interaction: filter to never-run suites and open one.
  await page.goto(`${BASE}/command-hub/testing-qa/catalog/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tq-table');
  await page.selectOption('select[aria-label="Environment"]', 'never_run');
  await page.waitForTimeout(300);
  const neverRunRows = await page.locator('.tq-table').first().locator('tbody tr').count();
  await page.locator('.tq-row-click').first().click();
  await page.waitForSelector('.tq-file-list li', { timeout: 5000 });
  const filesShown = await page.locator('.tq-file-list li').count();
  await collapse();
  await page.screenshot({ path: `${OUT}/catalog-never-run-expanded-${tag}.png` });
  // Runs interaction: only failures.
  await page.goto(`${BASE}/command-hub/testing-qa/runs/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tq-table');
  await page.selectOption('select[aria-label="Result"]', 'failure');
  await page.waitForTimeout(600);
  const failureRows = await page.locator('.tq-table tbody tr').count();
  const nonFailure = await page.locator('.tq-table tbody tr .tq-pill-ok').count();
  // Old URL lands on the catalog.
  await page.goto(`${BASE}/command-hub/testing-qa/unit-tests/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tq-view');
  const oldUrlHeading = await page.locator('.tq-header h2').first().textContent();
  await browser.close();
  console.log(JSON.stringify({ tag, report, neverRunRows, filesShown, failureRows, nonFailure, oldUrlHeading, errors }, null, 1));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
