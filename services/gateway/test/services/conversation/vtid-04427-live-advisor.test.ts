/**
 * VTID-04427 (Plan v1 WS-3.2) — the live advisor. Runs off the audio path
 * after a meaningful user turn and writes a note; `get_guidance` only reads it.
 * Inert until the owner approves the `advisor` routing stage and flips
 * ORB_LIVE_ADVISOR_ENABLED.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { VALID_STAGES } from '../../../src/constants/llm-defaults';
import {
  ADVISOR_LIMITS,
  ADVISOR_STAGE,
  ADVISOR_SYSTEM_PROMPT,
  GET_GUIDANCE_DECLARATION,
  GET_GUIDANCE_TOOL_NAME,
  buildAdvisorPrompt,
  isAdvisorStageApproved,
  isLiveAdvisorActive,
  isLiveAdvisorEnabled,
  isMeaningfulTurn,
  newAdvisorState,
  parseAdvisorOutput,
  readGuidance,
  runLiveAdvisor,
  type AdvisorInput,
  type AdvisorModelCall,
} from '../../../src/services/conversation/live-advisor';
import { answerGetGuidance, triggerLiveAdvisor } from '../../../src/orb/live/session/live-advisor-hook';

const SRC = join(__dirname, '../../../src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const INPUT: AdvisorInput = {
  turns: [
    { role: 'user', text: 'I slept badly again and I feel tired all day' },
    { role: 'assistant', text: 'That sounds hard.' },
  ],
  currentRoute: '/health',
  screenTitle: 'Health',
  leads: ['Sleep has been under six hours three nights running'],
  declaredTools: ['log_sleep', 'get_vitana_index', 'navigate'],
  lang: 'de',
};

const okModel = (note: Record<string, unknown>, cost = 0.001): AdvisorModelCall =>
  jest.fn(async () => ({ ok: true, text: JSON.stringify(note), cost_usd: cost, tokens_in: 400, tokens_out: 60 }));

describe('activation — inert until the owner decides', () => {
  it('the advisor stage is not approved in this build', () => {
    expect(VALID_STAGES as readonly string[]).not.toContain(ADVISOR_STAGE);
    expect(isAdvisorStageApproved()).toBe(false);
    expect(isLiveAdvisorActive({ ORB_LIVE_ADVISOR_ENABLED: 'true' })).toBe(false);
  });

  it('needs the approved stage AND the exact flag', () => {
    const stages = [...VALID_STAGES, ADVISOR_STAGE];
    expect(isLiveAdvisorActive({ ORB_LIVE_ADVISOR_ENABLED: 'true' }, stages)).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'yes', 'false']) {
      expect(isLiveAdvisorEnabled({ ORB_LIVE_ADVISOR_ENABLED: v })).toBe(false);
      expect(isLiveAdvisorActive({ ORB_LIVE_ADVISOR_ENABLED: v }, stages)).toBe(false);
    }
  });

  it('runLiveAdvisor and the session hook make no model call while inactive', async () => {
    const callModel = okModel({ note: 'x' });
    const r = await runLiveAdvisor(newAdvisorState(), 'I slept badly again this week', 1, INPUT, { callModel });
    expect(r).toEqual({ ran: false, reason: 'inactive' });
    const session: any = { identity: { user_id: 'u' }, turn_count: 1 };
    expect(triggerLiveAdvisor(session, 'I slept badly again this week', jest.fn(), { callModel })).toBeUndefined();
    expect(callModel).not.toHaveBeenCalled();
    expect(session.advisorState).toBeUndefined();
  });
});

describe('isMeaningfulTurn', () => {
  it('skips small talk and very short turns', () => {
    for (const t of ['ok', 'Yes.', 'danke', 'thank you', 'hmm', '', null, 'go on then']) expect(isMeaningfulTurn(t)).toBe(false);
    expect(isMeaningfulTurn('What should I do about my sleep')).toBe(true);
  });
});

describe('buildAdvisorPrompt', () => {
  it('bounds the turns and names the screen, leads, tools and language', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, text: `turn ${i} ` + 'x'.repeat(1000) }));
    const p = buildAdvisorPrompt({ ...INPUT, turns });
    expect(p).not.toContain('turn 11 ');
    expect(p).toContain('turn 12 ');
    expect(p).toContain('Current screen: /health (Health)');
    expect(p).toContain('1. Sleep has been under six hours');
    expect(p).toContain('log_sleep, get_vitana_index, navigate');
    expect(p).toContain('User language: de');
    expect(p.length).toBeLessThan(ADVISOR_LIMITS.maxTurns * (ADVISOR_LIMITS.turnMaxChars + 20) + 2000);
  });

  it('the system prompt asks for intent, not a sentence to speak', () => {
    expect(ADVISOR_SYSTEM_PROMPT).toMatch(/composes its own words/);
    expect(ADVISOR_SYSTEM_PROMPT).not.toMatch(/say exactly|verbatim/i);
  });
});

describe('parseAdvisorOutput', () => {
  const allowed = new Set(INPUT.declaredTools);

  it('parses a note and keeps only declared tools', () => {
    const n = parseAdvisorOutput(
      'here {"note":"The user is tired after poor sleep; propose logging last night.","suggested_tools":["log_sleep","drop_db","log_sleep","navigate","get_vitana_index"],"confidence":1.7}',
      allowed,
    );
    expect(n).toEqual({
      text: 'The user is tired after poor sleep; propose logging last night.',
      suggested_tools: ['log_sleep', 'navigate', 'get_vitana_index'],
      confidence: 1,
    });
  });

  it('drops a note that asks the assistant to recite a line (NEVER-rule 41)', () => {
    expect(parseAdvisorOutput('{"note":"Say exactly: you are doing great"}', allowed)).toBeNull();
    expect(parseAdvisorOutput('{"note":"Read this verbatim to the user"}', allowed)).toBeNull();
  });

  it('returns null for empty, non-JSON or empty-note output and bounds the note', () => {
    for (const raw of [null, '', 'no json', '{bad', '{"note":""}', '{"note":42}']) expect(parseAdvisorOutput(raw, allowed)).toBeNull();
    const long = parseAdvisorOutput(JSON.stringify({ note: 'a '.repeat(2000) }), allowed)!;
    expect(long.text.length).toBeLessThanOrEqual(ADVISOR_LIMITS.noteMaxChars);
    expect(long.confidence).toBeNull();
  });
});

describe('runLiveAdvisor (active)', () => {
  const USER = 'I slept badly again and feel tired';

  it('writes a note and emits advisor_note with cost and latency', async () => {
    const state = newAdvisorState();
    const emit = jest.fn();
    let t = 1000;
    const r = await runLiveAdvisor(state, USER, 3, INPUT, {
      active: true,
      callModel: okModel({ note: 'Propose logging last night\'s sleep.', suggested_tools: ['log_sleep'] }, 0.002),
      emitDiag: emit,
      now: () => (t += 250),
    });
    expect(r.ran).toBe(true);
    expect(state.note).toMatchObject({ text: 'Propose logging last night\'s sleep.', suggested_tools: ['log_sleep'], turn: 3 });
    expect(state).toMatchObject({ calls: 1, cost_usd: 0.002, in_flight: false });
    expect(emit).toHaveBeenCalledWith('advisor_note', expect.objectContaining({ latency_ms: 250, cost_usd: 0.002, suggested_tools: ['log_sleep'], turn: 3 }));
  });

  it('calls the advisor stage with the bounded output budget', async () => {
    const callModel = okModel({ note: 'n' });
    await runLiveAdvisor(newAdvisorState(), USER, 1, INPUT, { active: true, callModel });
    expect(callModel).toHaveBeenCalledWith(expect.objectContaining({
      stage: ADVISOR_STAGE, systemPrompt: ADVISOR_SYSTEM_PROMPT, maxTokens: ADVISOR_LIMITS.maxOutputTokens,
    }));
  });

  it('skips small talk without a model call', async () => {
    const callModel = okModel({ note: 'n' });
    expect(await runLiveAdvisor(newAdvisorState(), 'ok', 1, INPUT, { active: true, callModel })).toEqual({ ran: false, reason: 'not_meaningful' });
    expect(callModel).not.toHaveBeenCalled();
  });

  it('never runs two passes at once', async () => {
    const state = { ...newAdvisorState(), in_flight: true };
    expect(await runLiveAdvisor(state, USER, 1, INPUT, { active: true, callModel: okModel({ note: 'n' }) }))
      .toEqual({ ran: false, reason: 'in_flight' });
  });

  it('stops at the per-session call cap and cost cap', async () => {
    const emit = jest.fn();
    const callModel = okModel({ note: 'n' });
    const capped = { ...newAdvisorState(), calls: ADVISOR_LIMITS.maxCallsPerSession };
    expect((await runLiveAdvisor(capped, USER, 1, INPUT, { active: true, callModel, emitDiag: emit })).reason).toBe('call_cap');
    const broke = { ...newAdvisorState(), cost_usd: ADVISOR_LIMITS.maxCostUsdPerSession };
    expect((await runLiveAdvisor(broke, USER, 1, INPUT, { active: true, callModel, emitDiag: emit })).reason).toBe('cost_cap');
    expect(callModel).not.toHaveBeenCalled();
    expect(emit.mock.calls.map((c) => c[1].reason)).toEqual(['call_cap', 'cost_cap']);
  });

  it('a slow call times out, keeps the previous note and frees the slot', async () => {
    jest.useFakeTimers();
    try {
      const prev = { text: 'old', suggested_tools: [], confidence: null, turn: 1, at: 0, latency_ms: 10 };
      const state = { ...newAdvisorState(), note: prev };
      const emit = jest.fn();
      const slow: AdvisorModelCall = () => new Promise(() => { /* never resolves */ });
      const p = runLiveAdvisor(state, USER, 2, INPUT, { active: true, callModel: slow, emitDiag: emit });
      jest.advanceTimersByTime(ADVISOR_LIMITS.timeoutMs + 1);
      const r = await p;
      expect(r.reason).toBe('timeout');
      expect(state.note).toBe(prev);
      expect(state.in_flight).toBe(false);
      expect(emit).toHaveBeenCalledWith('advisor_skipped', expect.objectContaining({ reason: 'timeout' }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed, throwing or unusable call is recorded and never throws', async () => {
    const emit = jest.fn();
    const failed: AdvisorModelCall = async () => ({ ok: false, error: 'down', cost_usd: 0.0005 });
    const state = newAdvisorState();
    expect((await runLiveAdvisor(state, USER, 1, INPUT, { active: true, callModel: failed, emitDiag: emit })).reason).toBe('error');
    expect(state.cost_usd).toBe(0.0005);
    const throwing: AdvisorModelCall = async () => { throw new Error('boom'); };
    expect((await runLiveAdvisor(state, USER, 1, INPUT, { active: true, callModel: throwing, emitDiag: emit })).reason).toBe('error');
    const recite = okModel({ note: 'Say exactly: hello' });
    expect((await runLiveAdvisor(state, USER, 1, INPUT, { active: true, callModel: recite, emitDiag: emit })).reason).toBe('unusable_output');
    expect(state.note).toBeNull();
    expect(state.in_flight).toBe(false);
    const throwingEmit = () => { throw new Error('diag down'); };
    expect((await runLiveAdvisor(state, USER, 1, INPUT, { active: true, callModel: okModel({ note: 'n' }), emitDiag: throwingEmit })).ran).toBe(true);
  });
});

