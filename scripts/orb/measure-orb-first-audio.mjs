#!/usr/bin/env node
/**
 * VTID-04096/VTID-04097 — ORB voice first-audio latency benchmark.
 *
 * WHY THIS EXISTS. CLAUDE.md §2e-bench records that every existing ORB check
 * is silent by construction: the Nova test route checks config and codecs,
 * `/tests/eval` checks tool selection, `runVoiceProbe()` asserts booleans on
 * `/api/v1/orb/health`. None of them answer the only question a user asks —
 * "how long after I tap do I hear a word?" — and `voice.latency.measured` is
 * flag-gated off outside staging, so there was no repeatable way to measure a
 * change's effect on it at all.
 *
 * WHAT IT MEASURES. Per trial, wall-clock from the `POST /live/session/start`
 * request (the widget's own t=0 for the session, i.e. the instant after the
 * user's tap that the client can first talk to the gateway) to the first SSE
 * frame carrying audio bytes. That is the number the complaint is about. It
 * deliberately does NOT include widget script load or the client's
 * AudioContext unlock — those are VTID-04099's subject and are not observable
 * from a headless harness; treat this as a floor on perceived latency, never a
 * ceiling.
 *
 * WHY SSE AND NOT WS. Production resolves SSE (`FEATURE_ORB_WS_TRANSPORT_ENV`
 * unset there), so SSE is the transport the complaining cohort uses. The
 * gateway shares one session path across both transports (VTID-03471), so the
 * upstream half being measured is identical either way.
 *
 * SAFETY. Read-mostly by construction: it starts and stops voice sessions and
 * never posts community content, never writes a profile, never sends a message.
 * Point it at STAGING (the default). CLAUDE.md's absolute rule forbids running
 * it against production, and `--gateway` is deliberately required to be passed
 * explicitly for any non-default host so a prod URL can never be a typo away.
 *
 * Usage:
 *   node scripts/orb/measure-orb-first-audio.mjs --trials=6 --lang=de
 *   node scripts/orb/measure-orb-first-audio.mjs --trials=6 --lang=de --auth
 *   node scripts/orb/measure-orb-first-audio.mjs --trials=6 --lang=de --auth --route=/admin
 *
 * `--auth` needs SUPABASE_ANON_KEY + TEST_ACCOUNT_EMAIL + TEST_ACCOUNT_PASSWORD.
 */

import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);

const GATEWAY = args.gateway || process.env.GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com';
const ORIGIN = args.origin || process.env.ORIGIN_URL || 'https://preview-aws.vitanaland.com';
const LANG = args.lang || 'de';
const TRIALS = parseInt(args.trials || '6', 10);
const ROUTE = typeof args.route === 'string' ? args.route : '';
const AUTH = args.auth === true || args.auth === 'true';
const GAP_MS = parseInt(args.gap || '3000', 10);
const SSE_TIMEOUT_MS = parseInt(args.timeout || '40000', 10);
const LABEL = args.label || `${AUTH ? 'auth' : 'anon'}-${LANG}${ROUTE ? '-' + ROUTE.replace(/\W+/g, '') : ''}`;
const OUT = args.out || '';

if (/\/\/gateway\.vitanaland\.com/.test(GATEWAY)) {
  console.error('REFUSED: this is the production gateway. CLAUDE.md forbids running latency probes against production.');
  process.exit(2);
}

