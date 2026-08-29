#!/usr/bin/env npx ts-node
/**
 * VTID-03495 — verify the Polly voice table against the LIVE Polly API.
 *
 * The voice/engine pairs in `services/gateway/src/services/tts/polly.ts` and
 * the "Polly has no Serbian voice" claim were derived from Polly's published
 * voice list, NOT from a live API call — the session that wrote them had no
 * working AWS credentials. Run this before flipping `TTS_PROVIDER=polly`.
 *
 * Checks, per language in the table:
 *   - the VoiceId exists in the target region
 *   - it actually supports the engine we pin (a voice existing does NOT mean
 *     it supports `neural` — that is the most likely way this table is wrong)
 *   - the language code matches
 * Then re-checks that no Serbian voice has appeared since (if one has, the
 * `POLLY_UNSUPPORTED_LANGS` entry and the shutdown blocker both go away).
 *
 * Usage:  AWS_POLLY_REGION=eu-central-1 npx ts-node scripts/tts/verify-polly-voices.ts
 * Exits non-zero if any pinned voice/engine pair is not live.
 */

import { PollyClient, DescribeVoicesCommand } from '@aws-sdk/client-polly';

// Mirrors POLLY_VOICES in services/gateway/src/services/tts/polly.ts.
// Kept as a literal here on purpose: this script must fail if the two drift,
// which is the whole point of an independent verification pass.
const EXPECTED: Record<string, { voiceId: string; engine: string; languageCode: string }> = {
  en: { voiceId: 'Joanna', engine: 'neural', languageCode: 'en-US' },
  de: { voiceId: 'Vicki', engine: 'neural', languageCode: 'de-DE' },
  fr: { voiceId: 'Lea', engine: 'neural', languageCode: 'fr-FR' },
  es: { voiceId: 'Lucia', engine: 'neural', languageCode: 'es-ES' },
  ar: { voiceId: 'Hala', engine: 'neural', languageCode: 'ar-AE' },
  zh: { voiceId: 'Zhiyu', engine: 'neural', languageCode: 'cmn-CN' },
  ru: { voiceId: 'Tatyana', engine: 'standard', languageCode: 'ru-RU' },
  // VTID-03719 — Burcu (neural), not the standard-only Filiz. Verified live
  // via a real `describe-voices`/`synthesize-speech` call against tr-TR;
  // matches POLLY_VOICES.tr in polly.ts exactly (pt/pl share this script's
  // pre-existing gap of never having been added here, not introduced now).
  tr: { voiceId: 'Burcu', engine: 'neural', languageCode: 'tr-TR' },
};

const SERBIAN_PREFIXES = ['sr'];

async function main(): Promise<void> {
  const region = process.env.AWS_POLLY_REGION || process.env.AWS_REGION || 'eu-central-1';
  const client = new PollyClient({ region });
  console.log(`[verify-polly] region=${region}`);

  const voices: Array<{ Id?: string; LanguageCode?: string; SupportedEngines?: string[] }> = [];
  let token: string | undefined;
  do {
    const page = await client.send(new DescribeVoicesCommand({ NextToken: token }));
    voices.push(...(page.Voices ?? []));
    token = page.NextToken;
  } while (token);

  console.log(`[verify-polly] ${voices.length} voices visible in ${region}\n`);

  let failures = 0;
  // Advisory, never a failure — see the engine-upgrade block below.
  let upgrades = 0;
  for (const [lang, want] of Object.entries(EXPECTED)) {
    const found = voices.find((v) => v.Id === want.voiceId);
    if (!found) {
      console.error(`✗ ${lang}: voice '${want.voiceId}' NOT FOUND in ${region}`);
      failures++;
      continue;
    }
    const engines = found.SupportedEngines ?? [];
    if (!engines.includes(want.engine)) {
      console.error(
        `✗ ${lang}: '${want.voiceId}' exists but does NOT support engine '${want.engine}' ` +
          `(supports: ${engines.join(', ') || 'none reported'})`,
      );
      failures++;
      continue;
    }
    if (found.LanguageCode !== want.languageCode) {
      console.error(
        `✗ ${lang}: '${want.voiceId}' languageCode is '${found.LanguageCode}', ` +
          `table says '${want.languageCode}'`,
      );
      failures++;
      continue;
    }
    // BOOTSTRAP-POLLY-NARRATION-CACHE — report a BETTER engine going unused.
    //
    // Every check above validates the STATUS QUO: the voice exists, it supports
    // the engine we pinned, the language code matches. All of that passed for
    // months while six languages sat on `neural` and Polly had `generative`
    // available on the very same voice. A check that can only confirm what you
    // already configured cannot tell you the configuration is leaving quality
    // on the table, so it never said a word.
    //
    // Ranked worst→best; anything above the pinned engine is reported. This is
    // ADVISORY and does not count as a failure — the upgrade has a real cost
    // multiplier, so it is a decision to surface, not a rule to enforce.
    const RANK = ['standard', 'neural', 'generative'];
    const better = engines.filter(
      (e) => RANK.indexOf(e) > RANK.indexOf(want.engine),
    );
    if (better.length > 0) {
      console.log(
        `✓ ${lang}: ${want.voiceId} / ${want.engine} / ${want.languageCode}  ` +
          `→ UPGRADE AVAILABLE: '${want.voiceId}' also supports ` +
          `${better.map((e) => `'${e}'`).join(', ')} on the SAME voice ` +
          `(same speaker, better engine).`,
      );
      upgrades++;
    } else {
      console.log(`✓ ${lang}: ${want.voiceId} / ${want.engine} / ${want.languageCode}`);
    }
  }

  if (upgrades > 0) {
    console.log(
      `\nℹ ${upgrades} language(s) could move to a better engine without ` +
        `changing voice.\n` +
        `  Generative costs roughly 1.9x neural per character, so cache the\n` +
        `  rendered audio FIRST (NARRATION_AUDIO_CACHE) — otherwise the\n` +
        `  multiplier applies to every tap instead of once per asset.\n` +
        `  The narration cache key includes the engine, so flipping it\n` +
        `  invalidates cleanly rather than serving stale audio.`,
    );
  }

  const serbian = voices.filter((v) =>
    SERBIAN_PREFIXES.some((p) => (v.LanguageCode ?? '').toLowerCase().startsWith(p)),
  );
  console.log('');
  if (serbian.length === 0) {
    console.log(
      '✓ Serbian still unsupported by Polly — POLLY_UNSUPPORTED_LANGS is correct.\n' +
        '  NOTE: this remains a real GCP-shutdown blocker. With GCP gone, Serbian\n' +
        '  users get no TTS from any configured provider.',
    );
  } else {
    console.log(
      `! Serbian voice(s) NOW AVAILABLE: ${serbian.map((v) => `${v.Id} (${v.LanguageCode})`).join(', ')}\n` +
        '  Remove "sr" from POLLY_UNSUPPORTED_LANGS, add it to POLLY_VOICES, and\n' +
        '  drop the Serbian shutdown blocker from CLAUDE.md §2c.',
    );
  }

  if (failures > 0) {
    console.error(`\n[verify-polly] ${failures} mismatch(es) — do NOT flip TTS_PROVIDER=polly yet.`);
    process.exit(1);
  }
  console.log('\n[verify-polly] voice table matches the live API.');
}

main().catch((err) => {
  console.error('[verify-polly] failed:', err?.message ?? err);
  process.exit(1);
});
