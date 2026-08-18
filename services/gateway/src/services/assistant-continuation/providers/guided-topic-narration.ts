/**
 * VTID-03290 — Guided Topic Narration provider.
 *
 * THE PRODUCT CONTRACT: when a user taps a session/topic in the Guided Journey
 * catalog ("My Journey"), Vitana OPENS and TEACHES that topic from the published
 * knowledge base — she introduces it, explains it in her own words (guidance,
 * NOT a verbatim script read), then guides the user to the topic's practice
 * target. This is the voice half of the 90-session / 250-topic curriculum.
 *
 * It fires ONLY when a topic was explicitly tapped (`topicId` present), so it
 * never competes on a normal open. When it does fire it LEADS turn-1 above every
 * other producer (priority 96 > first_time_welcome 95 > journey_guide 91) — an
 * explicit tap is a direct request and must win. The KB content is bundled on
 * the candidate; a GUIDE-MODE (TEACH) block governs the whole session.
 *
 * Pickup: getOrbTopicSeed() reads the CURRENT PUBLISHED snapshot (Publish = go
 * live; unpublished draft edits never reach voice). See VTID-03289.
 */

import type {
  AssistantContinuation,
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
} from '../types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrbTopicSeed } from '../../guided-journey/checklist-service';
import type { ChecklistExplanation } from '../../../types/journey-checklist';

export const GUIDED_TOPIC_NARRATION_PROVIDER_KEY = 'guided_topic_narration';
export const GUIDED_TOPIC_NARRATION_EXTRA_KEY = 'guided_topic_narration';

// Above first_time_welcome (95) + goal_completion (92) + journey_guide (91): an
// EXPLICIT topic tap is a direct request to be taught that topic; it leads turn-1
// over every other producer. Safe to sit this high because the provider only
// returns a candidate when topicId is present (a real tap) — otherwise it skips.
const GUIDED_TOPIC_NARRATION_PRIORITY = 96;

/** Bundled TEACH content the controller reads off the winning candidate. */
export interface GuidedTopicNarrationContent {
  topic_id: string;
  topic_title: string;
  /**
   * The authored KB voice script. GUIDANCE material — the model teaches FROM it
   * in its own words and in the user's language; it is NOT read verbatim.
   */
  voice_script: string | null;
  explanation: ChecklistExplanation;
  /** Where Vitana guides the user after teaching (route or feature key). */
  practice_target: string | null;
  /** 'published' | 'draft_fallback' — for telemetry/debugging. */
  source: string;
  /**
   * VTID-03650 — pre-synthesized Polly audio for the lesson, when Polly could
   * serve this language/text. The controller (routes/orb-live.ts) plays this
   * to the client BEFORE the live model's first turn, and the turn-1 line +
   * turns-2+ block both switch to their short post-narration variants when
   * this is set — see guided-topic-narration-audio.ts and
   * buildGuidedTopicPostNarrationLine/buildGuidedTopicNarrationBlock. Null or
   * undefined (optional so pre-VTID-03650 test fixtures stay valid) means
   * Polly couldn't serve this request, or wasn't attempted. **This is no
   * longer a fallback to a "say the whole lesson verbatim" turn-1 line
   * (VTID-03665) — that fallback was itself the unresolved defect: it still
   * asked a conversational model to comply with a huge literal payload, the
   * exact shape VTID-03647/03648 measured Nova and Vertex both rejecting.**
   * On this branch turn 1 is the short opener line
   * (buildGuidedTopicNarrationOpenerLine) and the model teaches the topic
   * conversationally from the material via buildGuidedTopicNarrationBlock's
   * legacy paraphrase branch — same teaching mechanism as when Polly
   * succeeds, just without pre-recorded audio.
   */
  narrationAudio?: { audioB64: string; sampleRateHz: number } | null;
}

interface GuidedTopicNarrationInputs {
  supabase: SupabaseClient;
  userId: string;
  isReconnect?: boolean;
  lang: string;
  /** The topicId the user tapped in the Guided Journey catalog. The trigger. */
  topicId?: string | null;
  /** Resolved spoken first name for a warm by-name opener. */
  firstName?: string | null;
  /** Curriculum line; defaults to v2. */
  curriculumVersion?: string;
}

function readInputs(ctx: ContinuationDecisionContext): GuidedTopicNarrationInputs | null {
  const raw = ctx.extra?.[GUIDED_TOPIC_NARRATION_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!obj.supabase || typeof obj.userId !== 'string' || !obj.userId) return null;
  return {
    supabase: obj.supabase as SupabaseClient,
    userId: obj.userId,
    isReconnect: obj.isReconnect === true,
    lang: typeof obj.lang === 'string' && obj.lang ? obj.lang : 'en',
    topicId: typeof obj.topicId === 'string' && obj.topicId ? obj.topicId : null,
    firstName: typeof obj.firstName === 'string' && obj.firstName ? obj.firstName : null,
    curriculumVersion:
      typeof obj.curriculumVersion === 'string' && obj.curriculumVersion ? obj.curriculumVersion : 'v2',
  };
}

