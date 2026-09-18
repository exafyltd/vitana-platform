// VTID-04032: open the Autopilot Live view against the local harness, find
// the running agent execution, screenshot its Cancel run button, click it
// (the reason prompt is answered through the dialog handler), and screenshot
// the row once it reads CANCELLED. Desktop + mobile.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18434';
const OUT = process.env.OUT_DIR || __dirname;
const EXEC = '7c2e9b1d-1111-4222-8333-444455556666';

async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: d.message().slice(0, 80) }); await d.accept('wrong file — stop here'); });
  await page.goto(`${BASE}/__reset`);
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/autopilot/live/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const card = page.locator(`#autopilot-live-exec-${EXEC}`);
  await card.waitFor({ timeout: 15000 });
  await card.scrollIntoViewIfNeeded();
  const before = await card.innerText();
  await page.screenshot({ path: `${OUT}/cancel-running-${tag}.png` });

  await card.locator('button', { hasText: 'Cancel run' }).click();
  await page.waitForFunction((id) => {
    const el = document.getElementById('autopilot-live-exec-' + id);
    return el && /CANCELLED/i.test(el.innerText) && !/Cancel run/.test(el.innerText);
  }, EXEC, { timeout: 10000 });
  await page.waitForTimeout(300);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/cancel-cancelled-${tag}.png` });
  const after = await card.innerText();
  const toast = await page.$$eval('.toast, [class*="toast"]', (els) => els.map((e) => e.textContent.trim()).filter(Boolean).slice(0, 3));

  console.log(JSON.stringify({ tag, before: before.split('\n').slice(0, 6), dialogs, after: after.split('\n').slice(0, 6), toast, errors }, null, 2));
  await browser.close();
}

(async () => {
  await run({ width: 1400, height: 900 }, 'desktop');
  await run({ width: 390, height: 844 }, 'mobile');
})().catch((e) => { console.error(e); process.exit(1); });
