/**
 * Assistant Speeches Registry
 *
 * Phase 1: admin-editable registry of named assistant speeches.
 * One object literal per speech — to add a new speech, append to SPEECH_REGISTRY.
 *
 * Phase 2 will migrate the real hardcoded copy from IntroExperience.tsx etc.
 * For Phase 1, default_text is a placeholder.
 */

export type SpeechKey =
  | 'pre_login_intro'
  | 'post_login_onboarding'
  | 'general_onboarding'
  | 'proactive_guidance_character';

export type SpeechJourneyStage = 'pre_login' | 'onboarding' | 'proactive';

export interface SpeechRegistryEntry {
  key: SpeechKey;
  label: string;
  description: string;
  journey_stage: SpeechJourneyStage;
  default_text: string;
  /**
   * True when the speech is delivered via a baked-in pre-recorded audio asset
   * (e.g. the pre-login intro). The admin UI should show a warning that text
   * edits will not affect the audio playback until Phase 2.
   */
  plays_prerecorded_audio?: boolean;
}

// =============================================================================
// Registry
// =============================================================================

export const SPEECH_REGISTRY: SpeechRegistryEntry[] = [
  {
    key: 'pre_login_intro',
    label: 'Pre-Login Intro',
    description:
      'First speech a visitor hears on the landing experience before signing in.',
    journey_stage: 'pre_login',
    default_text: '[Default pre-login intro speech — replace with copy]',
    plays_prerecorded_audio: true,
  },
  {
    key: 'post_login_onboarding',
    label: 'Post-Login Onboarding',
    description:
      'Spoken immediately after a user signs in for the first time to welcome them.',
    journey_stage: 'onboarding',
    default_text: '[Default post-login onboarding speech — replace with copy]',
  },
  {
    key: 'general_onboarding',
    label: 'General Onboarding',
    description:
      'Generic onboarding guidance used during the broader first-run flow.',
    journey_stage: 'onboarding',
    default_text: '[Default general onboarding speech — replace with copy]',
  },
  {
    key: 'proactive_guidance_character',
    label: 'Proactive Guidance — Character',
    description:
      'In-app proactive nudge spoken by the assistant character to guide the user.',
    journey_stage: 'proactive',
    default_text:
      '[Default proactive guidance character speech — replace with copy]',
  },
];

export const SPEECH_KEYS: SpeechKey[] = SPEECH_REGISTRY.map((s) => s.key);

const REGISTRY_BY_KEY: Record<SpeechKey, SpeechRegistryEntry> =
  SPEECH_REGISTRY.reduce(
    (acc, entry) => {
      acc[entry.key] = entry;
      return acc;
    },
    {} as Record<SpeechKey, SpeechRegistryEntry>
  );

export function getRegistryEntry(key: SpeechKey): SpeechRegistryEntry | null {
  return REGISTRY_BY_KEY[key] ?? null;
}

export function isValidSpeechKey(key: string): key is SpeechKey {
  return key in REGISTRY_BY_KEY;
}
