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

import { VertexAI } from '@google-cloud/vertexai';
import { getSupabase } from '../../lib/supabase';
import { emitGuideTelemetry } from './guide-telemetry';

const LOG_PREFIX = '[Guide:session-summaries]';
const MAX_SUMMARY_CHARS = 600;
const RECENT_SUMMARIES_LIMIT = 3;

// VTID-01990: Gemini Flash summarizer config
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const SUMMARY_MODEL = 'gemini-2.0-flash';

let summaryVertexAI: VertexAI | null = null;
try {
  if (VERTEX_PROJECT && VERTEX_LOCATION) {
    summaryVertexAI = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });
  }
} catch (err: any) {
  console.warn(`${LOG_PREFIX} Vertex AI init for summarization failed: ${err.message}`);
}

const SUMMARY_SYSTEM_PROMPT = `You write 1-2 sentence summaries of a conversation between a User and an AI assistant named Vitana.

Goal: when the User opens Vitana again, your summary should let them say "remember when we talked about X yesterday morning?" and have it work — so capture the topic and the gist of what was discussed or decided, not pleasantries.

Rules:
- 1-2 sentences, max 280 chars total.
- Refer to the user as "the user", never "you".
- Lead with the topic. Skip greetings, sign-offs, "user said hello", etc.
- If the user revealed a fact about themselves (their company, their goal, a name), include it concisely.
- Do NOT invent details. Stick to what is in the transcript.
- Plain prose. No markdown, no quotes, no JSON.

Example input:
User: My name is Dragan and I work for Exafy. We are building Vitana.
Assistant: Nice to meet you Dragan. That is a fascinating project.
User: Yeah, hoping to ship the autopilot loop next week.

Example output:
The user (Dragan, Exafy) shared that they are building Vitana and aim to ship the autopilot loop next week.`;

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

  // VTID-01990: prefer Gemini Flash summary, fall back to heuristic on any failure
  let summary = await summarizeWithGeminiFlash(input.transcript_turns);
  let summarySource: 'llm' | 'heuristic' = 'llm';
  if (!summary || summary.length === 0) {
    summary = buildSummary(input.transcript_turns);
    summarySource = 'heuristic';
  }
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
    summary_source: summarySource,
  }).catch(() => {});

  console.log(
    `${LOG_PREFIX} stored summary for user=${input.user_id.substring(0, 8)} session=${input.session_id.substring(0, 12)} themes=[${themes.join(',')}] source=${summarySource}`,
  );

  return { success: true, summary };
}

// =============================================================================
// VTID-01990: Gemini Flash summarizer
// =============================================================================

/**
 * Summarize a transcript with Gemini Flash. Returns null on any failure so
 * the caller can fall back to the heuristic builder. Vertex AI primary,
 * Gemini API key fallback — same pattern as inline-fact-extractor.
 */
export async function summarizeWithGeminiFlash(
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
): Promise<string | null> {
  if (!turns || turns.length === 0) return null;

  // Compact transcript, capped per-turn to keep token cost low
  const transcript = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${truncate(t.text.trim(), 400)}`)
    .join('\n');

  if (summaryVertexAI) {
    try {
      const model = summaryVertexAI.getGenerativeModel({
        model: SUMMARY_MODEL,
        generationConfig: { temperature: 0.2, maxOutputTokens: 200, topP: 0.8 },
        systemInstruction: { role: 'system', parts: [{ text: SUMMARY_SYSTEM_PROMPT }] },
      });
      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: transcript }] }],
      });
      const candidate = response.response?.candidates?.[0];
      const textPart = candidate?.content?.parts?.find((p: any) => 'text' in p);
      const raw = textPart ? ((textPart as any).text || '').trim() : '';
      if (raw.length > 0) return truncate(raw, MAX_SUMMARY_CHARS);
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} Vertex summary failed: ${err.message}`);
    }
  }

  if (GOOGLE_GEMINI_API_KEY) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${SUMMARY_MODEL}:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: transcript }] }],
            systemInstruction: { parts: [{ text: SUMMARY_SYSTEM_PROMPT }] },
            generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
          }),
        },
      );
      if (response.ok) {
        const data = (await response.json()) as any;
        const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        if (raw.length > 0) return truncate(raw, MAX_SUMMARY_CHARS);
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} Gemini API summary failed: ${err.message}`);
    }
  }

  return null;
}

// =============================================================================
// VTID-01990: today / yesterday bucketing for awareness
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

interface TodayWindow {
  today_start_utc: string;
  today_end_utc: string;
  yesterday_start_utc: string;
  yesterday_end_utc: string;
}

async function fetchTodayWindow(userId: string, userTz: string): Promise<TodayWindow | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/user_sessions_today_window`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      // VTID-02019: caller is responsible for resolving tz; we pass it through
      // verbatim so the RPC bounds match what the prompt formatter renders.
      body: JSON.stringify({ p_user_id: userId, p_user_tz: userTz }),
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as TodayWindow[];
    return arr && arr.length > 0 ? arr[0] : null;
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} fetchTodayWindow failed: ${err.message}`);
    return null;
  }
}

export interface SessionsTodayAndYesterday {
  today: SessionSummary[];
  yesterday_last: SessionSummary | null;
}

/**
 * Cross-surface bucketing of recent session summaries into today and
 * yesterday in the user's local timezone. Used by awareness-context to
 * surface "this is your 3rd session today, last at 14:20" in the prompt.
 *
 * Returns the today list ordered ASC by ended_at (so the awareness prompt
 * can render them in chronological order: "earlier today 09:14, then 11:30,
 * then now"), and the most recent session that ended yesterday.
 */
export async function getSessionsTodayAndYesterday(
  userId: string,
  userTz?: string,
): Promise<SessionsTodayAndYesterday> {
  const empty: SessionsTodayAndYesterday = { today: [], yesterday_last: null };

  const supabase = getSupabase();
  if (!supabase) return empty;

  // VTID-02019: lazy import so the type module stays free of side effects
  const { resolveUserTimezone } = await import('./user-timezone');
  const tz = resolveUserTimezone(userTz);

  const window = await fetchTodayWindow(userId, tz);
  if (!window) return empty;

  // Pull a small range covering both yesterday and today; bucket in JS.
  const { data, error } = await supabase
    .from('user_session_summaries')
    .select('session_id, channel, summary, themes, turn_count, duration_ms, ended_at')
    .eq('user_id', userId)
    .gte('ended_at', window.yesterday_start_utc)
    .lt('ended_at', window.today_end_utc)
    .order('ended_at', { ascending: true });

  if (error || !data) {
    if (error) console.warn(`${LOG_PREFIX} getSessionsTodayAndYesterday read failed: ${error.message}`);
    return empty;
  }

  const todayList: SessionSummary[] = [];
  let yesterdayLast: SessionSummary | null = null;

  for (const row of data as SessionSummary[]) {
    const endedAt = row.ended_at;
    if (endedAt >= window.today_start_utc && endedAt < window.today_end_utc) {
      todayList.push(row);
    } else if (endedAt >= window.yesterday_start_utc && endedAt < window.yesterday_end_utc) {
      // last one wins (data is sorted ASC, so the newest yesterday row overwrites)
      yesterdayLast = row;
    }
  }

  return { today: todayList, yesterday_last: yesterdayLast };
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
