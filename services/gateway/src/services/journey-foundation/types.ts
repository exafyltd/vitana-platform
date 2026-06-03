/**
 * VTID-03255 — Journey Foundation shared contract.
 *
 * The Journey Foundation is the goal-gated, dual-axis (health + longevity
 * economy) guided onboarding path. One shared snapshot powers three surfaces:
 *   - the voice greeting / voice-to-voice flow (orb),
 *   - the mobile "Meine Reise" screen,
 *   - the desktop /autopilot My Journey dashboard.
 *
 * orb-live.ts only transports the session and selected directives — this logic
 * lives here, fully decoupled from the read-only UserAwareness spine.
 */

export type FoundationStepStatus =
  | 'open'        // not started — the next thing to do
  | 'checking'    // verification in flight
  | 'done'        // verified complete
  | 'not_found'   // claimed/expected but not actually saved yet
  | 'active';     // an automation is now running for the user

export type FoundationStrand = 'health' | 'economy';

export type FoundationStepType =
  | 'action'      // user does something → data written → verified against a table
  | 'teacher';    // user comprehends something → acknowledged, advances by motivation

export type EconomicIntent =
  | 'build_business'
  | 'passive_income'
  | 'earn_recommendations'
  | 'curious'; // satisfies the gate — nobody is blocked, everyone declares a stance

/** A step as rendered on screen / handed to the voice layer. */
export interface FoundationStepView {
  key: string;
  title: string;
  strand: FoundationStrand;
  type: FoundationStepType;
  tier: number; // 0 = gate, 1..4 = priority tiers
  status: FoundationStepStatus;
  required_for_graduation: boolean;
  navigation_route: string | null;
  benefit: string; // the "Jetzt wichtig" one-line benefit
}

export interface JourneyGoalView {
  primary_goal: string | null;
  category: string | null;
  target_value: number | null;
  target_unit: string | null;
  target_date: string | null; // ISO date — drives days_left
  starting_value: number | null;
}

export interface JourneySessionUpdateView {
  session_id: string | null;
  completed_steps: string[];
  next_step: string | null;
  summary: string | null;
  created_at: string;
}

/** The one shared snapshot — read by voice, mobile, and desktop. */
export interface JourneyFoundationSnapshot {
  journey_started: boolean; // dual-axis gate passed (health goal AND economic_intent)
  goal_day: number | null; // day number in the journey (0-based), null until started
  days_left: number | null; // from life_compass.target_date
  active_goal: JourneyGoalView | null;
  economic_intent: EconomicIntent | null;
  weakest_habit: string | null; // stated focus_pillar, later refined by the Index
  foundation_steps: FoundationStepView[];
  current_next_step: FoundationStepView | null;
  suggested_navigation: string | null; // route for current_next_step
  recent_session_updates: JourneySessionUpdateView[];
  north_stars: { health: string | null; economy: string | null }; // dual hero
  graduated: boolean; // all required steps satisfied
}

/** Emitted after every user answer (P2). */
export interface JourneyFoundationDelta {
  changed_fields: string[];
  completed_step: string | null;
  verified_status: FoundationStepStatus;
  next_step: FoundationStepView | null;
  navigation_directive: string | null;
  screen_message: string | null;
}

/** Written at the end of each voice session (P3). */
export interface JourneySessionUpdate {
  session_id: string;
  completed_steps: string[];
  next_step: string | null;
  summary: string;
}

/** The thin per-user row backing user_journey_foundation. */
export interface JourneyFoundationRow {
  user_id: string;
  journey_started_at: string | null;
  current_next_step: string | null;
  economic_intent: EconomicIntent | null;
  focus_pillar: string | null;
  completed_steps_cache: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