export function makeGuidedTopicNarrationProvider(): ContinuationProvider {
  return {
    key: GUIDED_TOPIC_NARRATION_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const inputs = readInputs(ctx);
      if (!inputs) {
        return { providerKey: GUIDED_TOPIC_NARRATION_PROVIDER_KEY, status: 'skipped', latencyMs: 0, reason: 'no_guided_topic_inputs' };
      }
      // No topic tapped → this provider is irrelevant; cede to the normal ladder.
      if (!inputs.topicId) {
        return { providerKey: GUIDED_TOPIC_NARRATION_PROVIDER_KEY, status: 'skipped', latencyMs: 0, reason: 'no_topic_tapped' };
      }
      // Transparent reconnect: the previous turn is still alive — don't re-open.
      if (inputs.isReconnect) {
        return { providerKey: GUIDED_TOPIC_NARRATION_PROVIDER_KEY, status: 'suppressed', latencyMs: 0, reason: 'forced_skip_reconnect' };
      }

      let seed: Awaited<ReturnType<typeof getOrbTopicSeed>>;
      try {
        // VTID-03644: overlay journey_checklist_translations for the tapping
        // user's language instead of always narrating the German source.
        seed = await getOrbTopicSeed(
          inputs.supabase,
          inputs.topicId,
          inputs.curriculumVersion,
          inputs.lang as Parameters<typeof getOrbTopicSeed>[3],
        );
      } catch (err) {
        return {
          providerKey: GUIDED_TOPIC_NARRATION_PROVIDER_KEY,
          status: 'errored',
          latencyMs: 0,
          reason: `guided_topic_seed_failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Topic not live (not in the published snapshot / disabled). Don't narrate
      // a topic the catalog isn't serving — cede to the normal ladder.
      if (!seed) {
        return { providerKey: GUIDED_TOPIC_NARRATION_PROVIDER_KEY, status: 'suppressed', latencyMs: 0, reason: 'topic_not_live' };
      }

      const content: GuidedTopicNarrationContent = {
        topic_id: seed.topicId,
        topic_title: seed.displayLabel,
        voice_script: seed.vitanaVoiceScript,
        explanation: seed.explanation,
        practice_target: seed.guidedPracticeTarget,
        source: seed.source,
        narrationAudio: null,
      };

      // VTID-03650: try Polly FIRST — deterministic TTS has no content-safety
      // judgment to reject legitimate curriculum text with, unlike the two
      // conversational models VTID-03647/03648 measured independently
      // rejecting this exact payload. On success the lesson is delivered as
      // pre-recorded audio (routes/orb-live.ts sends it before the live
      // model's first turn) and the model's own turn-1 line shrinks to a
      // short, safe post-narration follow-up.
      const { synthesizeGuidedTopicNarrationAudio } = await import(
        '../../tts/guided-topic-narration-audio'
      );
      content.narrationAudio = await synthesizeGuidedTopicNarrationAudio(content, inputs.lang);

      // VTID-03665: on Polly FAILURE, do NOT fall back to speaking the raw
      // voice_script verbatim (the pre-VTID-03650 `buildGuidedTopicSpokenLesson`
      // path). Live production evidence after VTID-03650 shipped showed a
      // guided-topic candidate winning the turn-1 ranker correctly
      // (priority 96, dedupe_key guided_topic:T253) with a 1625-char
      // userFacingLine and ZERO `guided_topic_audio_bridge_sent` events in the
      // following 2 days — i.e. Polly never once succeeded in production, so
      // EVERY guided-topic session was still hitting the exact "say this
      // whole curriculum block word-for-word" trigger that VTID-03647/03648
      // measured Nova (and Vertex, now permanently unreachable after the GCP
      // shutdown) independently failing to comply with — which is what
      // "tapping a session opens regular conversation instead" actually was.
      // A working Polly call was never a safe precondition for correctness;
      // it was only ever a nicer DELIVERY MECHANISM for the same lesson. Use
      // the short, direct opener line (already proven reliable — every other
      // continuation provider speaks a short line this same way) for turn 1
      // regardless of Polly's outcome, and let the GUIDE-MODE (TEACH) system
      // instruction block do the actual teaching in the model's own words —
      // `buildGuidedTopicNarrationBlock`'s legacy branch already does exactly
      // this paraphrase-from-material behavior; only the SPOKEN line changes.
      const { buildGuidedTopicNarrationOpenerLine, buildGuidedTopicPostNarrationLine } = await import(
        '../../../orb/live/instruction/guided-topic-narration-prompt'
      );
      const spokenLesson = content.narrationAudio
        ? buildGuidedTopicPostNarrationLine(content.topic_title, inputs.lang, {
            hasPracticeTarget: !!content.practice_target,
          })
        : buildGuidedTopicNarrationOpenerLine(content.topic_title, inputs.lang, {
            firstName: inputs.firstName ?? null,
          });

      const candidate = {
        id: `guided-topic-${seed.topicId}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority: GUIDED_TOPIC_NARRATION_PRIORITY,
        userFacingLine: spokenLesson,
        // MUST be a KNOWN_CTA_TYPES value (ask_permission|navigate|offer_demo|
        // run_tool|explain|noop) or validateContinuationCandidate rejects the
        // candidate and the provider errors out (the journey-guide 'guide_step'
        // bug). 'explain' carries no required fields; the teach-then-redirect
        // behavior comes from userFacingLine + the bundled TEACH block.
        cta: { type: 'explain', payload: { topic_id: seed.topicId, route: seed.guidedPracticeTarget } },
        evidence: [
          { kind: 'source:guided_topic_narration', detail: seed.topicId },
          { kind: 'guided_topic_source', detail: seed.source },
        ],
        dedupeKey: `guided_topic:${seed.topicId}`,
        privacyMode: 'safe_to_speak',
        // Bundled — controller / livekit handler read candidate.guidedTopicNarration.
        guidedTopicNarration: content,
      } as unknown as AssistantContinuation;

      return { providerKey: GUIDED_TOPIC_NARRATION_PROVIDER_KEY, status: 'returned', latencyMs: 0, candidate };
    },
  };
}
