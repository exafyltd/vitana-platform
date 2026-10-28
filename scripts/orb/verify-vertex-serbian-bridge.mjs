#!/usr/bin/env node
/**
 * Live verification tool for the Vertex Serbian bridge (VTID-04000,
 * upstream-provider-selector.ts's tryVertexBridgeRescue). Calls the SAME
 * gateway endpoints the ORB widget's own SSE transport calls — no browser,
 * no WebSocket (this sandbox's outbound proxy cannot complete a WS
 * upgrade against this host; SSE works fine and is byte-identical from
 * the gateway's point of view):
 *
 *   1. POST /api/v1/orb/live/session/start   { lang: 'sr' }
 *   2. POST /api/v1/orb/session/:id/audio-ready
 *   3. GET  /api/v1/orb/live/stream?session_id=:id   (SSE, parsed by hand)
 *   4. POST /api/v1/orb/live/session/stop
 *
 * Built while investigating VTID-04010 -> VTID-04014 -> VTID-04015 (see
 * docs/HANDOFF-VERTEX-SERBIAN-1007-2026-09-17.md for the full story).
 * KEEP THIS SCRIPT — the investigation is NOT finished, and rebuilding
 * this tooling from scratch cost real time twice already.
 *
 * Usage:
 *   node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=anonymous [--trials=10]
 *   node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated --trials=10
 *   node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated --route=/admin   # smaller tool catalog (VTID-04026)
 *   node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated --utterance-pcm=/path/to/16k-mono-pcm16.raw
 *     (VTID-04036: after the greeting's turn_complete, streams that PCM plus
 *     trailing silence as the user's turn over /live/stream/send and waits
 *     for the model's reply — the tool-response leg is what this exercises,
 *     so any language works; the bridge answers in Serbian. --end-turn also
 *     POSTs /live/stream/end-turn, which the real widget never does.)
 *     (authenticated mode needs SUPABASE_ANON_KEY + TEST_ACCOUNT_EMAIL +
 *     TEST_ACCOUNT_PASSWORD in the environment — never hardcode credentials
 *     in this file. The documented test account is
 *     a27552a3-0257-4305-8ed0-351a80fd3701 / e2e-test@vitana.dev, per
 *     CLAUDE.md's "Test user UUID" section — get the password from the
 *     platform owner or wherever it is already stored, do not guess it.)
 *
 * Env vars:
 *   GATEWAY_URL              default https://preview-aws-gateway.vitanaland.com
 *   ORIGIN_URL                default https://preview-aws.vitanaland.com
 *   SUPABASE_URL               default the shared project's URL (see CLAUDE.md)
 *   SUPABASE_ANON_KEY          required for --mode=authenticated (public/publishable key, not a secret)
 *   TEST_ACCOUNT_EMAIL         required for --mode=authenticated
 *   TEST_ACCOUNT_PASSWORD      required for --mode=authenticated
 *   LANG_CODE                  default 'sr'
 *
 * This account is registered for narrowly-scoped, recorded voice-session
 * verification only (CLAUDE.md's documented exception) — never use it to
 * write community content, never widen its use beyond this kind of read/
 * verify call.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);

const MODE = args.mode || 'anonymous'; // 'anonymous' | 'authenticated'
const TRIALS = parseInt(args.trials || process.env.TRIALS || '10', 10);
const GATEWAY = process.env.GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com';
const ORIGIN = process.env.ORIGIN_URL || 'https://preview-aws.vitanaland.com';
const LANG = process.env.LANG_CODE || 'sr';
// VTID-04026: optional `current_route` for session/start. The gateway resolves
// the ORB surface (and therefore the tool catalog it declares to the upstream
// model) from this route — `/admin` declares ~134 tools, the default
// vitanaland surface ~290 — so it is the one knob that changes the setup
// envelope's size without touching code. Used to isolate the tool-catalog
// size as the cause of the authenticated-only 1007 closes.
const ROUTE = typeof args.route === 'string' ? args.route : '';
// VTID-04036: optional user turn. A raw 16 kHz mono PCM16 file streamed after
// the greeting's turn_complete so a question that needs a tool
// (get_day_summary, …) can be driven end to end without a browser.
const UTTERANCE_PCM = typeof args['utterance-pcm'] === 'string' ? args['utterance-pcm'] : '';
const UTTERANCE_BYTES = UTTERANCE_PCM ? readFileSync(UTTERANCE_PCM) : null;
const UTTERANCE_CHUNK_BYTES = 3200; // 100 ms at 16 kHz mono PCM16
const UTTERANCE_PRE_DELAY_MS = 1500; // clears the server's post-turn mic cooldown (300 ms default)
// The real widget never calls /live/stream/end-turn — Gemini Live's own
// activity detection ends the user's turn on silence. Sending
// client_content{turn_complete:true} on an audio-only session closes the
// socket 1007 (measured 2026-09-18, 2/2), so the default is trailing
// silence; --end-turn opts into the explicit signal for experiments.
const UTTERANCE_TRAILING_SILENCE_MS = 1800;
const UTTERANCE_USE_END_TURN = args['end-turn'] === true || args['end-turn'] === 'true';
const SSE_TIMEOUT_MS = 40000; // server's own greeting_timeout watchdog is 30s
const GAP_BETWEEN_TRIALS_MS = 2000;

function nowIso() {
  return new Date().toISOString();
}

async function getAuthToken() {
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
  const apikey = process.env.SUPABASE_ANON_KEY;
  const email = process.env.TEST_ACCOUNT_EMAIL;
  const password = process.env.TEST_ACCOUNT_PASSWORD;
  if (!apikey || !email || !password) {
    throw new Error(
      'authenticated mode needs SUPABASE_ANON_KEY, TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_PASSWORD in the environment',
    );
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

// VTID-04036: stream the utterance as the user's turn over the SSE transport's
// input endpoints (byte-identical to what the widget sends).
async function sendUtterance(trial, headers) {
  await new Promise((r) => setTimeout(r, UTTERANCE_PRE_DELAY_MS));
  trial.utteranceSentAt = Date.now();
  trial.utteranceChunks = 0;
  trial.utteranceSendErrors = [];
  const silence = Buffer.alloc((UTTERANCE_TRAILING_SILENCE_MS / 1000) * 32000);
  const stream = UTTERANCE_USE_END_TURN ? UTTERANCE_BYTES : Buffer.concat([UTTERANCE_BYTES, silence]);
  for (let off = 0; off < stream.length; off += UTTERANCE_CHUNK_BYTES) {
    const chunk = stream.subarray(off, off + UTTERANCE_CHUNK_BYTES);
    try {
      const r = await fetch(`${GATEWAY}/api/v1/orb/live/stream/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: trial.sessionId,
          type: 'audio',
          data_b64: chunk.toString('base64'),
          mime: 'audio/pcm;rate=16000',
        }),
      });
      if (!r.ok) trial.utteranceSendErrors.push(`send: HTTP ${r.status}`);
      trial.utteranceChunks++;
    } catch (e) {
      trial.utteranceSendErrors.push(`send: ${e && e.message}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (UTTERANCE_USE_END_TURN) {
    try {
      const r = await fetch(`${GATEWAY}/api/v1/orb/live/stream/end-turn`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: trial.sessionId }),
      });
      trial.endTurnHttpStatus = r.status;
    } catch (e) {
      trial.utteranceSendErrors.push(`end-turn: ${e && e.message}`);
    }
  }
  trial.utteranceDoneAt = Date.now();
}

async function readSse(resp, onEvent, deadlineMs) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + deadlineMs;
  let stopRequested = false;
  try {
    while (Date.now() < deadline && !stopRequested) {
      const remaining = deadline - Date.now();
      const readPromise = reader.read();
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), Math.max(50, remaining)),
      );
      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result.timedOut) break;
      const { done, value } = result;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = rawEvent.split('\n').filter((l) => l.startsWith('data:'));
        if (dataLines.length) {
          const data = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          const keepGoing = onEvent(data);
          if (keepGoing === false) stopRequested = true;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

async function runTrial(idx, token) {
  const trial = { idx, startedAt: nowIso(), lang: LANG, authenticated: !!token, route: ROUTE || null };
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    trial.sessionStartRequestAt = Date.now();
    const startResp = await fetch(`${GATEWAY}/api/v1/orb/live/session/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify(ROUTE ? { lang: LANG, current_route: ROUTE } : { lang: LANG }),
    });
    trial.sessionStartRespondedAt = Date.now();
    trial.sessionStartHttpStatus = startResp.status;
    const startBody = await startResp.json().catch(() => null);
    if (!startResp.ok || !startBody || !startBody.ok) {
      trial.httpErrors = [`session/start: HTTP ${startResp.status} ${JSON.stringify(startBody)}`];
      return trial;
    }
    trial.sessionId = startBody.session_id;
    trial.conversationId = startBody.conversation_id || null;

    fetch(`${GATEWAY}/api/v1/orb/session/${encodeURIComponent(trial.sessionId)}/audio-ready`, {
      method: 'POST',
      headers,
      body: '{}',
    }).catch(() => {});

    const sseUrl = token
      ? `${GATEWAY}/api/v1/orb/live/stream?session_id=${encodeURIComponent(trial.sessionId)}&token=${encodeURIComponent(token)}`
      : `${GATEWAY}/api/v1/orb/live/stream?session_id=${encodeURIComponent(trial.sessionId)}`;
    const sseResp = await fetch(sseUrl, { method: 'GET', headers: { Accept: 'text/event-stream', Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    trial.sseOpenAt = Date.now();
    trial.sseHttpStatus = sseResp.status;
    if (!sseResp.ok || !sseResp.body) {
      trial.httpErrors = [`stream: HTTP ${sseResp.status}`];
      return trial;
    }

    trial.eventCounts = {};
    trial.transcriptText = '';
    let utterancePromise = null;
    await readSse(
      sseResp,
      (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        const t = msg.type || 'unknown';
        trial.eventCounts[t] = (trial.eventCounts[t] || 0) + 1;
        if ((t === 'audio' || t === 'audio_out') && (msg.data_b64 || msg.audio_b64) && !trial.firstAudioAt) {
          trial.firstAudioAt = Date.now();
        }
        if ((t === 'transcript' || t === 'output_transcript') && msg.text) {
          if (trial.utteranceSentAt) trial.replyTranscriptText = (trial.replyTranscriptText || '') + msg.text;
          else trial.transcriptText += msg.text;
        }
        if (t === 'input_transcript' && msg.text) trial.inputTranscriptText = (trial.inputTranscriptText || '') + msg.text;
        if ((t === 'audio' || t === 'audio_out') && (msg.data_b64 || msg.audio_b64) && trial.utteranceSentAt && !trial.replyFirstAudioAt) {
          trial.replyFirstAudioAt = Date.now();
        }
        if (t === 'turn_complete') {
          trial.turnsCompleted = (trial.turnsCompleted || 0) + 1;
          trial.turnCompleted = true;
          if (UTTERANCE_BYTES && trial.turnsCompleted === 1) {
            // VTID-04036: greeting done — now the user's turn. Not awaited:
            // the SSE reader must keep draining while the chunks go up.
            utterancePromise = sendUtterance(trial, headers);
            return true;
          }
          if (UTTERANCE_BYTES && trial.turnsCompleted === 2) {
            trial.replyTurnCompleted = true;
          }
          return false;
        }
        if (t === 'error') {
          trial.errorFrame = msg;
          return false;
        }
        return true;
      },
      UTTERANCE_BYTES ? SSE_TIMEOUT_MS * 2 : SSE_TIMEOUT_MS,
    );
    if (utterancePromise) await utterancePromise.catch(() => {});
  } catch (e) {
    trial.exception = e && e.message;
  } finally {
    if (trial.sessionId) {
      try {
        await fetch(`${GATEWAY}/api/v1/orb/live/session/stop`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ session_id: trial.sessionId }),
        });
      } catch {
        /* ignore */
      }
    }
  }
  if (trial.sessionStartRespondedAt && trial.firstAudioAt) {
    trial.latencyMsFromStart = trial.firstAudioAt - trial.sessionStartRespondedAt;
  }
  if (trial.utteranceDoneAt && trial.replyFirstAudioAt) {
    trial.replyLatencyMsFromEndTurn = trial.replyFirstAudioAt - trial.utteranceDoneAt;
  }
  trial.finishedAt = nowIso();
  return trial;
}

