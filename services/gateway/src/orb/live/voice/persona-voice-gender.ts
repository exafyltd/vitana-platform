/**
 * VTID-04445 — the persona voice-gender rule, in one place.
 *
 * Standing rule set by the platform owner 2026-09-23:
 *
 *   - Every Vitana voice, in every language, on every voice pipeline, is a
 *     WOMAN's voice.
 *   - Every Devon voice, in every language, on every voice pipeline, is a
 *     MAN's voice.
 *
 * Before this module, gender lived only in prose next to each voice table,
 * and it had drifted: Devon spoke with Vitana's female Nova voice on every
 * Nova session (VTID-03704 made Nova "one female voice per language"
 * regardless of persona), Devon borrowed Vitana's female Polly voice in
 * Turkish and Chinese, and three of Vitana's stored Gemini voices (`fr`
 * Charon, `es` Fenrir, `tr` Puck) were male.
 *
 * This module holds:
 *   1. `PERSONA_VOICE_GENDER` — the rule itself.
 *   2. The gender of every voice id the platform can serve, per provider,
 *      each table sourced from the provider's own catalog (see the notes).
 *   3. Predicates the resolvers and the hand-off gate use, so a resolver that
 *      would hand a persona a wrong-gender voice is caught in code, and
 *      `vtid-04445-persona-voice-gender.test.ts` walks every table.
 *
 * A voice id missing from these catalogs is `null` (unknown), never assumed:
 * an unknown voice fails `isVoiceGender()`, so adding a voice to a table
 * without recording its gender here fails the test instead of shipping.
 */

export type VoiceGender = 'female' | 'male';

/**
 * The rule. Keys are persona keys (`agent_personas.key`). Personas not listed
 * here (the draft specialists) are not governed by the owner's rule; every
 * enabled persona is listed.
 */
export const PERSONA_VOICE_GENDER: Readonly<Record<string, VoiceGender>> = {
  vitana: 'female',
  devon: 'male',
};

export function personaVoiceGender(persona: string | null | undefined): VoiceGender | null {
  const key = (persona || 'vitana').trim().toLowerCase();
  return PERSONA_VOICE_GENDER[key] ?? null;
}

/**
 * Amazon Nova 2 Sonic voices — AWS's own table ("Language support",
 * Nova 2 user guide: feminine- vs masculine-sounding voice id per locale),
 * fetched 2026-09-23. Every id the code uses was also invoked for real on
 * `amazon.nova-2-sonic-v1:0` (eu-north-1) and returned audio; a bogus id is
 * rejected with `Received invalid id`, so acceptance is evidence. Median
 * pitch on ~8 s of generated speech per voice: female 198–238 Hz
 * (tina/lupe/ambre), male 104–140 Hz (matthew/lennart/florian/carlos/leo) —
 * see docs/validation/VTID-04445/.
 */
export const NOVA_VOICE_GENDER: Readonly<Record<string, VoiceGender>> = {
  tiffany: 'female',
  matthew: 'male',
  amy: 'female',
  olivia: 'female',
  kiara: 'female',
  arjun: 'male',
  ambre: 'female',
  florian: 'male',
  beatrice: 'female',
  lorenzo: 'male',
  tina: 'female',
  lennart: 'male',
  lupe: 'female',
  carlos: 'male',
  carolina: 'female',
  leo: 'male',
};

/**
 * Amazon Polly voices this platform can serve — `Gender` as returned by a
 * live `DescribeVoices` in eu-central-1, 2026-09-23.
 */
export const POLLY_VOICE_GENDER: Readonly<Record<string, VoiceGender>> = {
  Joanna: 'female',
  Matthew: 'male',
  Vicki: 'female',
  Daniel: 'male',
  Lea: 'female',
  Remi: 'male',
  Lucia: 'female',
  Sergio: 'male',
  Hala: 'female',
  Zayd: 'male',
  Zhiyu: 'female',
  Tatyana: 'female',
  Maxim: 'male',
  Camila: 'female',
  Thiago: 'male',
  Ola: 'female',
  Jacek: 'male',
  Burcu: 'female',
  Filiz: 'female',
};

