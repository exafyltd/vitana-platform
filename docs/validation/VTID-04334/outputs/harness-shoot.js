// VTID-04334: screenshot the member-report badge on Autopilot Live and the
// Feedback drawer's Pipeline block against the local harness, desktop
// 1400x900 and mobile 390x844, and exercise the interactions. Nothing live.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18534';
const OUT = process.env.OUT_DIR || __dirname;

async function openLive(page) {
  await page.goto(`${BASE}/command-hub/autopilot/live/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.fb-member-badge', { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  const report = { tag };

  await openLive(page);
  if (tag === 'mobile') {
    const collapse = page.locator('.sidebar .collapse-btn').first();
    if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
  }
  report.badges = await page.$$eval('.fb-member-badge', (els) => els.map((e) => e.textContent));
  report.originLines = await page.$$eval('.ap-live-exec .ap-sup-finding-meta', (els) => els.map((e) => e.textContent));
  report.liveOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await page.screenshot({ path: `${OUT}/autopilot-live-${tag}.png` });
  const recent = page.locator('.ap-live-card').filter({ hasText: 'Recent executions' }).first();
  if (await recent.count()) await recent.screenshot({ path: `${OUT}/autopilot-live-recent-${tag}.png` });
  const devCard = page.locator('[id^="autopilot-live-exec-"]').first();
  await devCard.scrollIntoViewIfNeeded();
  await devCard.screenshot({ path: `${OUT}/autopilot-live-exec-row-${tag}.png` });

  // Badge on a dev execution row → drawer of that ticket.
  await devCard.locator('.fb-member-badge').click();
  await page.waitForSelector('#feedback-ticket-drawer .fb-pipeline');
  await page.waitForTimeout(300);
  report.drawerTitle = await page.textContent('#feedback-ticket-drawer h2');
  report.chips = await page.$$eval('#feedback-ticket-drawer .fb-chip', (els) => els.map((e) => e.textContent));
  report.execChipHref = await page.getAttribute('#feedback-ticket-drawer a.fb-chip[href*="autopilot-live-exec-"]', 'href');
  report.buttons = await page.$$eval('#feedback-ticket-drawer button', (els) => els.map((e) => e.textContent).filter((t) => t && t !== '×'));
  await page.screenshot({ path: `${OUT}/feedback-drawer-pipeline-${tag}.png` });
  const pipe = page.locator('#feedback-ticket-drawer .fb-pipeline');
  await pipe.screenshot({ path: `${OUT}/feedback-drawer-pipeline-block-${tag}.png` });
  report.drawerOverflow = await page.evaluate(() => {
    const p = document.querySelector('#feedback-ticket-drawer > div');
    return p.scrollWidth > p.clientWidth + 1;
  });

  // Mark duplicate by FB number (resolved client-side to the original's UUID).
  if (tag === 'desktop') {
    page.once('dialog', (d) => d.accept('FB-2026-09-000140'));
    await page.getByRole('button', { name: 'Mark duplicate' }).click();
    await page.waitForTimeout(800);
    report.posted = await (await page.request.get(`${BASE}/__harness/posted`)).json();
  }
  await page.evaluate(() => document.getElementById('feedback-ticket-drawer') && document.getElementById('feedback-ticket-drawer').remove());

  // Badge with only an FB number (title fallback) → resolved via the list → old-shape ticket, "—" chips.
  await openLive(page);
  const titleOnly = page.locator('.fb-member-badge', { hasText: 'FB-2026-09-000140' }).first();
  await titleOnly.click();
  await page.waitForSelector('#feedback-ticket-drawer .fb-pipeline');
  await page.waitForTimeout(300);
  report.oldShapeTitle = await page.textContent('#feedback-ticket-drawer h2');
  report.oldShapeChips = await page.$$eval('#feedback-ticket-drawer .fb-chip', (els) => els.map((e) => e.textContent));
  await page.locator('#feedback-ticket-drawer .fb-pipeline').screenshot({ path: `${OUT}/feedback-drawer-pipeline-absent-fields-${tag}.png` });
  await page.evaluate(() => document.getElementById('feedback-ticket-drawer').remove());

  // Resolved, auto-resolved ticket → Rollback offered (source_ref-only badge).
  const resolvedBadge = page.locator('.fb-member-badge', { hasText: 'ticket 9e8d7c6b' }).first();
  await resolvedBadge.click();
  await page.waitForSelector('#feedback-ticket-drawer .fb-pipeline');
  await page.waitForTimeout(300);
  report.resolvedButtons = await page.$$eval('#feedback-ticket-drawer button', (els) => els.map((e) => e.textContent).filter((t) => t && t !== '×'));
  report.resolvedChips = await page.$$eval('#feedback-ticket-drawer .fb-chip', (els) => els.map((e) => e.textContent));
  await page.screenshot({ path: `${OUT}/feedback-drawer-resolved-${tag}.png` });
  await page.evaluate(() => document.getElementById('feedback-ticket-drawer').remove());

  // Supervisor open-findings panel (Scanners tab): the finding row carries the badge too.
  await page.goto(`${BASE}/command-hub/autopilot/scanners/`, { waitUntil: 'networkidle' });
  const supBadge = page.locator('.ap-sup-findings .fb-member-badge').first();
  await supBadge.waitFor({ timeout: 15000 });
  report.supervisorFindingBadge = await supBadge.textContent();
  await page.locator('.ap-sup-finding', { has: page.locator('.fb-member-badge') }).first().screenshot({ path: `${OUT}/autopilot-finding-row-${tag}.png` });

  // Feedback inbox: VTID column. The Feedback module has no NAVIGATION_CONFIG
  // entry (pre-existing: navigation-config.js is not loaded by index.html),
  // so there is no URL for it — select the module the way renderApp reads it.
  await page.evaluate('state.currentModuleKey = "feedback"; state.currentTab = "inbox"; renderApp();');
  await page.waitForSelector('td.fb-inbox-vtid', { timeout: 10000 });
  await page.waitForTimeout(500);
  if (tag === 'mobile') {
    const collapse = page.locator('.sidebar .collapse-btn').first();
    if (await collapse.count()) { await collapse.click().catch(() => {}); await page.waitForTimeout(300); }
  }
  report.inboxPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  report.inboxHeaders = await page.$$eval('table thead th', (els) => els.map((e) => e.textContent));
  report.inboxVtids = await page.$$eval('td.fb-inbox-vtid', (els) => els.map((e) => e.textContent));
  await page.screenshot({ path: `${OUT}/feedback-inbox-${tag}.png` });

  report.errors = errors;
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
