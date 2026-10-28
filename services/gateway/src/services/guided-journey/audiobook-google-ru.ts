/**
 * VTID-05026 — the Russian Audiobook narration switch.
 *
 * One language, one switch, one predicate — mirroring the Vertex bridges
 * (`orb/live/upstream/vertex-russian-bridge.ts`). Never widened to a language list: a new
 * Google narration language is a new file, a new switch and a new VTID, so
 * turning one off never turns another off.
 *
 * `AUDIOBOOK_GOOGLE_RU_ENABLED` must be exactly `true`; anything else (unset, `false`, a
 * typo) is off. Off means Russian narration does not use Google and stays on Polly Tatyana.
 */

export function isAudiobookGoogleRuEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AUDIOBOOK_GOOGLE_RU_ENABLED ?? '').trim() === 'true';
}

export function isAudiobookGoogleRuLanguage(lang: string | null | undefined): boolean {
  return (lang || '').toLowerCase().split(/[-_]/)[0] === 'ru';
}
