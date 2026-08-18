/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): application language/persona →
 * Nova 2 Sonic voice ID mapping.
 *
 * Nova has its OWN voice catalog — Gemini voice IDs (`Kore`, `Charon`,
 * `Aoede`, …) must never be passed to Nova. Per the plan's language/voice
 * decision: feminine voices for the `vitana`, `sage`, and `mira` personas,
 * masculine voices for `devon` and `atlas`, per canary language:
 *   en → tina / lennart   (user live-test verdict 2026-07-28: en's native
 *                          `tiffany`/`matthew` sounded bad; `tina`/`lennart`
 *                          — Nova's DE voices — sound good and are reused
 *                          for EN content too, at the cost of a German
 *                          accent on English speech)
 *   de → tina / lennart
 *   fr → ambre / florian
 *   es → lupe / carlos
 *   pt → carolina / leo   (VTID-03672 — AWS Nova 2 table, pt-BR; matches this
 *                          app's Brazilian catalog so the accent fits the text)
 * Unknown personas fall back to the feminine (Vitana-default) voice;
 * unsupported languages resolve to `null` — callers must have already
 * fallen back to Vertex before asking for a Nova voice, so `null` is a
 * programming-error signal, not a runtime fallback path.
 */

import { isNovaSonicLanguageSupported } from '../upstream/nova-sonic-config';

const MASCULINE_PERSONAS = new Set(['devon', 'atlas']);

const NOVA_VOICES = {
  en: { feminine: 'tina', masculine: 'lennart' },
  de: { feminine: 'tina', masculine: 'lennart' },
  fr: { feminine: 'ambre', masculine: 'florian' },
  es: { feminine: 'lupe', masculine: 'carlos' },
  // VTID-03672. AWS's Nova 2 Sonic voice table gives Portuguese as pt-BR ->
  // carolina / leo. pt-BR is also exactly this app's Portuguese catalog
  // (VTID-03577), so the accent matches the text rather than reading Brazilian
  // copy in European Portuguese.
  //
  // Both ids were confirmed by a real bidirectional stream: Bedrock ACCEPTS
  // them, and rejects a deliberately bogus id with `Received invalid id`. That
  // contrast is what makes acceptance evidence rather than absence of an error.
  //
  // Sourced from the NOVA 2 table, not the Nova 1 one — Nova 1 lists German as
  // `greta` where this codebase (and Nova 2) use `tina`, so the v1 page would
  // have supplied a plausible, wrong id for a model we do not run.
  pt: { feminine: 'carolina', masculine: 'leo' },
} as const;

export type NovaSonicVoiceId =
  (typeof NOVA_VOICES)[keyof typeof NOVA_VOICES][keyof (typeof NOVA_VOICES)['en']];

export interface NovaSonicVoiceQuery {
  /** Application language (BCP-47 tag or bare code; base tag is used). */
  language: string;
  /** Active persona key (`vitana`, `devon`, `sage`, `atlas`, `mira`). */
  persona?: string | null;
}

/**
 * Resolve the Nova voice for a language + persona. Returns `null` for
 * languages outside the Nova canary set.
 */
export function resolveNovaSonicVoice(query: NovaSonicVoiceQuery): NovaSonicVoiceId | null {
  if (!isNovaSonicLanguageSupported(query.language)) return null;
  const base = query.language.trim().toLowerCase().split(/[-_]/)[0] as keyof typeof NOVA_VOICES;
  const table = NOVA_VOICES[base];
  if (!table) return null;
  const persona = (query.persona ?? 'vitana').trim().toLowerCase();
  return MASCULINE_PERSONAS.has(persona) ? table.masculine : table.feminine;
}
