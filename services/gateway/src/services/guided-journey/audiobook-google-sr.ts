/**
 * VTID-05026 — the Serbian Audiobook narration switch.
 *
 * One language, one switch, one predicate — mirroring the Vertex bridges
 * (`orb/live/upstream/vertex-serbian-bridge.ts`). Never widened to a language list: a new
 * Google narration language is a new file, a new switch and a new VTID, so
 * turning one off never turns another off.
 *
 * `AUDIOBOOK_GOOGLE_SR_ENABLED` must be exactly `true`; anything else (unset, `false`, a
 * typo) is off. Off means Serbian narration does not use Google and the route answers 422 narration_unavailable, as before.
 */

export function isAudiobookGoogleSrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AUDIOBOOK_GOOGLE_SR_ENABLED ?? '').trim() === 'true';
}

export function isAudiobookGoogleSrLanguage(lang: string | null | undefined): boolean {
  return (lang || '').toLowerCase().split(/[-_]/)[0] === 'sr';
}
