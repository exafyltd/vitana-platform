// VTID-04671: open the Pending Approvals popup against the local harness,
// screenshot the cards, expand "Why", open the dismiss reason picker (and
// submit it), click Activate and screenshot the live execution state.
// Desktop 1400×900 + mobile 390×844.
const { chromium } = require('/home/user/vitana-platform/services/gateway/node_modules/playwright');

const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18471';
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

  await page.click('button.header-pill:has-text("AUTOPILOT")');
  await page.waitForSelector('.autopilot-recommendations-modal .recommendation-card', { timeout: 10000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/p6-modal-${tag}.png` });
  const metrics = await page.$$eval('.rec-q-metrics', (els) => els.map((e) => e.textContent));
  const awaiting = await page.$$eval('.rec-why-awaiting', (els) => els.map((e) => e.textContent));
  const footer = await page.$eval('.rec-footer-held', (e) => e.textContent);

  // Expand "Why" on the executable card.
  await page.click('.rec-why-summary');
  await page.waitForTimeout(150);
  await page.$eval('.rec-why', (e) => e.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${OUT}/p6-why-${tag}.png` });
  const whyText = await page.$eval('.rec-why-body', (e) => e.textContent);

  // Dismiss on the oasis card → reason picker.
  const cards = await page.$$('.autopilot-recommendations-modal .recommendation-card');
  const dismissBtn = await cards[1].$('button:has-text("Dismiss")');
  await dismissBtn.click();
  await page.waitForSelector('.rec-dismiss-picker');
  await page.click('.rec-dismiss-option:has-text("Duplicate")');
  await page.fill('.rec-dismiss-note', 'Same root cause as the voice dispatcher ticket.');
  await page.$eval('.rec-dismiss-picker', (e) => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/p6-dismiss-picker-${tag}.png` });
  await page.click('.rec-dismiss-confirm');
  await page.waitForFunction(() => !document.querySelector('.rec-dismiss-picker'), null, { timeout: 5000 });

  // Activate the executable card → live execution state.
  const card0 = (await page.$$('.autopilot-recommendations-modal .recommendation-card'))[0];
  await (await card0.$('button:has-text("Activate")')).click();
  await page.waitForSelector('.rec-activated', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('.rec-activated .chat-exec-follow-line').length >= 3, null, { timeout: 10000 });
  await page.$eval('.rec-activated', (e) => e.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/p6-activated-live-${tag}.png` });
  const activatedHead = await page.$eval('.rec-activated-head', (e) => e.textContent);
  const liveLines = await page.$$eval('.rec-activated .chat-exec-follow-line', (els) => els.map((e) => e.textContent));
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const posted = await page.evaluate(async () => (await fetch('/__posted')).json());

  // Close the popup → followed streams closed, state reset.
  await page.click('.autopilot-recommendations-modal .modal-close-btn');
  const afterClose = await page.evaluate(() => ({ activated: state.autopilotActivatedRecs.length, streamsOpen: Object.values(state.operatorExecFollow).filter((s) => s.es).length }));

  console.log(JSON.stringify({ tag, metrics, awaiting, footer, whyText, activatedHead, liveLines, overflowX, posted, afterClose, errors }, null, 2));
  await browser.close();
}

(async () => {
  await run({ width: 1400, height: 900 }, 'desktop');
  await run({ width: 390, height: 844 }, 'mobile');
})().catch((e) => { console.error(e); process.exit(1); });
