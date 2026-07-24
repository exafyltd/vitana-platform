/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): application language/persona →
 * Nova 2 Sonic voice ID mapping.
 *
 * Nova has its OWN voice catalog — Gemini voice IDs (`Kore`, `Charon`,
 * `Aoede`, …) must never be passed to Nova. Per the plan's language/voice
 * decision: feminine voices for the `vitana`, `sage`, and `mira` personas,
 * masculine voices for `devon` and `atlas`, per canary language:
 *   en → tiffany / matthew
 *   de → tina / lennart
 *   fr → ambre / florian
 *   es → lupe / carlos
 * Unknown personas fall back to the feminine (Vitana-default) voice;
 * unsupported languages resolve to `null` — callers must have already
 * fallen back to Vertex before asking for a Nova voice, so `null` is a
 * programming-error signal, not a runtime fallback path.
 */

import { isNovaSonicLanguageSupported } from '../upstream/nova-sonic-config';

const MASCULINE_PERSONAS = new Set(['devon', 'atlas']);

const NOVA_VOICES = {
  en: { feminine: 'tiffany', masculine: 'matthew' },
  de: { feminine: 'tina', masculine: 'lennart' },
  fr: { feminine: 'ambre', masculine: 'florian' },
  es: { feminine: 'lupe', masculine: 'carlos' },
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
