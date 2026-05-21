// Phase D.3 (decision-contract refactor) — VTID-03126.
//
// Live API voice resolver. Externalizes the `LIVE_API_VOICES` Record
// that previously lived inline in `routes/orb-live.ts:1341`. Each
// language's policy row carries `{voice_name, fallback_lang}` so the
// accessor can emit telemetry when the selected voice is NOT native to
// the requested language. This closes the audit's "silent
// Arabic → English Aoede" finding — the fallback is still served (so
// behaviour is byte-identical at rollout) but it's now visible in logs.
//
// Future: when a native voice ships for ar/zh/ru/sr, update the DB row
// to `fallback_lang: null` and the warning stops firing automatically.

import { getPolicyResolver } from '../../../services/decision-contract/policy-resolver';

interface LiveApiVoiceConfig {
  voice_name: string;
  fallback_lang: string | null;
}

// Byte-identical to the LIVE_API_VOICES Record at the time of writing.
// Used as the cache-cold safety net by the accessor; production source
// of truth is the seeded `decision_policy` rows.
const LIVE_API_VOICE_FALLBACKS: Record<string, LiveApiVoiceConfig> = {
  en: { voice_name: 'Aoede', fallback_lang: null },
  de: { voice_name: 'Kore', fallback_lang: null },
  fr: { voice_name: 'Charon', fallback_lang: null },
  es: { voice_name: 'Fenrir', fallback_lang: null },
  ar: { voice_name: 'Aoede', fallback_lang: 'en' },
  zh: { voice_name: 'Kore', fallback_lang: 'de' },
  ru: { voice_name: 'Aoede', fallback_lang: 'en' },
  sr: { voice_name: 'Aoede', fallback_lang: 'en' },
};

// Dedup log lines so a hot per-session loop doesn't spam the logger.
// One emission per (lang, fallback_lang) pair per process lifetime.
const loggedFallbacks = new Set<string>();

function livePolicyKeyForVoice(lang: string): string {
  return `voice.live_api.voice.${lang}`;
}

function logFallbackOnce(lang: string, cfg: LiveApiVoiceConfig): void {
  if (!cfg.fallback_lang) return;
  const tag = `${lang}:${cfg.fallback_lang}:${cfg.voice_name}`;
  if (loggedFallbacks.has(tag)) return;
  loggedFallbacks.add(tag);
  // eslint-disable-next-line no-console
  console.warn(
    `[voice-fallback] live_api: lang="${lang}" using "${cfg.fallback_lang}" voice "${cfg.voice_name}" — native voice not yet shipped for "${lang}"`,
  );
}

export function getLiveApiVoice(lang: string): string {
  const safeLang = typeof lang === 'string' && lang.length > 0 ? lang : 'en';
  const fallback = LIVE_API_VOICE_FALLBACKS[safeLang] ?? LIVE_API_VOICE_FALLBACKS['en'];
  const cfg = getPolicyResolver().getValue<LiveApiVoiceConfig | null>(
    livePolicyKeyForVoice(safeLang),
    { defaultValue: fallback },
  );
  const resolved = cfg ?? fallback;
  logFallbackOnce(safeLang, resolved);
  return resolved.voice_name;
}

// ---- test support ------------------------------------------------------
// Tests can reset the dedup set so each test sees a fresh log state.
export function __resetLiveApiVoiceFallbackLogForTests(): void {
  loggedFallbacks.clear();
}