(async () => {
  const token = MODE === 'authenticated' ? await getAuthToken() : null;
  console.log(
    `[verify-vertex-serbian-bridge] ${TRIALS} ${MODE.toUpperCase()} trials against ${GATEWAY}, lang=${LANG}${ROUTE ? `, current_route=${ROUTE}` : ''}`,
  );
  const results = [];
  for (let i = 1; i <= TRIALS; i++) {
    console.log(`\n--- trial ${i}/${TRIALS} ---`);
    const t = await runTrial(i, token);
    console.log(JSON.stringify(t, null, 2));
    results.push(t);
    if (i < TRIALS) await new Promise((r) => setTimeout(r, GAP_BETWEEN_TRIALS_MS));
  }
  const outPath = `/tmp/vertex-serbian-bridge-${MODE}${ROUTE ? '-' + ROUTE.replace(/[^a-z0-9]+/gi, '_') : ''}-results.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n(full results written to ${outPath})`);

  console.log(`\n==================== SUMMARY (${MODE}) ====================`);
  const withAudio = results.filter((r) => r.firstAudioAt);
  const turnCompleted = results.filter((r) => r.turnCompleted);
  if (UTTERANCE_BYTES) {
    const replied = results.filter((r) => r.replyFirstAudioAt);
    const replyDone = results.filter((r) => r.replyTurnCompleted);
    console.log(
      `VTID-04036 user turn: utterance sent on ${results.filter((r) => r.utteranceSentAt).length}/${results.length}, ` +
        `reply audio on ${replied.length}, reply turn_complete on ${replyDone.length}, ` +
        `errors after utterance: ${results.filter((r) => r.errorFrame && r.utteranceSentAt).length}`,
    );
  }
  console.log(
    `Trials: ${results.length}, session/start OK: ${results.filter((r) => r.sessionId).length}, ` +
      `SSE 200: ${results.filter((r) => r.sseHttpStatus === 200).length}, Got audio: ${withAudio.length}, ` +
      `turn_complete: ${turnCompleted.length}`,
  );
  const lat = withAudio.map((r) => r.latencyMsFromStart).filter((x) => x != null);
  if (lat.length) console.log('Latency ms:', lat.join(', '));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
