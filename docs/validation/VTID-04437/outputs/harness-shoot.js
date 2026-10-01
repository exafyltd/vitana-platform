// VTID-04437: open the Operator Console against the local harness with one
// local thread, wait for the two server-only threads to join the sidebar,
// open the phone thread and screenshot its loaded transcript. 1400x900 + 390x844.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:18437';
const OUT = process.argv[3] || __dirname;

async function run(viewport, tag) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('vitana.authToken', 'harness-token');
    const now = Date.now();
    localStorage.setItem('operator_console_threads_index', JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', title: 'Local thread on this laptop', conversationId: 'c1', createdAt: now - 7200e3, updatedAt: now - 7200e3 }]));
    localStorage.setItem('operator_console_history:11111111-1111-4111-8111-111111111111', JSON.stringify([{ role: 'user', content: 'hello from the laptop', ts: now - 7200e3 }, { role: 'assistant', content: 'Hi — what are we working on?', ts: now - 7190e3 }]));
  });
  await page.goto(`${BASE}/command-hub/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.evaluate(() => { openOperatorConsole(); renderApp(); });
  await page.waitForFunction(() => document.querySelectorAll('.chat-session-row').length >= 3, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/server-threads-sidebar-${tag}.png` });
  const rows = await page.$$eval('.chat-session-row', (els) => els.map((e) => e.textContent.trim().slice(0, 60)));
  await page.evaluate(() => switchOperatorThread('22222222-2222-4222-8222-222222222222'));
  await page.waitForFunction(() => (state.operatorChatHistory || []).length === 4, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/server-thread-opened-${tag}.png` });
  const history = await page.evaluate(() => state.operatorChatHistory.map((h) => `${h.role}${h.channel ? '/' + h.channel : ''}: ${h.content}`));
  console.log(JSON.stringify({ tag, rows, history, errors }, null, 2));
  await browser.close();
}
(async () => { await run({ width: 1400, height: 900 }, 'desktop'); await run({ width: 390, height: 844 }, 'mobile'); })().catch((e) => { console.error(e); process.exit(1); });