describe('readGuidance / get_guidance', () => {
  it('returns nothing before the first note', () => {
    const r = readGuidance(undefined, 1);
    expect(r).toMatchObject({ success: true, fresh: false, age_turns: null });
    expect(JSON.parse(r.result).note).toBeNull();
  });

  it('serves a fresh note as guidance, not text to read out, and counts reads', () => {
    const state = { ...newAdvisorState(), note: { text: 'Propose a short walk.', suggested_tools: ['navigate'], confidence: 0.8, turn: 4, at: 0, latency_ms: 300 } };
    const r = readGuidance(state, 5);
    expect(r).toMatchObject({ fresh: true, age_turns: 1 });
    const body = JSON.parse(r.result);
    expect(body).toMatchObject({ note: 'Propose a short walk.', suggested_tools: ['navigate'] });
    expect(body.how_to_use).toMatch(/not text to read out/);
    expect(state.reads).toBe(1);
  });

  it('does not serve a stale note', () => {
    const state = { ...newAdvisorState(), note: { text: 'old', suggested_tools: [], confidence: null, turn: 1, at: 0, latency_ms: 1 } };
    const r = readGuidance(state, 1 + ADVISOR_LIMITS.freshTurns + 1);
    expect(r.fresh).toBe(false);
    expect(JSON.parse(r.result).note).toBeNull();
  });

  it('answerGetGuidance reads the session state and emits guidance_read', () => {
    const emit = jest.fn();
    const session: any = { turn_count: 2, advisorState: { ...newAdvisorState(), note: { text: 'n', suggested_tools: [], confidence: null, turn: 2, at: 0, latency_ms: 1 } } };
    const r = answerGetGuidance(session, emit);
    expect(r.success).toBe(true);
    expect(JSON.parse(r.result).note).toBe('n');
    expect(emit).toHaveBeenCalledWith(session, 'guidance_read', { fresh: true, age_turns: 0 });
    expect(() => answerGetGuidance(session, () => { throw new Error('x'); })).not.toThrow();
  });

  it('the declaration takes no arguments and describes intent use', () => {
    expect(GET_GUIDANCE_DECLARATION.name).toBe(GET_GUIDANCE_TOOL_NAME);
    expect(GET_GUIDANCE_DECLARATION.parameters).toEqual({ type: 'object', properties: {} });
    expect(GET_GUIDANCE_DECLARATION.description).toMatch(/own words/);
  });
});

