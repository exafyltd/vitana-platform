/**
 * VTID-03255 — the Journey Foundation step registry.
 *
 * This is the heart of the system: one ordered list, each entry self-describes
 * how it is verified (by key, in journey-foundation-verifier), navigated, and
 * spoken (execute vs. teach). The verifier and next-step logic are generic
 * loops over this registry — no per-step branching scattered elsewhere.
 *
 * Order = the locked foundation path, grouped into priority tiers. The health
 * strand delivers the immediate, tangible wins; the economy strand is taught
 * and inspired from day one, then progressively activated. The goal is a hard
 * GATE (tier 0): nothing past it is offered until it is satisfied.
 *
 * Graduation (inspire-always, never-block): a user is "foundation complete"
 * when every required_for_graduation step is satisfied. The economy ACTIVATION
 * steps are recommended and inspired but never required — a health-only user
 * graduates, while still having consciously understood the economy and
 * declared an intention.
 *
 * navigation_route values are surface-neutral keys consumed by the screens;
 * they are validated against real mobile/desktop routes in P4/P5.
 */

import type { FoundationStrand, FoundationStepType } from './types';

export interface FoundationStepDef {
  key: string;
  title: string;
  strand: FoundationStrand;
  type: FoundationStepType;
  tier: number;
  required_for_graduation: boolean;
  navigation_route: string | null;
  benefit: string;
  /** What Vitana says to drive the action (used by voice in P2/P3). */
  execute_prompt: string;
  /** What Vitana says in Teacher mode when the user isn't in the mood to execute. */
  teach_prompt: string;
}

