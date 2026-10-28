// VTID-04028: open the Operator Console against the local harness, send a
// message, screenshot the live transcript mid-turn and the finished turn,
// desktop (1400x900) and mobile (390x844).
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18428';
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

  const textarea = page.locator('.chat-container textarea');
  await textarea.fill('Where is renderCiEvidence called, and what do the gateway logs say?');
  await page.evaluate(() => { state.chatInputValue = 'Where is renderCiEvidence called, and what do the gateway logs say?'; sendChatMessage(); });

  // Mid-turn: two tools done, third running.
  await page.waitForSelector('.chat-tool-activity-line--running', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.chat-tool-activity--live .chat-tool-activity-line').length >= 3, null, { timeout: 15000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/operator-stream-live-${tag}.png` });
  const liveText = await page.$$eval('.chat-tool-activity--live .chat-tool-activity-line', (els) => els.map((e) => e.textContent));

  // Finished: reply bubble + activity lines carrying durations.
  await page.waitForFunction(() => !state.chatSending, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/operator-stream-done-${tag}.png` });
  const doneText = await page.$$eval('.chat-tool-activity:not(.chat-tool-activity--live) .chat-tool-activity-line', (els) => els.map((e) => e.textContent));
  const reply = await page.$$eval('.message-reply', (els) => els.map((e) => e.textContent).pop());

  console.log(JSON.stringify({ tag, liveText, doneText, reply, errors }, null, 2));
  await browser.close();
}

(async () => {
  await run({ width: 1400, height: 900 }, 'desktop');
  await run({ width: 390, height: 844 }, 'mobile');
})().catch((e) => { console.error(e); process.exit(1); });
