/**
 * Real-Life Invite engine (advice #4 — inspire the user to invite others to
 * real-world activities).
 *
 * The conversation flow had NO concept of doing things with other people in the
 * real world. This pure engine turns a moment of personal momentum into a
 * proposal to invite someone to a concrete real-life activity — anchored to the
 * pillar the user is strongest in, so the suggestion feels earned and relevant.
 *
 * SCOPE (deliberately narrow, mirrors the SAFE conversation-flow-v3 rebuild):
 *   - This produces SPEECH ONLY. It performs no navigation, writes no rows, and
 *     contacts no third party. The actual "send the invite / referral" mechanism
 *     (a user_invites table + consent model + outbound channel) is a separate,
 *     spec'd slice — when it lands, the provider's benign `offer_invite` cta
 *     becomes the trigger for it. Until then Vitana proposes and offers to help;
 *     the help is conversational.
 *   - RULE 0: every line is a PROPOSAL + lead, never a passive question.
 */

import type { PillarKey } from '../../lib/vitana-pillars';

/** A real-world activity the user can invite someone to share. */
export interface InviteActivity {
  /** Stable key for dedupe / logs. */
  key: string;
  /** Verb-phrase that completes "invite someone to {…} with you" (DE). */
  de: string;
  /** Same, EN. */
  en: string;
}

/**
 * Map the user's strongest pillar to the most natural shared activity. Pillars
 * with no obvious social form (hydration, sleep) fall back to a walk — the
 * universal, low-friction "do it together" activity.
 */
const ACTIVITY_BY_PILLAR: Record<PillarKey, InviteActivity> = {
  exercise: { key: 'walk', de: 'einen Spaziergang zu machen', en: 'to go for a walk' },
  nutrition: { key: 'cook', de: 'etwas Gesundes zu kochen', en: 'to cook something healthy' },
  mental: { key: 'coffee_talk', de: 'einen Kaffee zu trinken und zu reden', en: 'to grab a coffee and really talk' },
  hydration: { key: 'walk', de: 'einen Spaziergang zu machen', en: 'to go for a walk' },
  sleep: { key: 'evening_walk', de: 'einen entspannten Abendspaziergang zu machen', en: 'to take a relaxed evening walk' },
};

const DEFAULT_ACTIVITY: InviteActivity = ACTIVITY_BY_PILLAR.exercise;

export interface InviteInputs {
  /** The user's strongest pillar (from the Index snapshot), or null. */
  strongestPillar: PillarKey | null;
  /** YYYY-MM-DD for a once-per-day dedupe key. */
  dateKey: string;
}

export interface InviteFocus {
  activity: InviteActivity;
  /** Once-per-day dedupe key so the invite is occasional, never nagging. */
  nudgeKey: string;
}

/** Pick the single real-life activity to propose inviting someone to. Pure. */
export function pickInviteActivity(inputs: InviteInputs): InviteFocus {
  const activity =
    inputs.strongestPillar && ACTIVITY_BY_PILLAR[inputs.strongestPillar]
      ? ACTIVITY_BY_PILLAR[inputs.strongestPillar]
      : DEFAULT_ACTIVITY;
  return {
    activity,
    nudgeKey: `real_life_invite:${inputs.dateKey}:${activity.key}`,
  };
}

/**
 * The spoken proposal. Celebrates the user's momentum, makes the case that
 * shared activities stick better, and proposes inviting someone to the concrete
 * activity — then offers to help. Always a proposal + lead (RULE 0). Pure.
 */
export function buildInviteProposal(lang: string, focus: InviteFocus): string {
  const de = (lang || 'en').toLowerCase().startsWith('de');
  if (de) {
    return (
      `Du machst das gerade richtig stark. Solche Dinge halten noch besser, wenn man sie teilt — ` +
      `lass uns jemanden einladen, mit dir ${focus.activity.de}. Ich helfe dir, die Einladung rauszuschicken.`
    );
  }
  return (
    `You're doing really well right now. Things like this stick even better when you share them — ` +
    `let's invite someone ${focus.activity.en} with you. I'll help you send the invite.`
  );
}
