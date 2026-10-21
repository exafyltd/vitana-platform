/**
 * VTID-04427 (Plan v1 WS-3.2) — the live advisor.
 *
 * Following the WS-3.1 decision (VTID-04424): Nova cannot take new
 * information mid-stream except through a tool, and a tool's fetch time is
 * added one-for-one to the user's wait. So the advisor runs OFF the audio
 * path: after a meaningful user turn it writes a short guidance note into the
 * session; the `get_guidance` tool only READS that note and returns at once.
 * Nothing is injected into the stream, and nothing here ever blocks audio.
 *
 * INERT UNTIL THE OWNER DECIDES. The advisor calls the `advisor` routing
 * stage, which does not exist yet — adding it is the owner's approval item
 * (plan v1 WS-3.2). `isLiveAdvisorActive()` is true only when BOTH that
 * stage is in `VALID_STAGES` AND `ORB_LIVE_ADVISOR_ENABLED` is exactly
 * 'true'. Until then no advisor call is made and `get_guidance` is not
 * declared. This module adds no stage.
 *
 * Boundaries, conservative by default:
 *   - Context: the recent turns, the current screen, and the brain's
 *     speakable next-step leads (WS-2.3, `safe_to_speak` only). No memory,
 *     no health data — what the advisor may see beyond that is an open
 *     question for plan v2.
 *   - Output: an instruction for the model, never a sentence for it to say
 *     (NEVER-rule 41); a note that asks to recite anything is dropped.
 *   - Cost and latency: a per-call timeout, a per-session call cap and a
 *     per-session cost cap. A call that fails or runs over is recorded and
 *     leaves the previous note in place.
 */

import { VALID_STAGES, type LLMStage } from '../../constants/llm-defaults';
import { isVerbatimRecitationDirective } from './phrasing-rule';

export const ADVISOR_STAGE = 'advisor';
export const ADVISOR_ENV = 'ORB_LIVE_ADVISOR_ENABLED';
export const GET_GUIDANCE_TOOL_NAME = 'get_guidance';

export const ADVISOR_LIMITS = {
  timeoutMs: 1_500,
  maxCallsPerSession: 20,
  maxCostUsdPerSession: 0.05,
  minWords: 4,
  maxTurns: 8,
  turnMaxChars: 400,
  noteMaxChars: 600,
  maxSuggestedTools: 3,
  /** A note older than this many user turns is not served. */
  freshTurns: 2,
  maxOutputTokens: 300,
} as const;

export function isAdvisorStageApproved(validStages: readonly string[] = VALID_STAGES): boolean {
  return validStages.includes(ADVISOR_STAGE);
}

export function isLiveAdvisorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[ADVISOR_ENV] === 'true';
}

export function isLiveAdvisorActive(
  env: Record<string, string | undefined> = process.env,
  validStages: readonly string[] = VALID_STAGES,
): boolean {
  return isAdvisorStageApproved(validStages) && isLiveAdvisorEnabled(env);
}

const SMALL_TALK = /^(ok(ay)?|yes|yeah|yep|no|nope|thanks?( you)?|thank you|bye|goodbye|good ?night|ja|nein|danke|tschüss|hallo|hi|hello|hmm+|mhm)\b[.!?]*$/i;

/** A turn worth advising on: at least a few words and not just small talk. */
export function isMeaningfulTurn(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t || SMALL_TALK.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length >= ADVISOR_LIMITS.minWords;
}

export interface AdvisorInput {
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  currentRoute: string | null;
  screenTitle: string | null;
  leads: string[];
  declaredTools: string[];
  lang: string | null;
}

export const ADVISOR_SYSTEM_PROMPT = [
  'You advise a voice assistant called Vitana during a live conversation with a member of a wellness community.',
  'Read the recent turns and the context, then write one short guidance note for the assistant about its next reply.',
  'The note is an instruction to the assistant, written in English, in the third person about the user. It names what matters now and the one next step worth proposing.',
  'The assistant composes its own words in the user\'s language; the note describes intent and facts only.',
  'Use only the facts given here. When nothing useful can be added, return an empty note.',
  'Answer with JSON only: {"note": string, "suggested_tools": string[], "confidence": number between 0 and 1}. suggested_tools may only name tools from the list given.',
].join(' ');