describe('triggerLiveAdvisor (session hook, active)', () => {
  it('skips anonymous sessions and sessions without a user', () => {
    const callModel = okModel({ note: 'n' });
    expect(triggerLiveAdvisor({ isAnonymous: true, identity: { user_id: 'u' } }, 'I slept badly again this week', undefined, { active: true, callModel })).toBeUndefined();
    expect(triggerLiveAdvisor({ identity: null }, 'I slept badly again this week', undefined, { active: true, callModel })).toBeUndefined();
    expect(callModel).not.toHaveBeenCalled();
  });

  it('gathers the session context and leads, then writes the note', async () => {
    const callModel = okModel({ note: 'Offer to log sleep.', suggested_tools: ['log_sleep'] });
    const leads = jest.fn(async () => ['Sleep is down this week']);
    const emit = jest.fn();
    const session: any = {
      identity: { user_id: 'u1' }, turn_count: 3, lang: 'en', current_route: '/health',
      screenContext: { screen_title: 'Health' },
      declaredToolNames: new Set(['log_sleep', 'navigate']),
      transcriptTurns: [{ role: 'user', text: 'I slept badly again this week' }],
    };
    await triggerLiveAdvisor(session, 'I slept badly again this week', emit, { active: true, callModel, leads });
    expect(leads).toHaveBeenCalledWith('u1', '/health');
    const prompt = (callModel as jest.Mock).mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Sleep is down this week');
    expect(prompt).toContain('Current screen: /health (Health)');
    expect(session.advisorState.note).toMatchObject({ text: 'Offer to log sleep.', turn: 3 });
    expect(emit).toHaveBeenCalledWith(session, 'advisor_note', expect.any(Object));
  });

  it('a failing leads lookup still lets the advisor run without leads', async () => {
    const callModel = okModel({ note: 'n' });
    const session: any = { identity: { user_id: 'u1' }, turn_count: 1 };
    await triggerLiveAdvisor(session, 'I slept badly again this week', undefined, {
      active: true, callModel, leads: async () => { throw new Error('db down'); },
    });
    expect((callModel as jest.Mock).mock.calls[0][0].prompt).toContain('Next-step leads: none');
  });
});

