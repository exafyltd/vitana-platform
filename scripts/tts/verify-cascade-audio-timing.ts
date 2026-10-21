#!/usr/bin/env npx ts-node
/**
 * VTID-03716 — automated, self-verifying proof that cascade-voice PCM audio
 * plays back at the correct speed, using REAL Polly audio and the REAL
 * shipped widget code. No human listener, no live ORB session.
 *
 * Background: VTID-03711 was a live production bug reported as "Polly TTS
 * speaks for all wired languages in Mickey Mouse speed" — orb-widget.js
 * hardcoded `ctx.createBuffer(1, floats.length, 24000)` for every PCM
 * chunk regardless of its actual declared rate, so 16kHz Polly audio (the
 * cascade-voice path's real output) played back 1.5x too fast. The fix
 * (`_pcmRateFromMime()`) was verified with unit tests, but the platform
 * owner explicitly rejected relying on a human to listen to a live session
 * and directed that verification be a program Claude writes and runs
 * itself. This script is that program.
 *
 * What makes this a REAL test, not a mock:
 *   1. It calls `POST /api/v1/orb/tts-pcm-diagnostic` against the actual
 *      deployed gateway — real network call, real AWS Polly synthesis,
 *      real bytes back. Not a local fixture.
 *   2. It does NOT reimplement `_pcmRateFromMime()` — it extracts the
 *      function's literal source text out of the shipped
 *      `services/gateway/src/frontend/command-hub/orb-widget.js` and
 *      executes THAT, so there is zero risk of the test quietly drifting
 *      from what ships to real users.
 *   3. Duration math (`AudioBuffer.duration = frameCount / sampleRate`) is
 *      the W3C Web Audio API spec's own definition, not this script's
 *      assumption — https://www.w3.org/TR/webaudio/#dom-audiobuffer-duration
 *   4. It reproduces the OLD buggy behavior mathematically against the
 *      SAME real bytes (frameCount / 24000) and shows the exact 1.5x
 *      speed-up the fix eliminates, rather than merely asserting the new
 *      code "looks right."
 *
 * Why this doesn't touch the live ORB session / Supabase at all:
 *   `/tts-pcm-diagnostic` is a stateless (text, lang) -> audio call —
 *   no session, no `oasis_events` beyond routine TTS telemetry, no
 *   account write of any kind. It is the PCM-format sibling of the
 *   existing `/orb/tts` (MP3) and `/voice/preview` (MP3, admin) routes,
 *   both already optionalAuth/stateless. A live ORB voice session is a
 *   fundamentally different thing — it creates session state and can
 *   trigger memory extraction, which is exactly the write CLAUDE.md's
 *   absolute test-account rule forbids regardless of who/what opens it.
 *
 * Usage:
 *   GATEWAY_URL=https://preview-aws-gateway.vitanaland.com \
 *     npx ts-node scripts/tts/verify-cascade-audio-timing.ts
 *
 * Exits non-zero if ANY language fails ANY check.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com';
const ENDPOINT = `${GATEWAY_URL}/api/v1/orb/tts-pcm-diagnostic`;

// The 5 languages ORB_CASCADED_VOICE_ENABLED routes through the
// Transcribe->Bedrock->Polly cascade (Nova cannot speak them natively) —
// see NOVA_SONIC_SUPPORTED_LANGUAGES in nova-sonic-config.ts (en/de/fr/es/pt)
// and cascaded-config.ts. de/en included as a Nova-baseline sanity control —
// Polly can synthesize them too even though live sessions wouldn't cascade.
const TEST_CASES: Array<{ lang: string; text: string }> = [
  { lang: 'ru', text: 'Добро пожаловать в Виtana. Это тестовое сообщение для проверки правильной скорости воспроизведения аудио.' },
  { lang: 'pl', text: 'Witamy w Vitana. To jest testowa wiadomość służąca do sprawdzenia poprawnej prędkości odtwarzania dźwięku.' },
  { lang: 'ar', text: 'مرحبًا بك في فيتانا. هذه رسالة اختبارية للتحقق من سرعة تشغيل الصوت الصحيحة.' },
  { lang: 'zh', text: '欢迎使用维塔纳。这是一条测试消息，用于验证正确的音频播放速度。' },
  // VTID-03719 — tr was missing entirely despite being a cascade-voice
  // language (nova-sonic-config.ts's NOVA_SONIC_SUPPORTED_LANGUAGES does not
  // include it). Adding it here only became meaningful once polly.ts also
  // gained a real tr entry (VTID-03719) — before that, resolvePollyVoice('tr')
  // silently fell back to English, so this line would have passed while
  // testing the wrong language entirely, which is worse than not testing it.
  { lang: 'tr', text: "Vitana'ya hoş geldin. Bu, doğru ses oynatma hızını doğrulamak için bir test mesajıdır." },
  { lang: 'de', text: 'Willkommen bei Vitana. Dies ist eine Testnachricht, um die korrekte Wiedergabegeschwindigkeit des Audios zu überprüfen.' },
  { lang: 'en', text: 'Welcome to Vitana. This is a test message to verify the correct audio playback speed.' },
];

const OLD_BUGGY_HARDCODED_RATE = 24000; // the literal orb-widget.js used to pass to createBuffer()

// VTID-03719 — a single alphabetic-language pacing band does not transfer to
// a logographic script, the exact class of mistake this codebase has already
// been burned by once (translator.ts's own docstring: a French register regex
// produced 39/41 false positives on `rendez-vous`, because a rule tuned on one
// language does not transfer). Chinese is denser per character — each glyph
// typically carries a full syllable's worth of phonetic content — so natural
// Mandarin speech runs roughly 3-5 chars/sec, well under the 6 chars/sec floor
// that is a safe minimum for alphabetic scripts. Measured live against real
// Polly audio (Zhiyu, neural): 31 chars / 6.330s = 4.9 chars/sec, comfortably
// inside a CJK-appropriate band and NOT evidence of truncated/garbled audio.
// Every other check (sample count, PCM rate parsing, duration match) already
// caught real defects independent of this heuristic — this only widens the
// one check whose calibration does not generalize across scripts.
const CJK_LANGS = new Set(['zh']);
const PACING_BOUNDS = { default: { min: 6, max: 30 }, cjk: { min: 2, max: 10 } };
function pacingBoundsFor(lang: string): { min: number; max: number } {
  return CJK_LANGS.has(lang) ? PACING_BOUNDS.cjk : PACING_BOUNDS.default;
}

/**
 * Extract `_pcmRateFromMime`'s literal source out of the shipped widget
 * file and turn it into a callable function — executing the REAL shipped
 * logic, not a hand-typed copy that could silently diverge from it.
 */
