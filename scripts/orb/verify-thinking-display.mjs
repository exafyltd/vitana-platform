#!/usr/bin/env node
/**
 * VTID-04587 — visual check of the ORB display state across a conversation.
 *
 * Loads the REAL orb-widget.js in Chromium against an in-process fake
 * gateway that replays scripted SSE conversations, samples the orb state
 * (the `vtorb-st-*` class) and caption every 50 ms, and asserts the
 * sequence each scenario must show. Nothing touches a live gateway, a real
 * account or a database.
 *
 * The bug it pins: the server finishes a turn before the browser finishes
 * playing it. When the user answered during that tail, the 'thinking'
 * signal arrived while the widget was still on Speaking and was dropped;
 * when playback ended the widget showed Listening (ready beep, mic) while
 * Vitana was preparing her answer, then flipped back to Speaking.
 *
 * Usage:
 *   node scripts/orb/verify-thinking-display.mjs            # current widget
 *   WIDGET=/path/to/orb-widget.js node scripts/orb/verify-thinking-display.mjs
 *   SHOTS=/tmp/out node scripts/orb/verify-thinking-display.mjs   # screenshots
 *
 * Exits non-zero if any scenario shows the wrong sequence.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const WIDGET = process.env.WIDGET || path.join(repo, 'services/gateway/src/frontend/command-hub/orb-widget.js');
const SHOTS = process.env.SHOTS || '';
const require = createRequire(path.join(repo, 'services/gateway/package.json'));
const { chromium } = require('playwright');
const EXECUTABLE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const OPEN = [
  { at: 100, ev: { type: 'ready' } },
  { at: 200, ev: { type: 'live_api_ready', full_duplex: true } },
];

// expect: the ordered, de-duplicated orb states after 'connecting'.
const SCENARIOS = [
  {
    name: 'answer-during-playback-tail',
    note: 'the reported bug: user answers while the reply is still playing',
    durationMs: 13500,
    steps: [...OPEN,
      { at: 1500, audioMs: 7000 },
      { at: 2400, ev: { type: 'turn_complete' } },
      { at: 6000, ev: { type: 'input_transcript', text: 'ja gerne' } },
      { at: 6000, ev: { type: 'thinking' } },
      { at: 7000, ev: { type: 'thinking', reason: 'tool_call', tools: ['search_memory'] } },
      { at: 10500, audioMs: 2000 },
      { at: 10900, ev: { type: 'turn_complete' } }],
    expect: ['thinking', 'speaking', 'thinking', 'speaking', 'listening'],
    shotAt: 9200,
  },
  {
    name: 'answer-during-tail-no-tool',
    note: 'same, without a tool call',
    durationMs: 12500,
    steps: [...OPEN,
      { at: 1500, audioMs: 5000 },
      { at: 2200, ev: { type: 'turn_complete' } },
      { at: 5200, ev: { type: 'input_transcript', text: 'ja' } },
      { at: 5200, ev: { type: 'thinking' } },
      { at: 9300, audioMs: 2000 },
      { at: 9800, ev: { type: 'turn_complete' } }],
    expect: ['thinking', 'speaking', 'thinking', 'speaking', 'listening'],
  },
  {
    name: 'greeting-then-silence',
    note: 'normal: after a reply with no user input the orb listens',
    durationMs: 8000,
    steps: [...OPEN,
      { at: 1500, audioMs: 3000 },
      { at: 2000, ev: { type: 'turn_complete' } }],
    expect: ['thinking', 'speaking', 'listening'],
    shotAt: 6000,
  },
  {
    name: 'question-after-reply-finished',
    note: 'normal: user asks once Vitana has finished speaking',
    durationMs: 13000,
    steps: [...OPEN,
      { at: 1500, audioMs: 2500 },
      { at: 2300, ev: { type: 'turn_complete' } },
      { at: 6500, ev: { type: 'input_transcript', text: 'was hast du dir gemerkt' } },
      { at: 6500, ev: { type: 'thinking' } },
      { at: 7500, ev: { type: 'thinking', reason: 'tool_call', tools: ['search_memory'] } },
      { at: 10500, audioMs: 1500 },
      { at: 10800, ev: { type: 'turn_complete' } }],
    expect: ['thinking', 'speaking', 'listening', 'thinking', 'speaking', 'listening'],
  },
  {
    name: 'barge-in',
    note: 'user interrupts mid-reply',
    durationMs: 11000,
    steps: [...OPEN,
      { at: 1500, audioMs: 7000 },
      { at: 2400, ev: { type: 'turn_complete' } },
      { at: 4000, ev: { type: 'interrupted' } },
      { at: 4300, ev: { type: 'input_transcript', text: 'warte' } },
      { at: 4300, ev: { type: 'thinking' } },
      { at: 8000, audioMs: 1000 },
      { at: 8300, ev: { type: 'turn_complete' } }],
    expect: ['thinking', 'speaking', 'listening', 'thinking', 'speaking', 'listening'],
  },
  {
    name: 'silent-turn-after-tail-input',
    note: 'user spoke during the tail, the model closed the turn without speaking',
    durationMs: 10000,
    steps: [...OPEN,
      { at: 1500, audioMs: 5000 },
      { at: 2200, ev: { type: 'turn_complete' } },
      { at: 5000, ev: { type: 'input_transcript', text: 'ok' } },
      { at: 5000, ev: { type: 'thinking' } },
      { at: 5800, ev: { type: 'turn_complete' } }],
    expect: ['thinking', 'speaking', 'listening'],
  },
  {
    name: 'no-answer-fallback',
    note: 'thinking shown, no answer ever arrives: falls back to listening after 15 s',
    durationMs: 23000,
    steps: [...OPEN,
      { at: 1500, audioMs: 5000 },
      { at: 2200, ev: { type: 'turn_complete' } },
      { at: 5000, ev: { type: 'input_transcript', text: 'hm' } },
      { at: 5000, ev: { type: 'thinking' } }],
    expect: ['thinking', 'speaking', 'thinking', 'listening'],
  },
];

function pcm(ms) {
  const n = Math.floor(24 * ms); const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 330 * i / 24000) * 6000), i * 2);
  return b.toString('base64');
}

function startServer(state) {
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#111">
<script src="/orb-widget.js"></script>
<script>window.VitanaOrb.init({gatewayUrl:location.origin,authToken:'harness',lang:'de',showFab:false,transport:'sse'});</script></body></html>`;
  const send = (res, ev) => res.write('data: ' + JSON.stringify(ev) + '\n\n');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page); }
    if (u.pathname === '/orb-widget.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(fs.readFileSync(WIDGET)); }
    if (u.pathname === '/api/v1/orb/live/transport') return json({ transport: 'sse' });
    if (u.pathname === '/api/v1/orb/live/session/start') return json({ ok: true, session_id: 'live-harness', conversation_id: 'c-harness' });
    if (u.pathname === '/api/v1/orb/live/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const timers = [];
      for (const s of state.steps) {
        timers.push(setTimeout(() => {
          if (s.audioMs) {
            // 100 ms chunks delivered 8x faster than real time, like Nova.
            const chunks = Math.ceil(s.audioMs / 100);
            for (let i = 0; i < chunks; i++) timers.push(setTimeout(() => send(res, { type: 'audio', data_b64: pcm(100), mime: 'audio/pcm;rate=24000' }), i * 12.5));
          } else send(res, s.ev);
        }, s.at));
      }
      timers.push(setInterval(() => send(res, { type: 'heartbeat' }), 5000));
      req.on('close', () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); }));
      return;
    }
    return json({ ok: true });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function runScenario(browser, server, state, sc, viewport) {
  state.steps = sc.steps;
  const page = await browser.newPage({ viewport });
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.evaluate(() => window.VitanaOrb.toggle());
  const timeline = [];
  let last = '';
  let shot = sc.shotAt && SHOTS ? sc.shotAt : 0;
  while (Date.now() - t0 < sc.durationMs) {
    const st = await page.evaluate(() => {
      const sh = document.querySelector('.vtorb-shell');
      const cls = sh ? [...sh.classList].find((c) => c.startsWith('vtorb-st-')) : null;
      const status = (document.querySelector('.vtorb-status') || {}).textContent || '';
      return { orb: cls ? cls.slice(9) : 'none', status };
    });
    const t = Date.now() - t0;
    if (st.orb !== last) { timeline.push({ t, ...st }); last = st.orb; }
    if (shot && t >= shot) {
      await page.screenshot({ path: path.join(SHOTS, `${sc.name}-${viewport.width}x${viewport.height}.png`) });
      shot = 0;
    }
    await page.waitForTimeout(50);
  }
  await page.close();
  const seq = timeline.map((x) => x.orb).filter((o) => o !== 'connecting');
  return { timeline, seq, ok: JSON.stringify(seq) === JSON.stringify(sc.expect) };
}

const state = { steps: [] };
const server = await startServer(state);
const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const report = [];
for (const sc of SCENARIOS) {
  const r = await runScenario(browser, server, state, sc, { width: 1400, height: 900 });
  if (!r.ok) failed++;
  report.push({ scenario: sc.name, note: sc.note, ok: r.ok, expected: sc.expect, observed: r.seq, timeline: r.timeline });
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${sc.name}  ${r.timeline.map((x) => `${x.t}ms ${x.orb}`).join(' → ')}`);
  if (!r.ok) console.log(`      expected ${sc.expect.join(' → ')}`);
  if (SHOTS && sc.shotAt) await runScenario(browser, server, state, sc, { width: 390, height: 844 });
}
await browser.close();
server.close();
if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, JSON.stringify(report, null, 2));
console.log(failed ? `${failed} scenario(s) FAILED` : 'all scenarios passed');
process.exit(failed ? 1 : 0);