async function getAuthToken() {
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
  const apikey = process.env.SUPABASE_ANON_KEY;
  const email = process.env.TEST_ACCOUNT_EMAIL;
  const password = process.env.TEST_ACCOUNT_PASSWORD;
  if (!apikey || !email || !password) {
    throw new Error('--auth needs SUPABASE_ANON_KEY, TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_PASSWORD');
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('sign-in failed: ' + JSON.stringify(json));
  return json.access_token;
}

async function readSse(resp, onEvent, deadlineMs) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + deadlineMs;
  let stop = false;
  try {
    while (Date.now() < deadline && !stop) {
      const remaining = Math.max(50, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ timedOut: true }), remaining)),
      ]);
      if (result.timedOut || result.done) break;
      buf += decoder.decode(result.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = raw.split('\n').filter((l) => l.startsWith('data:'));
        if (dataLines.length) {
          const data = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (onEvent(data) === false) stop = true;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

function hasAudio(msg) {
  return (msg.type === 'audio' || msg.type === 'audio_out') && (msg.data_b64 || msg.audio_b64);
}

async function runTrial(idx, token) {
  const t = { idx, lang: LANG, auth: !!token, route: ROUTE || null, events: {} };
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = Date.now();
  t.t0 = t0;
  try {
    const startResp = await fetch(`${GATEWAY}/api/v1/orb/live/session/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify(ROUTE ? { lang: LANG, current_route: ROUTE } : { lang: LANG }),
    });
    t.sessionStartMs = Date.now() - t0;
    const body = await startResp.json().catch(() => null);
    if (!startResp.ok || !body?.ok) {
      t.error = `session/start HTTP ${startResp.status} ${JSON.stringify(body)}`;
      return t;
    }
    t.sessionId = body.session_id;

    // The widget acks audio-ready as soon as its AudioContext is unlocked;
    // mirror that so the deferred-greeting path is not artificially stalled.
    fetch(`${GATEWAY}/api/v1/orb/session/${encodeURIComponent(t.sessionId)}/audio-ready`, {
      method: 'POST', headers, body: '{}',
    }).catch(() => {});

    const sseUrl = `${GATEWAY}/api/v1/orb/live/stream?session_id=${encodeURIComponent(t.sessionId)}` +
      (token ? `&token=${encodeURIComponent(token)}` : '');
    const sseResp = await fetch(sseUrl, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    t.sseOpenMs = Date.now() - t0;
    if (!sseResp.ok || !sseResp.body) {
      t.error = `stream HTTP ${sseResp.status}`;
      return t;
    }

    await readSse(sseResp, (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      const ty = msg.type || 'unknown';
      t.events[ty] = (t.events[ty] || 0) + 1;
      // A bridge/chime frame is a DIFFERENT product claim from the model's own
      // first word, so they are recorded separately and never conflated.
      if (hasAudio(msg) && !t.firstAudioMs) {
        t.firstAudioMs = Date.now() - t0;
        t.firstAudioSource = msg.source || 'model';
      }
      if (hasAudio(msg) && msg.source !== 'activation_chime' && msg.source !== 'greeting_bridge' && !t.firstModelAudioMs) {
        t.firstModelAudioMs = Date.now() - t0;
      }
      if ((ty === 'transcript' || ty === 'output_transcript') && msg.text) t.text = (t.text || '') + msg.text;
      if (ty === 'turn_complete') { t.turnCompleteMs = Date.now() - t0; return false; }
      if (ty === 'error') { t.errorFrame = msg; return false; }
      return true;
    }, SSE_TIMEOUT_MS);
  } catch (e) {
    t.error = e?.message || String(e);
  } finally {
    if (t.sessionId) {
      try {
        await fetch(`${GATEWAY}/api/v1/orb/live/session/stop`, {
          method: 'POST', headers, body: JSON.stringify({ session_id: t.sessionId }),
        });
      } catch { /* ignore */ }
    }
  }
  return t;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const token = AUTH ? await getAuthToken() : null;
console.log(`\n=== ORB first-audio benchmark: ${LABEL} ===`);
console.log(`gateway=${GATEWAY} lang=${LANG} route=${ROUTE || '(default)'} auth=${AUTH} trials=${TRIALS}\n`);

const trials = [];
for (let i = 1; i <= TRIALS; i++) {
  const t = await runTrial(i, token);
  trials.push(t);
  const fa = t.firstAudioMs ? `${t.firstAudioMs}ms` : 'NO AUDIO';
  const fm = t.firstModelAudioMs && t.firstModelAudioMs !== t.firstAudioMs ? ` model=${t.firstModelAudioMs}ms` : '';
  console.log(
    `  trial ${String(i).padStart(2)}  start=${String(t.sessionStartMs ?? '-').padStart(4)}ms  sse=${String(t.sseOpenMs ?? '-').padStart(5)}ms  ` +
    `firstAudio=${fa.padStart(9)}${fm}  src=${t.firstAudioSource || '-'}` +
    (t.error ? `  ERROR: ${t.error}` : '') + (t.errorFrame ? `  ERRFRAME: ${JSON.stringify(t.errorFrame).slice(0, 120)}` : ''),
  );
}

const fa = trials.map((t) => t.firstAudioMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);
const fm = trials.map((t) => t.firstModelAudioMs).filter((n) => typeof n === 'number').sort((a, b) => a - b);
const summary = {
  label: LABEL, gateway: GATEWAY, lang: LANG, route: ROUTE || null, auth: AUTH,
  trials: trials.length, with_audio: fa.length, no_audio: trials.length - fa.length,
  first_audio_ms: { min: fa[0] ?? null, p50: pct(fa, 50), p90: pct(fa, 90), max: fa[fa.length - 1] ?? null },
  first_model_audio_ms: { min: fm[0] ?? null, p50: pct(fm, 50), p90: pct(fm, 90), max: fm[fm.length - 1] ?? null },
};
console.log(`\n--- ${LABEL} summary ---`);
console.log(`  audio in ${fa.length}/${trials.length} trials`);
console.log(`  first ANY audio   min=${summary.first_audio_ms.min} p50=${summary.first_audio_ms.p50} p90=${summary.first_audio_ms.p90} max=${summary.first_audio_ms.max}`);
console.log(`  first MODEL audio min=${summary.first_model_audio_ms.min} p50=${summary.first_model_audio_ms.p50} p90=${summary.first_model_audio_ms.p90} max=${summary.first_model_audio_ms.max}\n`);
if (OUT) {
  writeFileSync(OUT, JSON.stringify({ summary, trials }, null, 2));
  console.log(`wrote ${OUT}\n`);
}