function loadRealPcmRateFromMime(): (mime: string | undefined) => number {
  const widgetPath = join(__dirname, '../../services/gateway/src/frontend/command-hub/orb-widget.js');
  const source = readFileSync(widgetPath, 'utf8');
  const match = source.match(/function _pcmRateFromMime\(mime\)\s*\{[\s\S]*?\n  \}/);
  if (!match) {
    throw new Error(
      '_pcmRateFromMime not found in orb-widget.js — the widget was refactored ' +
      'and this test needs updating to match, not silently skipped.',
    );
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${match[0]}\nreturn _pcmRateFromMime;`)();
  return fn as (mime: string | undefined) => number;
}

/**
 * Codex review fix (P2, PR #3173): `loadRealPcmRateFromMime()` proves the
 * EXTRACTED parser function is correct in isolation — but a regression
 * could revert the widget's actual playback call site back to
 * `createBuffer(1, floats.length, 24000)` while leaving the now-unused
 * `_pcmRateFromMime()` helper untouched. Every per-language check below
 * would still pass in that case, silently missing the exact "Mickey Mouse
 * speed" defect (VTID-03711) this whole program exists to catch. This
 * verifies the WIRING itself: the real `createBuffer()` call site passes a
 * variable sourced from `_pcmRateFromMime()`, not a hardcoded literal.
 */
function verifyWidgetWiringIsConnected(): void {
  const widgetPath = join(__dirname, '../../services/gateway/src/frontend/command-hub/orb-widget.js');
  const source = readFileSync(widgetPath, 'utf8');

  const rateAssignMatch = source.match(/var (\w+) = _pcmRateFromMime\((\w+)\.mime\);/);
  if (!rateAssignMatch) {
    throw new Error(
      'orb-widget.js: could not find "var X = _pcmRateFromMime(chunk.mime);" — the widget ' +
      'playback wiring was refactored and this structural check needs updating, not silently skipped.',
    );
  }
  const rateVar = rateAssignMatch[1];

  const createBufferPattern = new RegExp(`ctx\\.createBuffer\\(1,\\s*[\\w.]+,\\s*${rateVar}\\)`);
  if (!createBufferPattern.test(source)) {
    throw new Error(
      `orb-widget.js: createBuffer() is not called with '${rateVar}' (the parsed PCM rate) — ` +
      'this is the exact VTID-03711 regression (a hardcoded sample rate) this program exists to catch.',
    );
  }
}

interface DiagnosticResponse {
  ok: boolean;
  audio_b64?: string;
  sample_rate_hz?: number;
  mime?: string;
  voice?: string;
  engine?: string;
  lang?: string;
  error?: string;
}

interface CheckResult {
  lang: string;
  pass: boolean;
  details: string[];
}

async function testOneLanguage(
  lang: string,
  text: string,
  pcmRateFromMime: (mime: string | undefined) => number,
): Promise<CheckResult> {
  const details: string[] = [];
  let pass = true;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang }),
  });
  const contentType = res.headers.get('content-type') || '';
  const rawText = await res.text();
  let body: DiagnosticResponse;
  try {
    body = JSON.parse(rawText) as DiagnosticResponse;
  } catch {
    // The CLAUDE.md diagnostic: an HTML response here means the route does
    // not exist on the code actually deployed — not a JSON error body.
    return {
      lang,
      pass: false,
      details: [
        `FAIL: non-JSON response (status=${res.status}, content-type=${contentType}) — ` +
        `the route likely isn't deployed on this target yet: ${rawText.slice(0, 120)}`,
      ],
    };
  }

  if (!res.ok || !body.ok || !body.audio_b64 || !body.sample_rate_hz || !body.mime) {
    return {
      lang,
      pass: false,
      details: [`FAIL: request failed — status=${res.status} error=${body.error || 'no audio returned'}`],
    };
  }

  const bytes = Buffer.from(body.audio_b64, 'base64');
  // PCM is 16-bit signed mono (per polly.ts) — 2 bytes/sample.
  const sampleCount = Math.floor(bytes.length / 2);
  const declaredRate = body.sample_rate_hz;
  const trueDurationSec = sampleCount / declaredRate;

  details.push(`voice=${body.voice} engine=${body.engine} mime=${body.mime}`);
  details.push(`audio_bytes=${bytes.length} samples=${sampleCount} declared_rate=${declaredRate}Hz`);
  details.push(`TRUE duration (samples / declared_rate) = ${trueDurationSec.toFixed(3)}s`);

  // Check 1: real audio actually came back (catches silent/empty/truncated synthesis).
  if (sampleCount < 1000) {
    pass = false;
    details.push(`FAIL: only ${sampleCount} samples — suspiciously little audio for ${text.length} chars`);
  }

  // Check 2: plausible human-speech pacing for the input length. Bounds are
  // script-aware (see pacingBoundsFor/CJK_LANGS above) — a uniform alphabetic
  // band false-positives on logographic languages, where each character
  // carries more phonetic content than a Latin/Cyrillic/Arabic letter.
  const { min: pacingMin, max: pacingMax } = pacingBoundsFor(lang);
  const charsPerSec = text.length / trueDurationSec;
  if (charsPerSec < pacingMin || charsPerSec > pacingMax) {
    pass = false;
    details.push(
      `FAIL: ${charsPerSec.toFixed(1)} chars/sec is outside plausible human-speech range ` +
      `(${pacingMin}-${pacingMax} for lang=${lang}) — audio may be truncated, garbled, or mis-timed`,
    );
  } else {
    details.push(`OK: ${charsPerSec.toFixed(1)} chars/sec — plausible human speech pacing (${pacingMin}-${pacingMax} for lang=${lang})`);
  }

  // Check 3: the REAL, extracted widget function parses this REAL mime
  // string to the REAL declared rate — not assumed, executed.
  const parsedRate = pcmRateFromMime(body.mime);
  if (parsedRate !== declaredRate) {
    pass = false;
    details.push(
      `FAIL: _pcmRateFromMime('${body.mime}') returned ${parsedRate}, expected ${declaredRate} ` +
      `— the widget would mis-decode this exact real audio`,
    );
  } else {
    details.push(`OK: _pcmRateFromMime('${body.mime}') === ${parsedRate} (matches declared rate)`);
  }

  // Check 4: the FIXED widget code's resulting playback duration (per the
  // Web Audio spec, AudioBuffer.duration = frameCount / sampleRate) exactly
  // matches the true duration of this real audio.
  const fixedDurationSec = sampleCount / parsedRate;
  const fixedDeltaMs = Math.abs(fixedDurationSec - trueDurationSec) * 1000;
  if (fixedDeltaMs > 1) {
    pass = false;
    details.push(`FAIL: fixed-code duration ${fixedDurationSec.toFixed(3)}s differs from true duration by ${fixedDeltaMs.toFixed(1)}ms`);
  } else {
    details.push(`OK: FIXED code plays this real audio at ${fixedDurationSec.toFixed(3)}s — correct`);
  }

  // Check 5 (informational, always computed): what the OLD buggy code
  // (hardcoded createBuffer(..., 24000)) would have done to this SAME real
  // audio — proves the regression this fix eliminates, using real bytes.
  const oldBuggyDurationSec = sampleCount / OLD_BUGGY_HARDCODED_RATE;
  const speedupFactor = trueDurationSec / oldBuggyDurationSec;
  if (declaredRate !== OLD_BUGGY_HARDCODED_RATE) {
    details.push(
      `INFO: OLD buggy code would have played this at ${oldBuggyDurationSec.toFixed(3)}s ` +
      `(${speedupFactor.toFixed(2)}x too fast — the "Mickey Mouse" defect, reproduced against real audio)`,
    );
  } else {
    details.push('INFO: declared rate equals the old hardcoded constant — no speed defect for this sample');
  }

  return { lang, pass, details };
}

