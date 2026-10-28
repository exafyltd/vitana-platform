#!/usr/bin/env npx ts-node
/**
 * VTID-03731 — the standing "test everything yourself" program for ORB
 * voice, across EVERY language the platform ships.
 *
 * Why this exists: this repo already has two narrower, real programs —
 * `verify-polly-voices.ts` (Polly voice table vs the live DescribeVoices
 * API) and `verify-cascade-audio-timing.ts` (real PCM audio timing for the
 * cascade languages plus a couple of Nova-baseline controls). Neither one
 * alone answers "is ORB voice actually working for every language we
 * claim to support" — that requires TWO things, checked TOGETHER, for
 * every language:
 *
 *   1. ROUTING is correct — the language reaches the provider it is
 *      supposed to (native Nova / the Transcribe->Bedrock->Polly cascade /
 *      Nova's documented substitute voice), and NEVER `vertex` (the
 *      VTID-03723 invariant — Vertex is not a destination any more).
 *   2. Real AUDIO actually comes back for whatever leg is supposed to
 *      produce it — not silence, not truncated, not mistimed, and not
 *      quietly speaking the wrong language.
 *
 * A language can pass either check alone and still be broken in
 * production for a user (exactly what happened to `pt`/`pl`/`tr` in turn:
 * VTID-03578/03681/03719/03730 each fixed one specific undeclared gap
 * that individually-narrow checks did not catch).
 *
 * WHAT MAKES THIS A REAL TEST, NOT A MOCK, matching the standard this
 * codebase already holds itself to (see `verify-cascade-audio-timing.ts`'s
 * own header):
 *   - Routing is read from `GET /api/v1/voice-lab/nova/decision` — the
 *     SAME selector (`selectUpstreamProvider()`) a real live session uses,
 *     via the SAME route the platform owner uses to manually verify a fix
 *     (see VTID-03729's whole reason for existing).
 *   - Audio is read from `POST /api/v1/orb/tts-pcm-diagnostic` — real
 *     network call, real AWS Polly synthesis, real bytes back, the exact
 *     route VTID-03716 built for this purpose. This script imports and
 *     reuses `testOneLanguage()`/`pacingBoundsFor()`/
 *     `loadRealPcmRateFromMime()`/`verifyWidgetWiringIsConnected()` from
 *     `verify-cascade-audio-timing.ts` rather than reimplementing them —
 *     one source of truth for what "real audio, correctly timed" means.
 *   - The language LIST itself is imported from
 *     `SUPPORTED_LIVE_LANGUAGES` (`orb/live/config.ts`), not hardcoded —
 *     so this program automatically covers the next language the moment
 *     it is added to the gate, with no separate edit required here. This
 *     mirrors `language-coverage.test.ts`'s own reasoning for why it
 *     iterates the gate instead of asserting a fixed list.
 *
 * `sr` is a DECLARED, not a silent, exception: Polly has no Serbian voice
 * in any engine (confirmed live, VTID-03495/BOOTSTRAP-POLLY-NARRATION-
 * CACHE), so `/tts-pcm-diagnostic` correctly 422s for it — this script
 * asserts that 422 rather than treating it as a failure, the same
 * EXPECTED-FAIL pattern `/command-hub/orb-voice-bench.html`'s TTS tab
 * already uses for `sr`. If Polly ever ships a Serbian voice, this script
 * will start failing that assertion loudly, which is the correct behavior
 * — see the note at `SERBIAN_EXPECTED_FAIL` below.
 *
 * Usage:
 *   GATEWAY_URL=https://preview-aws-gateway.vitanaland.com \
 *     npx ts-node --project services/gateway/tsconfig.json --transpile-only \
 *     scripts/tts/verify-all-orb-languages.ts
 *
 * Exits non-zero if any language fails a check it was not expected to.
 *
 * ⚠️ `/tts-pcm-diagnostic` carries its own real rate limit (20 req/15min,
 * see its own header in `routes/orb-live.ts` — deliberate, to stop an
 * unauthenticated caller racking up Polly billing). This program spends
 * ~11 of those 20 per full run (one per language, `sr`'s 422 probe
 * included). Running it twice inside the same 15-minute window WILL hit
 * 429 partway through the second run — that is the real limiter working
 * as designed, not a bug in this script. See
 * `docs/validation/VTID-03731/outputs/live-run.txt` for exactly that
 * happening on a real back-to-back run. Space runs out, or raise the
 * limiter deliberately, rather than "fixing" this by retrying past it.
 */

import { SUPPORTED_LIVE_LANGUAGES } from '../../services/gateway/src/orb/live/config';
import {
  testOneLanguage,
  pacingBoundsFor,
  loadRealPcmRateFromMime,
  verifyWidgetWiringIsConnected,
} from './verify-cascade-audio-timing';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com';
const DECISION_ENDPOINT = `${GATEWAY_URL}/api/v1/voice-lab/nova/decision`;

