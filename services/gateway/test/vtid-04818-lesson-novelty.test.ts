/**
 * VTID-04818: Jev P3 gate F — lesson novelty before a dev_agent_memory write.
 * Shadow only: the write is unchanged.
 */
const rows: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import {
  DUPLICATE_SIMILARITY, NEW_SIMILARITY, isLessonNoveltyOn, lessonRef, ruleNovelty, runLessonNoveltyCheck, type StoredLesson,
} from '../src/services/jev/gates/lesson-novelty-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_LESSON_NOVELTY_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const NOW = Date.parse('2026-10-01T12:00:00Z');

const CANDIDATE = { category: 'gotcha', title: 'Bedrock Opus 4.7 profile is not subscribed', content: 'Invoking eu.anthropic.claude-opus-4-7 returns AccessDeniedException; use sonnet-4-6.' };
const stored = (similarity: number, title = 'Opus 4.7 on Bedrock is unsubscribed'): StoredLesson => ({ category: 'gotcha', title, content: 'AccessDenied on invoke', similarity, created_at: '2026-09-21T12:00:00Z' });
const recallWith = (hits: StoredLesson[]) => jest.fn(async () => ({ ok: true as const, hits }));

function answer(keep: number, kind = 'duplicate') {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { new_and_durable: { type: 'noul', noul: keep }, kind: { type: 'choice', choice: kind, probabilities: { [kind]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 300, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04818 decision and rule', () => {
  test('lesson_novelty: telemetry, redacted, new_and_durable + kind', () => {
    const d = getJevDecision('lesson_novelty')!;
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys((d.questions.kind as any).criteria)).toEqual(['new', 'duplicate', 'update', 'too_specific', 'not_a_lesson']);
  });
  test('the rule is certain only at the edges', () => {
    expect(ruleNovelty(null)).toBe('new');
    expect(ruleNovelty(NEW_SIMILARITY - 0.01)).toBe('new');
    expect(ruleNovelty(0.85)).toBeNull();
    expect(ruleNovelty(DUPLICATE_SIMILARITY)).toBe('duplicate');
    expect(lessonRef('agent-exec-abc', CANDIDATE)).toMatch(/^agent-exec-abc:[0-9a-f]{12}$/);
  });
});

describe('VTID-04818 gate', () => {
  test('off (default, typo): nothing recalled, asked or written', async () => {
    const recall = recallWith([stored(0.95)]);
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_LESSON_NOVELTY_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isLessonNoveltyOn(env)).toBe(false);
      expect(await runLessonNoveltyCheck({ threadId: 't1', candidate: CANDIDATE, recall, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(recall).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: candidate judged next to the three most similar stored lessons; agreement against the rule', async () => {
    const recall = recallWith([stored(0.6, 'c'), stored(0.95, 'a'), stored(0.8, 'b'), stored(0.5, 'd')]);
    const call = jest.fn().mockResolvedValue(answer(0.1, 'duplicate'));
    expect(await runLessonNoveltyCheck({ threadId: 't2', candidate: CANDIDATE, recall, env: SHADOW, sb, now: () => NOW, decideOptions: { call } })).toBe('s1');
    expect(recall).toHaveBeenCalledWith(`${CANDIDATE.title}\n${CANDIDATE.content}`);
    const st = call.mock.calls[0][0].state;
    expect(st.stored.map((x: any) => x.title)).toEqual(['a', 'b', 'c']);
    expect(st.stored[0]).toMatchObject({ similarity: 0.95, age_days: 10 });
    expect(rows[0]).toMatchObject({
      gate: 'lesson_novelty', decision: 'lesson_novelty', mode: 'shadow', subject_type: 'dev_memory_candidate', system_action: 'written',
      jev_verdict: { new_and_durable: false, kind: 'duplicate', rule: 'duplicate', best_similarity: 0.95, category: 'gotcha', stored: 3 },
      agreed: true, outcome: 'compared_with_similarity_rule',
    });
  });

  test.each([
    [[], 0.9, true],
    [[stored(0.5)], 0.1, false],
    [[stored(0.85)], 0.9, null],
  ])('stored %j, Jev keep p=%s → agreed %s', async (hits, p, agreed) => {
    await runLessonNoveltyCheck({ threadId: 't3', candidate: CANDIDATE, recall: recallWith(hits as StoredLesson[]), env: SHADOW, sb, now: () => NOW, decideOptions: { call: jest.fn().mockResolvedValue(answer(p as number, 'new')) } });
    expect(rows[0]).toMatchObject({ agreed });
  });

  test('recall failure → nothing; Jev down → fallback row; never throws', async () => {
    const call = jest.fn();
    expect(await runLessonNoveltyCheck({ threadId: 't4', candidate: CANDIDATE, recall: jest.fn(async () => ({ ok: false as const, error: 'embedding_failed' })), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runLessonNoveltyCheck({ threadId: 't5', candidate: CANDIDATE, recall: recallWith([stored(0.95)]), env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0, jev_verdict: { rule: 'duplicate' } });
    await expect(runLessonNoveltyCheck({ threadId: 't6', candidate: CANDIDATE, recall: jest.fn(async () => { throw new Error('db'); }), env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04818 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('every extracted lesson is checked before its write, never awaited; the write is unchanged', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/operator-turn-memory.ts'), 'utf8');
    const at = src.indexOf('void runLessonNoveltyCheck({ threadId: input.threadId, candidate: { category: m.category, title: m.title, content: m.content }, recall: storedLessonRecall, env });');
    expect(at).toBeGreaterThan(src.indexOf('for (const m of items) {'));
    expect(at).toBeLessThan(src.indexOf('const r = await (opts.write || writeDevMemory)({'));
    expect(src).toContain("const storedLessonRecall: LessonRecall = (query) => recallDevMemory(query, 'vitana-platform', { limit: 3 });");
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_LESSON_NOVELTY_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_LESSON_NOVELTY_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_LESSON_NOVELTY_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