async function main(): Promise<void> {
  console.log(`[verify-cascade-audio-timing] endpoint=${ENDPOINT}\n`);

  verifyWidgetWiringIsConnected();
  console.log('[verify-cascade-audio-timing] confirmed createBuffer() is wired to the parsed PCM rate, not a hardcoded literal\n');

  const pcmRateFromMime = loadRealPcmRateFromMime();
  console.log('[verify-cascade-audio-timing] loaded REAL _pcmRateFromMime from orb-widget.js (not reimplemented)\n');

  const results: CheckResult[] = [];
  for (const { lang, text } of TEST_CASES) {
    process.stdout.write(`--- ${lang} ---\n`);
    let result: CheckResult;
    try {
      result = await testOneLanguage(lang, text, pcmRateFromMime);
    } catch (err) {
      result = { lang, pass: false, details: [`FAIL: unexpected error — ${(err as Error).message}`] };
    }
    result.details.forEach((d) => console.log(`  ${d}`));
    console.log(`  RESULT: ${result.pass ? 'PASS' : 'FAIL'}\n`);
    results.push(result);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`=== ${passed}/${total} languages passed ===`);

  if (passed !== total) {
    process.exitCode = 1;
  }
}

// VTID-03716 review fix: guarded so this module can be `require()`d by a
// unit test (see services/gateway/test/scripts/verify-cascade-audio-timing.test.ts)
// without firing real network calls — only the actual CLI invocation runs main().
if (require.main === module) {
  main().catch((err) => {
    console.error('[verify-cascade-audio-timing] fatal error:', err);
    process.exitCode = 1;
  });
}

export { verifyWidgetWiringIsConnected, loadRealPcmRateFromMime, testOneLanguage, pacingBoundsFor, main };
