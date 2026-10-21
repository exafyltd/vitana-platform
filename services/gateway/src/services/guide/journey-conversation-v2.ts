/**
 * Journey Conversation V2 — prompt block composer.
 *
 * Flag-gated (vitana_journey_conversation_v2_enabled) replacement for the
 * three competing proactive blocks (opener candidate / initiative / DYK
 * tour hint) on the brain's voice path. Composes, from the single arbiter:
 *
 *   - experience-level style guidance (maturity-aware conversation)
 *   - compact journey-progress awareness line(s)
 *   - exactly ONE proactive focus (with at most one ON-YES tool contract)
 *   - one structured speech intent (greeting or short return)
 *
 * Prompt budget (spec §15): only IDs, counts and one candidate — never the
 * topic catalog. Telemetry goes through the existing emitGuideTelemetry
 * channel; nothing here writes per-turn counters to OASIS lifecycle events.
 */

import { emitGuideTelemetry } from './guide-telemetry';
import {
  pickConversationFocus,
  type ConversationFocus,
} from './conversation-focus';
import {
  buildGreetingSpeechIntent,
  buildResponsibilitySpeechIntent,
  renderSpeechIntentBlock,
} from './speech-intent';
import { EXPERIENCE_STYLE_GUIDANCE } from './journey-experience';
import type { UserAwareness } from './types';

const LOG_PREFIX = '[Guide:journey-v2]';

export interface BuildJourneyV2BlockInput {
  user_id: string;
  awareness: UserAwareness;
  channel: 'voice' | 'text';
}

/**
 * Build the V2 proactive block. Returns '' on any failure so the caller
 * can fall back to the legacy path — the voice path must never break
 * because of a V2 bug.
 */
export async function buildJourneyConversationV2Block(
  input: BuildJourneyV2BlockInput,
): Promise<string> {
  const { awareness } = input;
  const v2 = awareness.journey_v2;

  let selection;
  try {
    selection = await pickConversationFocus({
      user_id: input.user_id,
      awareness,
      channel: input.channel,
    });
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} pickConversationFocus failed:`, err?.message);
    return '';
  }

  const focus = selection.focus;
  const experienceLevel = v2?.experience_level ?? null;

  // Telemetry — same channel as the legacy opener/initiative telemetry.
  if (focus) {
    emitGuideTelemetry('guide.focus.selected', {
      user_id: input.user_id,
      channel: input.channel,
      kind: focus.kind,
      nudge_key: focus.nudge_key,
      experience_level: experienceLevel,
      extended_tenure_stage: v2?.extended_tenure_stage ?? null,
      mode: v2?.journey_progress?.mode ?? null,
    }).catch(() => {});
  } else if (selection.suppressed_by_pause) {
    emitGuideTelemetry('guide.focus.suppressed', {
      user_id: input.user_id,
      channel: input.channel,
      pause_scope: selection.suppressing_pause?.scope ?? null,
    }).catch(() => {});
  } else {
    emitGuideTelemetry('guide.focus.none', {
      user_id: input.user_id,
      channel: input.channel,
      experience_level: experienceLevel,
    }).catch(() => {});
  }

  const sections: string[] = [];

  // --- Maturity-aware conversation style -----------------------------------
  if (experienceLevel) {
    sections.push(
      `
=== CONVERSATION MATURITY (Journey V2) ===
Experience level: ${experienceLevel} (tenure: ${v2!.extended_tenure_stage})
${EXPERIENCE_STYLE_GUIDANCE[experienceLevel]}`,
    );
  }

  // --- Compact journey-progress awareness ----------------------------------
  if (v2) {
    const jp = v2.journey_progress;
    const tasks = v2.completed_priority_tasks;
    const taskBits = [
      `Life Compass ${tasks.life_compass_defined ? 'user-defined ✓' : 'NOT user-defined'}`,
      `profile ${v2.profile_completion_status.completion_percent}%`,
      `diary ${tasks.diary_started ? 'started ✓' : 'not started'}${v2.diary_entry_today ? ' (entry today ✓)' : ''}`,
      `Autopilot ${tasks.autopilot_used ? 'used ✓' : 'never used'}`,
    ];
    const lines = [
      '=== MY JOURNEY AWARENESS (compact) ===',
      jp
        ? `My Journey: ${jp.mode.toUpperCase()} mode, session ${jp.current_session}, ${jp.completed_topic_count} topics completed${jp.next_recommended_topic_id ? `, next topic ${jp.next_recommended_topic_id}` : ''}.`
        : 'My Journey: no guided-journey state yet.',
      `Priority tasks: ${taskBits.join('; ')}.`,
      `Vitana Index maturity: ${v2.vitana_index_maturity}.`,
    ];
    sections.push('\n' + lines.join('\n'));
  }

  // --- Single proactive focus ----------------------------------------------
  if (focus) {
    sections.push(renderFocusBlock(focus));
  } else if (selection.suppressed_by_pause) {
    sections.push(
      `
=== PROACTIVE FOCUS: SUPPRESSED BY USER PAUSE ===
The user asked for quiet. Make NO unsolicited suggestion this session.
Respond warmly to whatever the user brings. Do not mention the pause.`,
    );
  }

  // --- Speech intent (greeting) --------------------------------------------
  const greetingIntent = buildGreetingSpeechIntent(awareness);
  sections.push('\n' + renderSpeechIntentBlock(greetingIntent));

  if (focus?.kind === 'inspiration') {
    const respIntent = buildResponsibilitySpeechIntent(awareness);
    sections.push('\n' + renderSpeechIntentBlock(respIntent));
  }

  return sections.join('\n');
}

function renderFocusBlock(focus: ConversationFocus): string {
  const lines = [
    '',
    '=== PROACTIVE FOCUS (Journey V2 — THE ONE proactive thread this session) ===',
    'Exactly ONE proactive suggestion per turn. This is it — do not add others',
    'unless the user explicitly asks for more. The user\'s own request always',
    'outranks this focus: if they bring a topic, serve it first and weave the',
    'focus in only when natural.',
    `Kind: ${focus.kind}`,
    `nudge_key: ${focus.nudge_key}      ← exact string for pause_proactive_guidance(scope="nudge_key")`,
    `Title: ${focus.title}`,
  ];
  if (focus.detail) lines.push(`Detail: ${focus.detail}`);
  lines.push(`Why selected: ${focus.reason}`);

  if (focus.on_yes_tool) {
    lines.push(
      '',
      `ON USER CONSENT (an explicit yes/ok/sure/ja — never before): call ${focus.on_yes_tool}.`,
      `Payload guidance: ${focus.on_yes_payload_hint ?? 'fill arguments from the conversation'}.`,
      'NEVER call this tool without the user\'s explicit consent in this session.',
    );
  }

  lines.push(
    '',
    'ON DECLINE ("skip", "not now", "nein"): call pause_proactive_guidance with',
    `scope="nudge_key", scope_value="${focus.nudge_key}", duration_minutes=1440,`,
    'then pivot naturally — no apology. Harder refusals ("not today", "quiet")',
    '→ scope="all" per the dismissal tool description. After any pause expires,',
    'never dump a backlog — at most one gentle check-in.',
  );

  if (focus.kind === 'journey_next_topic') {
    lines.push(
      '',
      'Teaching rule: check the feature-introductions list in this prompt —',
      'never repeat a beginner explanation for a feature already introduced;',
      'deepen instead. Call record_feature_introduction after teaching a new one.',
    );
  }

  return lines.join('\n');
}
