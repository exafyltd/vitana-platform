/**
 * A0.1 Characterization fixtures — three frozen personas.
 *
 * These fixtures pin the inputs to `buildLiveSystemInstruction` so the snapshot
 * tests catch any unintended change in the rendered prompt during the orb-live.ts
 * refactor. They are NOT meant to model "best" or "correct" cases — they
 * model representative inputs that exercise enough branches of the prompt
 * builder for a regression to surface.
 *
 * If the refactor intentionally changes prompt text, update the snapshot files
 * deliberately (`jest -u`) and reference the change in the PR.
 */

export interface PersonaInput {
  // Inputs to buildLiveSystemInstruction in declared order
  lang: string;
  voiceStyle: string;
  bootstrapContext?: string;
  activeRole?: string | null;
  conversationSummary?: string;
  conversationHistory?: string;
  isReconnect?: boolean;
  lastSessionInfo?: { time: string; wasFailure: boolean } | null;
  currentRoute?: string | null;
  recentRoutes?: string[] | null;
  // clientContext is intentionally omitted — undefined in all fixtures.
  // The interface is module-internal in orb-live.ts; passing undefined keeps
  // the fixture decoupled from that type without forcing an extra export.
  vitanaId?: string | null;
}

/**
 * Day-1 user — first ever ORB session.
 * - English, no prior context, no prior turns
 * - Anonymous landing route
 * - No vitana_id yet (handle not provisioned)
 */
export const PERSONA_DAY_1: PersonaInput = {
  lang: 'en',
  voiceStyle: 'conversational',
  bootstrapContext: '',
  activeRole: null,
  conversationSummary: '',
  conversationHistory: '',
  isReconnect: false,
  lastSessionInfo: null,
  currentRoute: '/',
  recentRoutes: [],
  vitanaId: null,
};

/**
 * Day-30 user — mid-tenure community user with bootstrap data + active streaks.
 * - German voice
 * - Prior session 3 hours ago (warm session)
 * - Has a recent topic summary (continuity signal)
 * - Currently on /health route, recent routes show pillar exploration
 */
export const PERSONA_DAY_30: PersonaInput = {
  lang: 'de',
  voiceStyle: 'conversational',
  bootstrapContext: [
    '[ACTIVITY_14D] 14 active days, 8 calendar entries, 27 discovery interactions, 5 songs played.',
    '[ROUTINES] Most active afternoons (14:00-18:00).',
    '[PREFERENCES] Music: 80s pop, classical evenings.',
    '[HEALTH] Vitana Index: 218 / 999, tier=Early. Pillars: Nutrition 48, Hydration 30, Exercise 52, Sleep 44, Mental 44. Weakest: Hydration. 7-day trend: +12.',
    '[CONTENT_PLAYED] Shout — Tears for Fears (3h ago, YouTube Music).',
    '[FACTS] Display name: Test30User. Birthday: 1990-04-12.',
    '[RECENT] Logged hydration entry 2h ago. Added calendar event "Yoga 18:00" 1h ago.',
  ].join('\n'),
  activeRole: 'community',
  conversationSummary: 'Last session: discussed magnesium reminder timing and logged a diary entry about energy.',
  conversationHistory: 'User: Wie geht\'s mir heute?\nAssistant: Dein Hydration steht heute bei 30 — fast komplett aus dem Baseline-Wert. Ein Glas Wasser jetzt würde echt helfen.',
  isReconnect: false,
  lastSessionInfo: { time: '3 hours ago', wasFailure: false },
  currentRoute: '/health',
  recentRoutes: ['/diary', '/health', '/wallet'],
  vitanaId: '@day30user',
};

/**
 * Day-180 veteran — returning after a 14-day pause via reconnect path.
 * - English
 * - isReconnect=true (transparent reconnect after disconnect)
 * - Rich bootstrap context, longer history
 * - Last session info reflects the gap
 */
export const PERSONA_DAY_180_RECONNECT: PersonaInput = {
  lang: 'en',
  voiceStyle: 'conversational',
  bootstrapContext: [
    '[ACTIVITY_14D] 2 active days in last 14 (returning user).',
    '[ROUTINES] Historically morning-active; recent gap.',
    '[PREFERENCES] Music: ambient, jazz. Long-form podcasts.',
    '[HEALTH] Vitana Index: 612 / 999, tier=Really good. Pillars: Nutrition 138, Hydration 122, Exercise 110, Sleep 124, Mental 118. Balance factor: 0.96.',
    '[CONTENT_PLAYED] (no plays in last 14d).',
    '[FACTS] Display name: VetUser180. Tenure: 187 days.',
    '[RECENT] Posted intent "looking for a chess partner" 16 days ago. No activity since.',
  ].join('\n'),
  activeRole: 'community',
  conversationSummary: 'We discussed the 5-pillar Vitana Index tier ladder and your Really good tier status. You mentioned wanting to maintain consistency over the holidays.',
  conversationHistory: 'User: Quick check — am I still on track?\nAssistant: You\'re holding at 612, tier Really good, balance factor 0.96 — that\'s a strong place to maintain. Want to talk about specific pillars?',
  isReconnect: true,
  lastSessionInfo: { time: '14 days ago', wasFailure: false },
  currentRoute: '/',
  recentRoutes: ['/', '/intent', '/community'],
  vitanaId: '@vet180',
};

export const ALL_PERSONAS: Array<{ name: string; input: PersonaInput }> = [
  { name: 'day-1-anonymous-landing', input: PERSONA_DAY_1 },
  { name: 'day-30-warm-german', input: PERSONA_DAY_30 },
  { name: 'day-180-veteran-reconnect', input: PERSONA_DAY_180_RECONNECT },
];
