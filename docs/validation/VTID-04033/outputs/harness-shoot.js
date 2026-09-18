// VTID-04033: open the Operator Console against the local harness, send a
// message that queues an execution, screenshot the follow panel while the
// agent's steps stream in and once it parks (awaiting_approval). Desktop +
// mobile.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18435';
const OUT = process.env.OUT_DIR || __dirname;

async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('vitana.authToken', 'harness-token'); });
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  await page.evaluate(() => { openOperatorConsole(); renderApp(); });
  await page.waitForSelector('.chat-container textarea', { timeout: 10000 });
  const msg = 'Make renderCiEvidence() report totalFailing and have the watcher pass analysis.failedNames.length';
  await page.evaluate((m) => { state.chatInputValue = m; sendChatMessage(); }, msg);

  // The turn finished and the follow panel is live with at least 3 steps.
  await page.waitForSelector('.chat-exec-follow--live', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.chat-exec-follow-line').length >= 3, null, { timeout: 15000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/exec-follow-live-${tag}.png` });
  const liveHead = await page.$eval('.chat-exec-follow-head', (e) => e.textContent);
  const liveLines = await page.$$eval('.chat-exec-follow-line', (els) => els.map((e) => e.textContent));
  const chipHref = await page.$eval('.chat-exec-follow-chip', (e) => e.getAttribute('href'));

  // Terminal frame: the panel flips to done and the stream is closed.
  await page.waitForSelector('.chat-exec-follow--done', { timeout: 20000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/exec-follow-done-${tag}.png` });
  const doneHead = await page.$eval('.chat-exec-follow-head', (e) => e.textContent);
  const doneLines = await page.$$eval('.chat-exec-follow-line', (els) => els.map((e) => e.textContent));
  const streamClosed = await page.evaluate(() => Object.values(state.operatorExecFollow).every((s) => s.es === null && !!s.terminal));

  console.log(JSON.stringify({ tag, chipHref, liveHead, liveLines, doneHead, doneLines, streamClosed, errors }, null, 2));
  await browser.close();
}

(async () => {
  await run({ width: 1400, height: 900 }, 'desktop');
  await run({ width: 390, height: 844 }, 'mobile');
})().catch((e) => { console.error(e); process.exit(1); });
