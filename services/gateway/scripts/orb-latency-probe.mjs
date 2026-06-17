#!/usr/bin/env node
/**
 * ORB LATENCY PROBE (DEV-COMHU-0513) — headless synthetic orb client that
 * measures click→first-audio END TO END so we can iterate the first-greeting
 * latency fix WITHOUT a human pasting browser/gcloud logs.
 *
 * It mirrors what the widget does on tap:
 *   1. mint a JWT for the test user (Supabase password grant)
 *   2. POST /api/v1/orb/live/session/start           (t = session_started)
 *   3. GET  /api/v1/orb/live/stream?session_id=...    (SSE; t = stream_open)
 *   4. POST /api/v1/orb/session/:id/audio-ready       (t = audio_ready_sent)
 *   5. read the SSE until the FIRST audio chunk        (t = first_audio)
 * …timestamping each step and printing the breakdown.
 *
 * It does NOT model the browser AudioContext unlock (that needs a real
 * browser / Playwright run) — but it isolates the SERVER + TRANSPORT + greeting
 * path, which is where we've measured the first-turn tax.
 *
 * REQUIRES outbound egress to the gateway + Supabase host (currently blocked by
 * the env allowlist). Run:
 *   GW=https://gateway-staging-86804897789.us-central1.run.app \
 *   SUPABASE_URL=https://inmkhvwdcuyhnxkgfvsb.supabase.co \
 *   SUPABASE_ANON_KEY=... ORB_EMAIL=e2e-test@vitana.dev ORB_PASSWORD=... \
 *   node services/gateway/scripts/orb-latency-probe.mjs
 */

const GW = (process.env.GW || 'https://gateway-staging-86804897789.us-central1.run.app').replace(/\/+$/, '');
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://inmkhvwdcuyhnxkgfvsb.supabase.co').replace(/\/+$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const EMAIL = process.env.ORB_EMAIL || 'e2e-test@vitana.dev';
const PASSWORD = process.env.ORB_PASSWORD || '';
const LANG = process.env.ORB_LANG || 'de';

const t0Wall = Date.now();
const marks = [];
function mark(name) {
  const t = Date.now() - t0Wall;
  marks.push([name, t]);
  console.log(`  [${String(t).padStart(6)}ms] ${name}`);
}

async function getToken() {
  if (process.env.ORB_TOKEN) return process.env.ORB_TOKEN;
  if (!ANON_KEY || !PASSWORD) throw new Error('Need SUPABASE_ANON_KEY + ORB_PASSWORD (or ORB_TOKEN) to authenticate.');
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`auth failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function run() {
  console.log(`ORB latency probe → ${GW} (lang=${LANG})`);
  const token = await getToken();
  mark('auth_ok');

  // 2. session/start
  const startResp = await fetch(`${GW}/api/v1/orb/live/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ lang: LANG, voice_style: 'friendly, calm', response_modalities: ['audio', 'text'], current_route: '/' }),
  });
  if (!startResp.ok) throw new Error(`session/start failed: ${startResp.status} ${await startResp.text()}`);
  const startData = await startResp.json();
  const sessionId = startData.session_id;
  mark(`session_started (id=${sessionId}, context_status=${startData?.meta?.context_status ?? 'n/a'})`);

  // 3. open SSE stream + 4. audio-ready (fired as soon as the stream opens, in parallel)
  const ctrl = new AbortController();
  const streamResp = await fetch(`${GW}/api/v1/orb/live/stream?session_id=${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  if (!streamResp.ok || !streamResp.body) throw new Error(`stream failed: ${streamResp.status}`);
  mark('stream_open');

  fetch(`${GW}/api/v1/orb/session/${encodeURIComponent(sessionId)}/audio-ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
  }).then(() => mark('audio_ready_sent')).catch((e) => console.warn('audio-ready failed:', e.message));

  // 5. read SSE until the FIRST GREETING audio chunk (or 25s timeout).
  //
  // DEV-COMHU-0513 FIX: the gateway sends an "activation chime" (a locally
  // generated PCM blip, source:'activation_chime') the instant the upstream
  // Live API socket opens — long before the model has generated a single word.
  // The old loop stopped at that chime and mislabeled it "FIRST_AUDIO", which
  // hid the real click→first-greeting latency (the chime tells you nothing
  // about model/gen time). We now mark the chime separately and KEEP READING
  // until the first NON-chime audio chunk — the actual spoken greeting — which
  // is the number the user perceives as "the orb takes forever to talk".
  const reader = streamResp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let chimeSeen = false;
  let greetingSeen = false;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) { mark('stream_closed'); break; }
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let msg; try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
      const isAudio = msg.type === 'audio' || !!msg.data_b64;
      const isChime = isAudio && msg.source === 'activation_chime';
      if (isChime && !chimeSeen) {
        chimeSeen = true;
        mark(`chime (activation_chime, bytes=${(msg.data_b64 || '').length})`);
      } else if (isAudio && !isChime && !greetingSeen) {
        greetingSeen = true;
        mark(`FIRST_GREETING (type=${msg.type}, bytes=${(msg.data_b64 || '').length})`);
        ctrl.abort();
        break;
      } else if (msg.type && !isAudio) {
        mark(`sse:${msg.type}`);
      }
    }
    if (greetingSeen) break;
  }

  // breakdown
  console.log('\n=== BREAKDOWN ===');
  const get = (n) => (marks.find((m) => m[0].startsWith(n)) || [, null])[1];
  const sAuth = get('auth_ok');
  const sStart = get('session_started'), sOpen = get('stream_open'), sReady = get('audio_ready_sent');
  const sChime = get('chime'), sGreet = get('FIRST_GREETING');
  if (sStart != null && sOpen != null) console.log(`  session/start round-trip:     ${sOpen - sAuth}ms  ← wake-brief/journey block when fast-start off`);
  if (sReady != null && sOpen != null) console.log(`  stream_open → audio_ready:    ${sReady - sOpen}ms`);
  if (sChime != null && sOpen != null) console.log(`  stream_open → chime:          ${sChime - sOpen}ms  (instant feedback, not the greeting)`);
  if (sGreet != null && sChime != null) console.log(`  chime → FIRST greeting:       ${sGreet - sChime}ms  ← model first-token + gen`);
  if (sGreet != null && sStart != null) console.log(`  session_started → greeting:   ${sGreet - sStart}ms`);
  if (sGreet != null && sAuth != null) console.log(`  TOTAL (click→first greeting): ${sGreet - sAuth}ms  ← the number that matters`);
  else console.log('  NO GREETING within 25s — first-greeting path stalled.');
}

run().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