export function buildAdvisorPrompt(input: AdvisorInput): string {
  const turns = input.turns.slice(-ADVISOR_LIMITS.maxTurns)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.replace(/\s+/g, ' ').trim().slice(0, ADVISOR_LIMITS.turnMaxChars)}`)
    .join('\n');
  const parts = [
    `Recent turns (oldest first):\n${turns || '(none)'}`,
    `Current screen: ${input.currentRoute ?? 'unknown'}${input.screenTitle ? ` (${input.screenTitle})` : ''}`,
    input.leads.length ? `Next-step leads the brain already has:\n${input.leads.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : 'Next-step leads: none',
    `Tools the assistant can call: ${input.declaredTools.slice(0, 80).join(', ') || 'none'}`,
    `User language: ${input.lang ?? 'unknown'}`,
  ];
  return parts.join('\n\n');
}

export interface AdvisorNote {
  text: string;
  suggested_tools: string[];
  confidence: number | null;
}

/** Parses and validates the advisor's JSON. Null when unusable. */
export function parseAdvisorOutput(raw: string | null | undefined, allowedTools: ReadonlySet<string>): AdvisorNote | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const text = typeof o.note === 'string' ? o.note.replace(/\s+/g, ' ').trim().slice(0, ADVISOR_LIMITS.noteMaxChars) : '';
  if (!text) return null;
  // NEVER-rule 41: the note is intent. A note that asks the assistant to
  // recite a line is dropped rather than served.
  if (isVerbatimRecitationDirective(text)) return null;
  const tools = Array.isArray(o.suggested_tools)
    ? [...new Set((o.suggested_tools as unknown[]).filter((t): t is string => typeof t === 'string' && allowedTools.has(t)))]
      .slice(0, ADVISOR_LIMITS.maxSuggestedTools)
    : [];
  const c = typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : null;
  return { text, suggested_tools: tools, confidence: c };
}

export interface AdvisorState {
  note: (AdvisorNote & { turn: number; at: number; latency_ms: number }) | null;
  calls: number;
  cost_usd: number;
  in_flight: boolean;
  reads: number;
}

export function newAdvisorState(): AdvisorState {
  return { note: null, calls: 0, cost_usd: 0, in_flight: false, reads: 0 };
}

export type AdvisorModelCall = (args: {
  stage: LLMStage;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
}) => Promise<{ ok: boolean; text?: string; cost_usd?: number; tokens_in?: number; tokens_out?: number; error?: string }>;

export type AdvisorSkipReason = 'inactive' | 'not_meaningful' | 'in_flight' | 'call_cap' | 'cost_cap' | 'timeout' | 'error' | 'unusable_output';

export interface AdvisorRunResult {
  ran: boolean;
  reason?: AdvisorSkipReason;
  note?: AdvisorNote;
  latency_ms?: number;
}

/**
 * One advisor pass for a finished user turn. Never throws and never awaits on
 * the audio path — callers fire it and move on. Writes the note into `state`.
 */
