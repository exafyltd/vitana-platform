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
import { writeFileSync } from 'node:fs';

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
const ROUTE = args.route || process.env.CURRENT_ROUTE || '';
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
        if ((t === 'transcript' || t === 'output_transcript') && msg.text) trial.transcriptText += msg.text;
        if (t === 'turn_complete') {
          trial.turnCompleted = true;
          return false;
        }
        if (t === 'error') {
          trial.errorFrame = msg;
          return false;
        }
        return true;
      },
      SSE_TIMEOUT_MS,
    );
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