/**
 * Gemini prebuilt voices (Vertex Live / Gemini TTS / the LiveKit agent's
 * Chirp 3 HD names) — Google's published Chirp 3 HD voice table
 * (docs.cloud.google.com/text-to-speech/docs/chirp3-hd, read 2026-09-23),
 * which labels each voice female or male. Covers the whole prebuilt set so
 * any voice a registry row or policy row might name has a known gender.
 */
export const GEMINI_VOICE_GENDER: Readonly<Record<string, VoiceGender>> = {
  Zephyr: 'female',
  Puck: 'male',
  Charon: 'male',
  Kore: 'female',
  Fenrir: 'male',
  Leda: 'female',
  Orus: 'male',
  Aoede: 'female',
  Callirrhoe: 'female',
  Autonoe: 'female',
  Enceladus: 'male',
  Iapetus: 'male',
  Umbriel: 'male',
  Algieba: 'male',
  Despina: 'female',
  Erinome: 'female',
  Algenib: 'male',
  Rasalgethi: 'male',
  Laomedeia: 'female',
  Achernar: 'female',
  Alnilam: 'male',
  Schedar: 'male',
  Gacrux: 'female',
  Pulcherrima: 'female',
  Achird: 'male',
  Zubenelgenubi: 'male',
  Vindemiatrix: 'female',
  Sadachbia: 'male',
  Sadaltager: 'male',
  Sulafat: 'female',
};

/**
 * Fish Audio voices by `reference_id` — only voices published by Fish's own
 * official account are ever curated (VTID-03970 rejected a community clone
 * with adult-content tags). Gender from the model's own `male`/`female` tag
 * and title, read via `GET /model/{id}` 2026-09-23.
 */
export const FISH_VOICE_GENDER: Readonly<Record<string, VoiceGender>> = {
  '2ad62aaf885e4a14add09fe4a38ffd23': 'female', // Milica - Female Serbian
  '076ad255234448a5b2adb3f8bd292acd': 'male', // Nikola - Male Serbian
  '778d117554c9470bb7c664a781fe13a5': 'male', // Kerem - Male Turkish
  '5d29a99739c14d4ca3e4fe42193105b2': 'male', // 梓轩 Zixuan - Male Mandarin (Mainland)
};

export type VoiceCatalog = 'nova' | 'polly' | 'gemini' | 'fish';

const CATALOGS: Record<VoiceCatalog, Readonly<Record<string, VoiceGender>>> = {
  nova: NOVA_VOICE_GENDER,
  polly: POLLY_VOICE_GENDER,
  gemini: GEMINI_VOICE_GENDER,
  fish: FISH_VOICE_GENDER,
};

/**
 * Gender of a voice id in a catalog, or null when the id is unknown.
 *
 * Accepts the Google Cloud TTS / Chirp spelling too (`de-DE-Chirp3-HD-Leda`
 * → `Leda`), which is how the LiveKit agent names Gemini voices.
 */
export function voiceGender(catalog: VoiceCatalog, voiceId: string | null | undefined): VoiceGender | null {
  const raw = String(voiceId ?? '').trim();
  if (!raw) return null;
  const table = CATALOGS[catalog];
  if (table[raw]) return table[raw];
  if (catalog === 'gemini') {
    const tail = raw.split('-').pop() ?? '';
    if (table[tail]) return table[tail];
  }
  if (catalog === 'nova') {
    const lower = raw.toLowerCase();
    if (table[lower]) return table[lower];
  }
  return null;
}

/** True only when the voice is KNOWN to have `gender` — unknown is false. */
export function isVoiceGender(catalog: VoiceCatalog, voiceId: string | null | undefined, gender: VoiceGender): boolean {
  return voiceGender(catalog, voiceId) === gender;
}

/**
 * True when `voiceId` is allowed for `persona` under the rule. A persona the
 * rule does not govern accepts any voice.
 */
export function isVoiceAllowedForPersona(
  catalog: VoiceCatalog,
  voiceId: string | null | undefined,
  persona: string | null | undefined,
): boolean {
  const required = personaVoiceGender(persona);
  if (!required) return true;
  return isVoiceGender(catalog, voiceId, required);
}