export const FOUNDATION_STEPS: readonly FoundationStepDef[] = [
  // ── GATE ──────────────────────────────────────────────────────────────────
  {
    key: 'life_compass',
    title: 'Life Compass',
    strand: 'health',
    type: 'action',
    tier: 0,
    required_for_graduation: true,
    navigation_route: '/journey/goal',
    benefit: 'Define the one goal your whole journey is built around.',
    execute_prompt:
      "Let's set your direction. What is the one thing in your life you most want to improve right now — your body, energy, sleep, stress, or your prosperity? Then we'll make it concrete with a target and a timeframe.",
    teach_prompt:
      "A journey needs a destination. Your Life Compass is that destination — one clear goal with a measurable target and a date. It's how I know what to guide you toward, and it's why VitanaLand can show you real progress instead of vague advice.",
  },
  // ── TIER 1 — immediate: one health win + the economy vision ────────────────
  {
    key: 'weakest_habit',
    title: 'Weakest habit',
    strand: 'health',
    type: 'action',
    tier: 1,
    required_for_graduation: true,
    navigation_route: '/journey/focus',
    benefit: 'Name the habit blocking you most so I can get you quick results.',
    execute_prompt:
      'Now I need the habit blocking your health most, so I can get you quick results with simple reminders and community support. Is it food, water, exercise, sleep, mental stress, or something else?',
    teach_prompt:
      "We start where you're weakest because that's where small changes give the biggest, fastest results. Fix the one thing holding you back and the rest of your health lifts with it.",
  },
  {
    key: 'reminder',
    title: 'Reminder',
    strand: 'health',
    type: 'action',
    tier: 1,
    required_for_graduation: true,
    navigation_route: '/reminders',
    benefit: 'Your first quick win — proof the system works for you.',
    execute_prompt:
      "Let's lock in one simple reminder around that habit. Pick a time and I'll make sure it reaches you — this is your first quick win.",
    teach_prompt:
      "Reminders are how I act on your behalf between conversations. One small, well-timed nudge is what turns an intention into a habit — and it's the first proof that the system is working for you, not just talking.",
  },
  {
    key: 'understand_economy',
    title: 'Understand the longevity economy',
    strand: 'economy',
    type: 'teacher',
    tier: 1,
    required_for_graduation: true,
    navigation_route: '/learn/economy',
    benefit: 'See how members here earn together — this is also your economy.',
    execute_prompt:
      "There's one more thing you should know early: VitanaLand isn't only about feeling better. It's a longevity economy. Members earn with each other — recommendations, affiliate commissions, passive income — and I can run an agent that earns for you. Want me to show you how that works?",
    teach_prompt:
      "VitanaLand is a longevity economy. The healthier the community gets, the more value flows through it — and members share in that value. You can earn from recommendations, build passive income, or start a business for the community. Your health journey and your prosperity grow on the same platform.",
  },
  // ── TIER 2 — foundation: measure health + capture the economic aspiration ──
  {
    key: 'profile',
    title: 'Profile',
    strand: 'health',
    type: 'action',
    tier: 2,
    required_for_graduation: true,
    navigation_route: '/profile',
    benefit: 'The basics that let me personalize everything to you.',
    execute_prompt:
      "Let's fill in a few basics — your name and date of birth — so everything I do is tuned to you specifically.",
    teach_prompt:
      'Your profile is the lens I see you through. A few basics make every recommendation, every Index score, and every match sharper and more personal.',
  },
  {
    key: 'diary',
    title: 'Diary',
    strand: 'health',
    type: 'action',
    tier: 2,
    required_for_graduation: true,
    navigation_route: '/diary',
    benefit: 'Your first entry — this improves memory and Autopilot suggestions.',
    execute_prompt:
      "Let's capture your first diary entry. Even one line — how you feel today — gives me memory to work with. What should I remember about today?",
    teach_prompt:
      "Your diary is my memory of you. Every entry teaches me your patterns, which is what lets Autopilot make suggestions that actually fit your life instead of generic tips.",
  },
  {
    key: 'vitana_index',
    title: 'Vitana Index',
    strand: 'health',
    type: 'action',
    tier: 2,
    required_for_graduation: true,
    navigation_route: '/index',
    benefit: 'Your baseline — without it, progress can’t be measured.',
    execute_prompt:
      "Let's set your baseline with a short Vitana Index survey. This is the measurement we'll track your progress against — including your prosperity pillar.",
    teach_prompt:
      'The Vitana Index is your scoreboard across health and prosperity. Without a baseline there is no "before and after" — this is what turns effort into visible progress.',
  },
  {
    key: 'economic_aspiration',
    title: 'Economic aspiration',
    strand: 'economy',
    type: 'action',
    tier: 2,
    required_for_graduation: false,
    navigation_route: '/journey/economy',
    benefit: 'Shape how you’d like to earn here — even "just curious" counts.',
    execute_prompt:
      "Earlier you told me your stance on earning here. Let's sharpen it: would you like to build a business, earn passive income, or earn from recommendations? Even staying curious is a perfectly good answer for now.",
    teach_prompt:
      "There's no pressure to earn — but it helps me to know your direction. Some members want a business, some want passive income, some just want a little from recommending what they love. Knowing yours lets me surface the right opportunities only when they fit.",
  },
  // ── TIER 3 — rhythm: turn the engine on, and it earns ──────────────────────
  {
    key: 'calendar',
    title: 'Calendar',
    strand: 'health',
    type: 'action',
    tier: 3,
    required_for_graduation: true,
    navigation_route: '/calendar',
    benefit: 'Anchor your routine into real time slots.',
    execute_prompt:
      "Let's anchor your routine. I'll put one real block on your calendar so the habit has a home in your day.",
    teach_prompt:
      "A goal without a time is just a wish. Your calendar is where intentions become a rhythm — and once it's there, I can protect it and remind you.",
  },
  {
    key: 'autopilot',
    title: 'Autopilot — your autonomous income agent',
    strand: 'economy',
    type: 'teacher',
    tier: 3,
    required_for_graduation: true,
    navigation_route: '/autopilot',
    benefit: 'The agent that improves your health and earns for you.',
    execute_prompt:
      "Now the powerful part: Autopilot is an agent that works for you autonomously — it improves your health AND it can generate income on your behalf in the longevity economy. Want me to turn it on?",
    teach_prompt:
      "Autopilot is the autonomous engine of VitanaLand. It acts for you between conversations — keeping your health on track and working the longevity economy on your behalf. This is how the platform compounds: your effort, multiplied by an agent that never sleeps.",
  },
  {
    key: 'connect',
    title: 'Connect',
    strand: 'economy',
    type: 'action',
    tier: 3,
    required_for_graduation: false,
    navigation_route: '/connect',
    benefit: 'Member-to-member is the earning fabric — recommendations, commissions.',
    execute_prompt:
      "Let's connect you with members. This is the economic fabric — recommendations between members are how value, and commissions, flow.",
    teach_prompt:
      'The community is the economy. Every connection is a channel for recommendations — and recommendations are how members earn from each other here.',
  },
  // ── TIER 4 — economy activation: the culmination, inspired from day one ─────
  {
    key: 'events',
    title: 'Events',
    strand: 'economy',
    type: 'action',
    tier: 4,
    required_for_graduation: false,
    navigation_route: '/events',
    benefit: 'Show up in the community — participation creates opportunity.',
    execute_prompt:
      "There are community events you'd fit well. Joining one puts you in front of members — that's where recommendation income starts.",
    teach_prompt:
      'Events are where the community comes alive — and where reputation and recommendation income are built. Showing up is the first move.',
  },
  {
    key: 'marketplace',
    title: 'Marketplace',
    strand: 'economy',
    type: 'action',
    tier: 4,
    required_for_graduation: false,
    navigation_route: '/marketplace',
    benefit: 'Buy, sell, and earn affiliate and passive income.',
    execute_prompt:
      "When you're ready, the Marketplace is where you can buy, sell, and earn — affiliate commissions and passive income from what the community values.",
    teach_prompt:
      'The Marketplace is the longevity economy in action — products and services members trust, with affiliate and passive income for those who recommend and create.',
  },
  {
    key: 'business_live_media',
    title: 'Business / Live / Media',
    strand: 'economy',
    type: 'teacher',
    tier: 4,
    required_for_graduation: false,
    navigation_route: '/business',
    benefit: 'Create a business for the longevity community.',
    execute_prompt:
      "This is the horizon I want you to see: you can create a business for the longevity community — go live, publish media, build something of your own here. When you're ready, I'll help you start.",
    teach_prompt:
      "The biggest opportunity here is creation: a business, a live presence, media that serves the longevity community. Many members start purely for their health and discover they can build something real. That door is always open to you.",
  },
] as const;

/** Steps that count toward "foundation complete". */
export const GRADUATION_STEP_KEYS: readonly string[] = FOUNDATION_STEPS.filter(
  (s) => s.required_for_graduation,
).map((s) => s.key);

export function getStepDef(key: string): FoundationStepDef | undefined {
  return FOUNDATION_STEPS.find((s) => s.key === key);
}