// One real, distinct test phrase per language — reusing the ones
// `verify-cascade-audio-timing.ts` already proved work, and adding the
// languages that script deliberately doesn't cover (its own scope is
// "cascade + Nova-baseline controls", not "every shipped language").
// `sr` gets a phrase too, purely for completeness of this table — it is
// never actually sent, because the TTS check for `sr` is the declared
// 422 assertion below, not a synthesis attempt.
const TEST_PHRASES: Record<string, string> = {
  en: 'Welcome to Vitana. This is a test message to verify the correct audio playback speed.',
  de: 'Willkommen bei Vitana. Dies ist eine Testnachricht, um die korrekte Wiedergabegeschwindigkeit des Audios zu überprüfen.',
  fr: "Bienvenue chez Vitana. Ceci est un message de test pour vérifier la vitesse de lecture audio correcte.",
  es: 'Bienvenido a Vitana. Este es un mensaje de prueba para verificar la velocidad correcta de reproducción del audio.',
  ar: 'مرحبًا بك في فيتانا. هذه رسالة اختبارية للتحقق من سرعة تشغيل الصوت الصحيحة.',
  zh: '欢迎使用维塔纳。这是一条测试消息，用于验证正确的音频播放速度。',
  sr: 'Добродошао у Витану. Ово је тестна порука за проверу тачне брзине репродукције звука.',
  ru: 'Добро пожаловать в Виtana. Это тестовое сообщение для проверки правильной скорости воспроизведения аудио.',
  pt: 'Bem-vindo à Vitana. Esta é uma mensagem de teste para verificar a velocidade correta de reprodução do áudio.',
  pl: 'Witamy w Vitana. To jest testowa wiadomość służąca do sprawdzenia poprawnej prędkości odtwarzania dźwięku.',
  tr: "Vitana'ya hoş geldin. Bu, doğru ses oynatma hızını doğrulamak için bir test mesajıdır.",
};

// Languages Nova speaks natively (NOVA_SONIC_SUPPORTED_LANGUAGES in
// nova-sonic-config.ts). Duplicated here as a literal, deliberately: this
// script's whole point is to catch the gate/table disagreeing with
// itself, so it must not import the very value it is trying to
// cross-check against — see the assertion in `checkRouting()` below,
// which fails LOUDLY (not silently adapts) if this literal and the live
// decision route ever disagree about which languages are Nova-native.
//
// VTID-03803 — `fr`/`es` removed, same reason `pt` was
// never in this set: each was found live-answering in English despite
// being "Nova-native" on paper, and now routes through the Polly cascade
// like `pt` does.
const NOVA_NATIVE = new Set(['en', 'de']);

// The one declared gap: Polly has no Serbian voice in any engine. Not a
// silent skip — every other language MUST produce real audio, `sr` MUST
// 422, and either result is loud (thrown / printed), never swallowed.
const SERBIAN_EXPECTED_FAIL = 'sr';

interface DecisionResponse {
  ok: boolean;
  decision?: { provider?: string; reason?: string };
}

interface LangReport {
  lang: string;
  routingPass: boolean;
  routingDetail: string;
  audioPass: boolean;
  audioDetails: string[];
}

async function checkRouting(lang: string): Promise<{ pass: boolean; detail: string }> {
  const res = await fetch(`${DECISION_ENDPOINT}?lang=${encodeURIComponent(lang)}`);
  const rawText = await res.text();
  let body: DecisionResponse;
  try {
    body = JSON.parse(rawText) as DecisionResponse;
  } catch {
    return { pass: false, detail: `FAIL: non-JSON response (status=${res.status}) — route likely not deployed: ${rawText.slice(0, 120)}` };
  }

  const provider = body.decision?.provider;
  const reason = body.decision?.reason;

  // The one invariant that must hold for EVERY language, no exceptions —
  // VTID-03723 removed Vertex as an ORB-voice destination entirely.
  if (provider === 'vertex') {
    return { pass: false, detail: `FAIL: provider="vertex" — VTID-03723 invariant violated for lang="${lang}"` };
  }

  if (NOVA_NATIVE.has(lang)) {
    if (provider !== 'nova_sonic') {
      return { pass: false, detail: `FAIL: expected nova_sonic (native) for lang="${lang}", got provider="${provider}" reason="${reason}"` };
    }
    return { pass: true, detail: `OK: provider=nova_sonic (native), reason=${reason}` };
  }

  if (lang === SERBIAN_EXPECTED_FAIL) {
    // sr has no Polly voice, so the cascade must never take it — it stays
    // forced onto Nova with the documented `tina` substitute regardless
    // of the cascade flag's state.
    if (provider !== 'nova_sonic') {
      return { pass: false, detail: `FAIL: expected nova_sonic (forced substitute) for lang="sr", got provider="${provider}"` };
    }
    return { pass: true, detail: `OK: provider=nova_sonic (forced substitute — no Polly voice), reason=${reason}` };
  }

  // Every remaining language (ar/zh/ru/pt/pl/tr, and whatever is added
  // next) is cascade-eligible. Whether it ACTUALLY cascades depends on
  // ORB_CASCADED_VOICE_ENABLED in this environment — both outcomes are
  // legitimate, so accept either, but require the reason to name the
  // real mechanism rather than something unexpected.
  if (provider === 'cascaded' && reason === 'cascaded_language_rescue') {
    return { pass: true, detail: `OK: provider=cascaded, reason=${reason}` };
  }
  if (provider === 'nova_sonic' && reason === 'nova_forced_vertex_unavailable') {
    return { pass: true, detail: `OK: provider=nova_sonic (cascade flag off in this env), reason=${reason}` };
  }
  return { pass: false, detail: `FAIL: unexpected routing for lang="${lang}" — provider="${provider}" reason="${reason}"` };
}

