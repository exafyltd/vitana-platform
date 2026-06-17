/**
 * Product Analytics — server-side event emitter (BOOTSTRAP-PRODUCT-ANALYTICS)
 *
 * trackServerEvent() writes one row into product_analytics_events for
 * signals only the backend can see: intent classification, topic detection,
 * tool calls and their outcomes. Fire-and-forget — analytics must never
 * block or fail a user-facing request.
 *
 * Privacy: callers pass metadata only (intent, topic, confidence, tool
 * names, latency). Raw message text is stripped defensively via the same
 * forbidden-key filter the ingestion endpoint uses.
 */

import { createHash, randomUUID } from 'crypto';
import { getSupabase } from '../../lib/supabase';
import { sanitizeProperties } from '../../routes/product-analytics';

const LOG_PREFIX = '[Analytics:Product:Server]';

export interface ServerTrackInput {
  event_name: string;
  event_type?: 'journey' | 'assistant' | 'feature' | 'interest' | 'friction' | 'performance' | 'content';
  tenant_id: string;
  /** Raw user id — hashed before persistence, never stored. */
  user_id?: string | null;
  session_id?: string | null;
  conversation_id?: string | null;
  screen_route?: string;
  feature_key?: string | null;
  source?: 'gateway' | 'assistant' | 'orb';
  language?: string | null;
  properties?: Record<string, unknown>;
}

export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

export async function trackServerEvent(input: ServerTrackInput): Promise<void> {
  try {
    const supa = getSupabase();
    if (!supa) return;

    const row = {
      event_id: randomUUID(),
      event_name: input.event_name,
      event_type: input.event_type ?? 'assistant',
      tenant_id: input.tenant_id,
      user_id_hash: input.user_id ? hashUserId(input.user_id) : null,
      session_id: input.session_id || `server-${input.conversation_id || randomUUID()}`,
      journey_id: null,
      conversation_id: input.conversation_id ?? null,
      screen_route: input.screen_route || 'server',
      screen_id: null,
      feature_key: input.feature_key ?? null,
      source: input.source ?? 'gateway',
      app_version: null,
      language: input.language ?? null,
      device_type: 'unknown',
      consent_state: 'anonymous',
      properties: sanitizeProperties(input.properties ?? {}),
      occurred_at: new Date().toISOString(),
    };

    const { error } = await supa.from('product_analytics_events').insert(row);
    if (error) console.warn(`${LOG_PREFIX} ${input.event_name} write failed: ${error.message}`);
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} ${input.event_name} failed: ${err?.message}`);
  }
}

// ── Topic detection (controlled vocabulary) ─────────────────────────────────
//
// Keyword classifier over the controlled topic list. Deliberately simple:
// topics feed adoption/interest dashboards, so a stable controlled
// vocabulary beats a clever-but-drifting LLM label. Only the matched topic
// (never the text) is persisted.

export const ANALYTICS_TOPICS = [
  'longevity',
  'sleep',
  'nutrition',
  'supplements',
  'exercise',
  'lab_results',
  'biomarkers',
  'stress',
  'hormones',
  'weight',
  'skin',
  'community',
  'coaching',
  'pricing',
  'appointments',
  'maxina_program',
  'app_support',
] as const;

export type AnalyticsTopic = (typeof ANALYTICS_TOPICS)[number];

const TOPIC_KEYWORDS: Record<AnalyticsTopic, RegExp> = {
  longevity: /\b(longevity|lifespan|healthspan|langlebigkeit|alterung|anti.?aging)\b/i,
  sleep: /\b(sleep|insomnia|schlaf|schlafen|melatonin|rem)\b/i,
  nutrition: /\b(nutrition|diet|food|meal|ern[äa]hrung|essen|kalorien|protein|fasting|fasten)\b/i,
  supplements: /\b(supplement|vitamin|magnesium|omega|creatine|nahrungserg[äa]nzung|kreatin)\b/i,
  exercise: /\b(exercise|workout|training|fitness|cardio|krafttraining|bewegung|sport)\b/i,
  lab_results: /\b(lab result|blood test|laborwert|blutbild|blutwert|labor)\b/i,
  biomarkers: /\b(biomarker|hba1c|crp|cholesterol|cholesterin|glucose|glukose|apob)\b/i,
  stress: /\b(stress|anxiety|burnout|cortisol|angst|entspannung|meditation)\b/i,
  hormones: /\b(hormone?|testosterone?|estrogen|[öo]strogen|thyroid|schilddr[üu]se)\b/i,
  weight: /\b(weight|abnehmen|gewicht|bmi|fat loss|zunehmen)\b/i,
  skin: /\b(skin|haut|acne|akne|collagen|kollagen|wrinkle|falten)\b/i,
  community: /\b(community|group|gruppe|member|mitglied|meetup|forum)\b/i,
  coaching: /\b(coach|coaching|mentor|berater|beratung)\b/i,
  pricing: /\b(price|pricing|cost|preis|kosten|subscription|abo|bezahl)\b/i,
  appointments: /\b(appointment|booking|termin|buchung|consultation|sprechstunde)\b/i,
  maxina_program: /\b(maxina|vitana.?index|programm?\b|journey|guided)\b/i,
  app_support: /\b(bug|error|crash|login|password|passwort|funktioniert nicht|broken|support)\b/i,
};

/**
 * Returns the detected topic for a user message, or null. The message text
 * itself is used only in-memory for matching and is never persisted.
 */
export function detectTopic(text: string): AnalyticsTopic | null {
  if (!text) return null;
  for (const topic of ANALYTICS_TOPICS) {
    if (TOPIC_KEYWORDS[topic].test(text)) return topic;
  }
  return null;
}

// ── Coarse intent classification ────────────────────────────────────────────
//
// v1 is rule-based on purpose: a stable four-bucket label for dashboards
// (question / request_action / feedback / statement). When the Intent Engine
// (FEATURE_INTENT_ENGINE_A) graduates, swap this for its output and keep the
// event name. Only the label + confidence are persisted, never the text.

export type AnalyticsIntent = 'question' | 'request_action' | 'feedback' | 'statement';

const QUESTION_RX = /\?|^\s*(what|how|why|when|where|who|which|can|could|should|is|are|do|does|was|wie|warum|wann|wo|wer|welche|kann|soll|ist|sind|hat)\b/i;
const ACTION_RX = /^\s*(open|show|start|book|create|set|add|remind|navigate|go to|play|schedule|cancel|delete|[öo]ffne|zeig|starte|buche|erstelle|erinnere|geh zu|spiel)\b/i;
const FEEDBACK_RX = /\b(thank|thanks|danke|great|perfect|super|wrong|falsch|bad|schlecht|not (working|helpful)|doesn'?t work|funktioniert nicht)\b/i;

export function classifyIntent(text: string): { intent: AnalyticsIntent; confidence: number } {
  const trimmed = (text || '').trim();
  if (!trimmed) return { intent: 'statement', confidence: 0.3 };
  if (ACTION_RX.test(trimmed)) return { intent: 'request_action', confidence: 0.7 };
  if (QUESTION_RX.test(trimmed)) return { intent: 'question', confidence: 0.7 };
  if (FEEDBACK_RX.test(trimmed)) return { intent: 'feedback', confidence: 0.6 };
  return { intent: 'statement', confidence: 0.4 };
}