export async function runLiveAdvisor(
  state: AdvisorState,
  userText: string,
  turn: number,
  input: AdvisorInput,
  deps: {
    callModel: AdvisorModelCall;
    emitDiag?: (stage: string, extra: Record<string, unknown>) => void;
    now?: () => number;
    active?: boolean;
  },
): Promise<AdvisorRunResult> {
  const now = deps.now ?? Date.now;
  const emit = (stage: string, extra: Record<string, unknown>) => {
    try { deps.emitDiag?.(stage, extra); } catch { /* diagnostics never matter to the session */ }
  };
  if (!(deps.active ?? isLiveAdvisorActive())) return { ran: false, reason: 'inactive' };
  if (!isMeaningfulTurn(userText)) return { ran: false, reason: 'not_meaningful' };
  if (state.in_flight) return { ran: false, reason: 'in_flight' };
  if (state.calls >= ADVISOR_LIMITS.maxCallsPerSession) {
    emit('advisor_skipped', { reason: 'call_cap', calls: state.calls });
    return { ran: false, reason: 'call_cap' };
  }
  if (state.cost_usd >= ADVISOR_LIMITS.maxCostUsdPerSession) {
    emit('advisor_skipped', { reason: 'cost_cap', cost_usd: state.cost_usd });
    return { ran: false, reason: 'cost_cap' };
  }

  state.in_flight = true;
  state.calls += 1;
  const t0 = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      deps.callModel({
        stage: ADVISOR_STAGE as LLMStage,
        systemPrompt: ADVISOR_SYSTEM_PROMPT,
        prompt: buildAdvisorPrompt(input),
        maxTokens: ADVISOR_LIMITS.maxOutputTokens,
      }),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ADVISOR_LIMITS.timeoutMs); }),
    ]);
    const latency = now() - t0;
    if (result === 'timeout') {
      emit('advisor_skipped', { reason: 'timeout', latency_ms: latency });
      return { ran: false, reason: 'timeout', latency_ms: latency };
    }
    state.cost_usd += Math.max(0, result.cost_usd ?? 0);
    if (!result.ok) {
      emit('advisor_skipped', { reason: 'error', latency_ms: latency });
      return { ran: false, reason: 'error', latency_ms: latency };
    }
    const note = parseAdvisorOutput(result.text, new Set(input.declaredTools));
    if (!note) {
      emit('advisor_skipped', { reason: 'unusable_output', latency_ms: latency });
      return { ran: false, reason: 'unusable_output', latency_ms: latency };
    }
    state.note = { ...note, turn, at: now(), latency_ms: latency };
    emit('advisor_note', {
      latency_ms: latency,
      cost_usd: Math.round((result.cost_usd ?? 0) * 1e6) / 1e6,
      tokens_in: result.tokens_in ?? null,
      tokens_out: result.tokens_out ?? null,
      note_chars: note.text.length,
      suggested_tools: note.suggested_tools,
      turn,
    });
    return { ran: true, note, latency_ms: latency };
  } catch {
    emit('advisor_skipped', { reason: 'error', latency_ms: now() - t0 });
    return { ran: false, reason: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
    state.in_flight = false;
  }
}

/** get_guidance: returns the latest fresh note, instantly. */
export function readGuidance(state: AdvisorState | undefined, currentTurn: number): { success: true; result: string; fresh: boolean; age_turns: number | null } {
  if (state) state.reads += 1;
  const n = state?.note ?? null;
  if (!n) {
    return { success: true, result: JSON.stringify({ note: null, hint: 'No guidance yet for this turn. Answer from what you know.' }), fresh: false, age_turns: null };
  }
  const age = Math.max(0, currentTurn - n.turn);
  if (age > ADVISOR_LIMITS.freshTurns) {
    return { success: true, result: JSON.stringify({ note: null, hint: 'The last guidance is out of date. Answer from what you know.' }), fresh: false, age_turns: age };
  }
  return {
    success: true,
    result: JSON.stringify({
      note: n.text,
      suggested_tools: n.suggested_tools,
      how_to_use: 'This is guidance for you, not text to read out. Follow it in your own words, in the user\'s language.',
    }),
    fresh: true,
    age_turns: age,
  };
}

export const GET_GUIDANCE_DECLARATION = {
  name: GET_GUIDANCE_TOOL_NAME,
  description:
    'Returns the conversation brain\'s current guidance for this turn: what matters now and the next step worth proposing. '
    + 'It returns at once. Call it when the user asks about themselves, their plans or what to do next, and follow the note in your own words.',
  parameters: { type: 'object', properties: {} },
};
