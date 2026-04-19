/**
 * Companion Phase F — Conversation Continuity / Session Summaries (VTID-01933)
 *
 * Stores a short summary of each completed ORB session. Brain reads the last
 * 1-3 summaries on the user's next session so Vitana can naturally weave in
 * continuity ("last time we talked about your sleep — how did the wind-down
 * ritual go?").
 *
 * MVP summary generation: takes the last N transcript turns and extracts
 * the user's primary themes via simple heuristics. Future iteration: a
 * dedicated LLM call for richer summaries.
 */

import { getSupabase } from '../../lib/supabase';
import { emitGuideTelemetry } from './guide-telemetry';

const LOG_PREFIX = '[Guide:session-summaries]';
const MAX_SUMMARY_CHARS = 600;
const RECENT_SUMMARIES_LIMIT = 3;

export interface SessionSummary {
  session_id: string;
  channel: 'voice' | 'text';
  summary: string;
  themes: string[];
  turn_count: number;
  duration_ms: number | null;
  ended_at: string;
}

export interface RecordSessionSummaryInput {
  user_id: string;
  session_id: string;
  channel: 'voice' | 'text';
  transcript_turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  duration_ms?: number | null;
}

/**
 * Read the user's recent session summaries (most recent first).
 * Returns empty array on any error — never throws.
 */
export async function getRecentSessionSummaries(
  userId: string,
  limit: number = RECENT_SUMMARIES_LIMIT,
): Promise<SessionSummary[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('user_session_summaries')
    .select('session_id, channel, summary, themes, turn_count, duration_ms, ended_at')
    .eq('user_id', userId)
    .order('ended_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 10)));

  if (error) {
    console.warn(`${LOG_PREFIX} read failed:`, error.message);
    return [];
  }
  return (data || []) as SessionSummary[];
}

/**
 * Build + persist a summary of a completed session.
 * Idempotent — re-saving the same (user_id, session_id) updates the row.
 *
 * Best-effort: failures are swallowed so they never block session-end.
 */
export async function recordSessionSummary(
  input: RecordSessionSummaryInput,
): Promise<{ success: boolean; summary?: string; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) return { success: false, error: 'storage_unavailable' };

  // Skip empty sessions — nothing to summarize
  if (!input.transcript_turns || input.transcript_turns.length === 0) {
    return { success: false, error: 'empty_transcript' };
  }

  const summary = buildSummary(input.transcript_turns);
  const themes = extractThemes(input.transcript_turns);

  const { error } = await supabase.from('user_session_summaries').upsert(
    {
      user_id: input.user_id,
      session_id: input.session_id,
      channel: input.channel,
      summary,
      themes,
      turn_count: input.transcript_turns.length,
      duration_ms: input.duration_ms ?? null,
      ended_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,session_id' },
  );

  if (error) {
    console.warn(`${LOG_PREFIX} write failed:`, error.message);
    return { success: false, error: error.message };
  }

  emitGuideTelemetry('guide.session_summary.recorded', {
    user_id: input.user_id,
    session_id: input.session_id,
    channel: input.channel,
    turn_count: input.transcript_turns.length,
    themes,
    summary_length: summary.length,
  }).catch(() => {});

  console.log(
    `${LOG_PREFIX} stored summary for user=${input.user_id.substring(0, 8)} session=${input.session_id.substring(0, 12)} themes=[${themes.join(',')}]`,
  );

  return { success: true, summary };
}

// =============================================================================
// Summary builders (MVP — simple heuristics; future: LLM call)
// =============================================================================

/**
 * Build a short prose summary from the transcript.
 * MVP heuristic: take the user's first substantive utterance + the assistant's
 * last substantive reply. Caps at 600 chars.
 */
function buildSummary(turns: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const userTurns = turns.filter((t) => t.role === 'user' && t.text.trim().length > 6);
  const assistantTurns = turns.filter((t) => t.role === 'assistant' && t.text.trim().length > 10);

  const firstUser = userTurns[0]?.text.trim() ?? '';
  const lastAssistant = assistantTurns[assistantTurns.length - 1]?.text.trim() ?? '';
  const lastUser = userTurns[userTurns.length - 1]?.text.trim() ?? '';

  const parts: string[] = [];
  if (firstUser) parts.push(`User opened with: ${truncate(firstUser, 200)}`);
  if (lastUser && lastUser !== firstUser) parts.push(`Last user message: ${truncate(lastUser, 150)}`);
  if (lastAssistant) parts.push(`I closed with: ${truncate(lastAssistant, 200)}`);

  const joined = parts.join('. ');
  return truncate(joined, MAX_SUMMARY_CHARS) || 'Brief session — nothing notable to summarize.';
}

/**
 * Extract simple topical theme tags from the transcript.
 * MVP: keyword heuristics over the full transcript. Future: real NLP.
 */
function extractThemes(turns: Array<{ role: 'user' | 'assistant'; text: string }>): string[] {
  const allText = turns.map((t) => t.text).join(' ').toLowerCase();
  const themes = new Set<string>();
  for (const [theme, patterns] of Object.entries(THEME_PATTERNS)) {
    for (const pat of patterns) {
      if (allText.includes(pat)) {
        themes.add(theme);
        break;
      }
    }
  }
  return Array.from(themes).slice(0, 8);
}

const THEME_PATTERNS: Record<string, string[]> = {
  sleep: ['sleep', 'rest', 'tired', 'insomnia', 'wind down', 'bedtime', 'schlaf'],
  stress: ['stress', 'anxious', 'anxiety', 'overwhelm', 'pressure', 'stresse'],
  nutrition: ['food', 'eat', 'meal', 'diet', 'nutrition', 'hungry', 'essen'],
  exercise: ['workout', 'exercise', 'gym', 'walk', 'run', 'training', 'sport'],
  health: ['health', 'doctor', 'medication', 'symptom', 'pain', 'gesundheit'],
  relationships: ['friend', 'family', 'partner', 'meet', 'social', 'beziehung'],
  business: ['business', 'work', 'income', 'money', 'career', 'project', 'arbeit', 'geld'],
  goals: ['goal', 'objective', 'plan', 'achieve', 'milestone', 'ziel'],
  community: ['community', 'group', 'meetup', 'event', 'gemeinschaft'],
  calendar: ['calendar', 'schedule', 'appointment', 'meeting', 'kalender', 'termin'],
  diary: ['diary', 'journal', 'reflection', 'tagebuch'],
  mood: ['feel', 'feeling', 'mood', 'emotion', 'happy', 'sad', 'gefühl'],
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Format a list of summaries for inclusion in the system prompt.
 * Returns empty string when no summaries.
 */
export function formatSummariesForPrompt(summaries: SessionSummary[]): string {
  if (!summaries || summaries.length === 0) return '';
  const lines: string[] = ['Recent prior sessions (most recent first — weave naturally, do NOT recite):'];
  for (const s of summaries) {
    const when = new Date(s.ended_at).toISOString().slice(0, 10);
    const themes = s.themes && s.themes.length > 0 ? ` [themes: ${s.themes.join(', ')}]` : '';
    lines.push(`  - ${when}${themes}: ${s.summary}`);
  }
  return lines.join('\n');
}