describe('wiring', () => {
  const orbLive = read('routes/orb-live.ts');
  const handler = read('orb/live/session/upstream-message-handler.ts');

  it('get_guidance is declared only for signed-in sessions while the advisor is active', () => {
    expect(orbLive).toMatch(/if \(Array\.isArray\(toolsIn\) && !session\.isAnonymous && isLiveAdvisorActive\(\)\) \{/);
    expect(orbLive).toMatch(/first\.function_declarations = \[GET_GUIDANCE_DECLARATION, /);
  });

  it('get_guidance is answered first, from memory', () => {
    const i = orbLive.indexOf('if (toolName === GET_GUIDANCE_TOOL_NAME) {');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(orbLive.indexOf("markVoiceLatency(session, 'tool_dispatch'"));
    expect(orbLive).toMatch(/return answerGetGuidance\(session as any, emitDiag\);/);
  });

  it('the advisor is triggered after each recorded user turn and never awaited', () => {
    const calls = handler.match(/triggerLiveAdvisor\(session as any, userText, ctx\.deps\.emitDiag\);/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(handler).not.toMatch(/await triggerLiveAdvisor/);
  });

  it('no Google or direct Anthropic provider is named for the advisor', () => {
    const adv = read('services/conversation/live-advisor.ts') + read('orb/live/session/live-advisor-hook.ts');
    expect(adv).not.toMatch(/providerOverride|'anthropic'|'vertex'|gemini/i);
  });
});

describe('the brain inspector', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { summarizeSessionEvents } = require('../../../src/services/conversation/session-brain-inspector');
  const SID = 'live-4427';
  const row = (stage: string, extra: Record<string, unknown>, s = 1) => ({
    topic: 'orb.live.diag', created_at: new Date(Date.UTC(2026, 8, 23, 12, 0, s)).toISOString(), metadata: { session_id: SID, stage, ...extra },
  });

  it('sums notes, reads, cost, skips and suggested tools — never the note text', () => {
    const s = summarizeSessionEvents(SID, [
      row('advisor_note', { latency_ms: 800, cost_usd: 0.0012, suggested_tools: ['log_sleep'], note_chars: 90, turn: 1 }, 1),
      row('guidance_read', { fresh: true, age_turns: 0 }, 2),
      row('advisor_skipped', { reason: 'timeout', latency_ms: 1500 }, 3),
      row('advisor_note', { latency_ms: 600, cost_usd: 0.001, suggested_tools: ['log_sleep', 'navigate'], turn: 3 }, 4),
      row('guidance_read', { fresh: false, age_turns: 4 }, 5),
    ]);
    expect(s.advisor).toEqual({
      notes: 2, skipped: { timeout: 1 }, reads: 2, fresh_reads: 1, cost_usd: 0.0022, latency_ms_max: 1500, suggested_tools: ['log_sleep', 'navigate'],
    });
    expect(JSON.stringify(s.advisor)).not.toMatch(/note_chars|"note"/);
  });

  it('sessions without the advisor carry no advisor summary', () => {
    const s = summarizeSessionEvents(SID, [row('greeting_sent', { wake_opener: 'x' })]);
    expect(s.advisor).toBeUndefined();
  });

  it('the Command Hub shows a Live advisor tile', () => {
    const app = readFileSync(join(SRC, 'frontend/command-hub/app.js'), 'utf8');
    expect(app).toMatch(/_convTile\('Live advisor', d\.advisor \? d\.advisor\.notes \+ ' note\(s\)' : 'not running'/);
  });
});
