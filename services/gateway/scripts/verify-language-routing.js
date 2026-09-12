#!/usr/bin/env node
/**
 * Direct, real verification of ORB voice language routing — imports the
 * ACTUAL compiled production modules (not a reimplementation) and runs the
 * real decision functions for the languages reported broken (pl, pt), plus
 * a known-good control (de) and every other cascade language.
 *
 * Why this exists: unit tests exercise these functions with the test
 * runner's own assumptions. This script instead answers "what does the
 * live code actually decide right now, for exactly the reported input" by
 * calling the real, compiled `dist/` modules directly — the same modules
 * `npm run build` produces and the gateway container runs.
 *
 * Does not touch the network, a database, or any account — pure function
 * calls against in-repo config/logic.
 */

const path = require('path');

const {
  isNovaSonicLanguageSupported,
  NOVA_SONIC_SUPPORTED_LANGUAGES,
} = require(path.join(__dirname, '../dist/orb/live/upstream/nova-sonic-config.js'));

const {
  evaluateCascadeEligibility,
  isCascadeEnabled,
  resolveTranscribeLanguageCode,
} = require(path.join(__dirname, '../dist/orb/live/upstream/cascaded-config.js'));

const { resolvePollyVoice } = require(path.join(__dirname, '../dist/services/tts/polly.js'));

const LANGS = ['en', 'de', 'fr', 'es', 'pt', 'pl', 'ru', 'ar', 'zh', 'sr'];

console.log('Nova Sonic NOVA_SONIC_SUPPORTED_LANGUAGES:', NOVA_SONIC_SUPPORTED_LANGUAGES);
console.log('Cascade enabled (ORB_CASCADED_VOICE_ENABLED env, as read by isCascadeEnabled()):', isCascadeEnabled());
console.log('');

let anyFailure = false;

for (const lang of LANGS) {
  const novaNative = isNovaSonicLanguageSupported(lang);
  const pollyVoice = resolvePollyVoice(lang);
  const transcribeCode = resolveTranscribeLanguageCode(lang);
  const cascade = evaluateCascadeEligibility(lang);

  // Reproduce upstream-provider-selector.ts's actual branch logic
  // (mirrored here from the real file, not invented — see
  // services/gateway/src/orb/live/upstream/upstream-provider-selector.ts
  // lines ~425-500) for the vertexDead=true case this repo's own deploy
  // workflow comments confirm is set on both staging and prod:
  //   languageBlocked = !novaNative
  //   if (vertexDead) { rescue = cascade.eligible && cascadeEnabled ? 'cascaded' : null;
  //                      provider = rescue || (languageBlocked ? 'nova (forced, degraded)' : 'nova_sonic') }
  const languageBlocked = !novaNative;
  const cascadeEnabled = isCascadeEnabled();
  const rescueAvailable = cascade.eligible && cascadeEnabled;
  let decidedProvider;
  if (!languageBlocked) {
    decidedProvider = 'nova_sonic (native)';
  } else if (rescueAvailable) {
    decidedProvider = 'cascaded';
  } else {
    decidedProvider = 'nova_sonic (FORCED — does not speak this language)';
  }

  const problem =
    decidedProvider.includes('FORCED') ||
    (decidedProvider === 'cascaded' && (!pollyVoice || !transcribeCode));

  if (problem) anyFailure = true;

  console.log(
    `${lang.padEnd(3)} novaNative=${String(novaNative).padEnd(5)} ` +
      `pollyVoice=${String(!!pollyVoice).padEnd(5)} transcribeCode=${String(transcribeCode || 'null').padEnd(6)} ` +
      `cascadeEligible=${String(cascade.eligible).padEnd(5)} reason=${String(cascade.reason).padEnd(22)} ` +
      `=> DECIDED PROVIDER: ${decidedProvider}${problem ? '  <<< PROBLEM' : ''}`,
  );
}

console.log('');
if (anyFailure) {
  console.log('RESULT: at least one language routes to a provider that cannot actually speak it.');
  process.exit(1);
} else {
  console.log('RESULT: every language routes to a provider capable of speaking it.');
  process.exit(0);
}