async function checkAudio(
  lang: string,
  pcmRateFromMime: (mime: string | undefined) => number,
): Promise<{ pass: boolean; details: string[] }> {
  if (lang === SERBIAN_EXPECTED_FAIL) {
    const res = await fetch(`${GATEWAY_URL}/api/v1/orb/tts-pcm-diagnostic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: TEST_PHRASES.sr, lang: 'sr' }),
    });
    if (res.status === 422) {
      return { pass: true, details: ['OK (EXPECTED-FAIL): Polly correctly refuses sr with 422 — no Serbian voice in any engine'] };
    }
    return {
      pass: false,
      details: [
        `FAIL: expected 422 for sr (declared Polly gap), got status=${res.status}. ` +
        'If Polly has shipped a Serbian voice, this is GOOD NEWS but this script, ' +
        'POLLY_UNSUPPORTED_LANGS, and CLAUDE.md §2c all need updating together — ' +
        'do not silence this assertion without doing that.',
      ],
    };
  }

  const text = TEST_PHRASES[lang];
  if (!text) {
    return {
      pass: false,
      details: [`FAIL: no test phrase defined for lang="${lang}" — SUPPORTED_LIVE_LANGUAGES gained a language this script does not know about yet. Add one to TEST_PHRASES.`],
    };
  }
  const result = await testOneLanguage(lang, text, pcmRateFromMime);
  return { pass: result.pass, details: result.details };
}

async function main(): Promise<void> {
  console.log(`[verify-all-orb-languages] gateway=${GATEWAY_URL}`);
  console.log(`[verify-all-orb-languages] testing ${SUPPORTED_LIVE_LANGUAGES.length} languages: ${SUPPORTED_LIVE_LANGUAGES.join(', ')}\n`);

  verifyWidgetWiringIsConnected();
  console.log('[verify-all-orb-languages] confirmed orb-widget.js createBuffer() is wired to the parsed PCM rate\n');

  const pcmRateFromMime = loadRealPcmRateFromMime();

  const reports: LangReport[] = [];

  for (const lang of SUPPORTED_LIVE_LANGUAGES) {
    process.stdout.write(`=== ${lang} ===\n`);

    let routing: { pass: boolean; detail: string };
    try {
      routing = await checkRouting(lang);
    } catch (err) {
      routing = { pass: false, detail: `FAIL: routing check threw — ${(err as Error).message}` };
    }
    console.log(`  routing: ${routing.detail}`);

    let audio: { pass: boolean; details: string[] };
    try {
      audio = await checkAudio(lang, pcmRateFromMime);
    } catch (err) {
      audio = { pass: false, details: [`FAIL: audio check threw — ${(err as Error).message}`] };
    }
    audio.details.forEach((d) => console.log(`  audio:   ${d}`));

    const overallPass = routing.pass && audio.pass;
    console.log(`  RESULT: ${overallPass ? 'PASS' : 'FAIL'}\n`);

    reports.push({
      lang,
      routingPass: routing.pass,
      routingDetail: routing.detail,
      audioPass: audio.pass,
      audioDetails: audio.details,
    });
  }

  console.log('=== SUMMARY ===');
  const pad = Math.max(...reports.map((r) => r.lang.length));
  for (const r of reports) {
    const overall = r.routingPass && r.audioPass ? 'PASS' : 'FAIL';
    console.log(
      `  ${r.lang.padEnd(pad)}  routing=${r.routingPass ? 'OK  ' : 'FAIL'}  audio=${r.audioPass ? 'OK  ' : 'FAIL'}  ${overall}`,
    );
  }

  const failed = reports.filter((r) => !(r.routingPass && r.audioPass));
  console.log(`\n=== ${reports.length - failed.length}/${reports.length} languages fully passed (routing + real audio) ===`);

  if (failed.length > 0) {
    console.log(`\nFAILED: ${failed.map((r) => r.lang).join(', ')}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[verify-all-orb-languages] fatal error:', err);
    process.exitCode = 1;
  });
}

export { checkRouting, checkAudio, TEST_PHRASES, NOVA_NATIVE, SERBIAN_EXPECTED_FAIL, main };
