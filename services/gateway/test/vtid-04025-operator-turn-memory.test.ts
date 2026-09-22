/**
 * VTID-04025 (W4c): memory that accrues from every operator turn and from
 * every executor run. Pins the skip heuristic (no model call for trivial
 * turns), the extraction prompt, the tolerant parse (fenced JSON, unknown
 * categories dropped, task_outcome never accepted from the model, clamps,
 * dedupe, cap, VTID pick-up), the write shape and fail-open posture, the
 * executor outcome rows (task_outcome on PR, gotcha on failure), and the
 * kill switch. Also source-checks the two wiring sites.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));
jest.mock('../src/services/dev-agent-memory', () => ({ writeDevMemory: jest.fn() }));

import {
  CONTENT_MAX, EXTRACTABLE_CATEGORIES, MAX_ITEMS_PER_TURN, TITLE_MAX,
  buildExecutionOutcomeMemory, buildExtractionPrompt, extractAndRecordTurnMemory, isTurnMemoryEnabled,
  parseExtraction, recordExecutionOutcomeMemory, shouldExtract,
} from '../src/services/operator-turn-memory';

const ON = { OPERATOR_TURN_MEMORY_ENABLED: 'true' } as NodeJS.ProcessEnv;
const okWrite = jest.fn(async () => ({ ok: true as const, id: 'row-1' }));

beforeEach(() => { okWrite.mockClear(); jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('VTID-04025 gate + skip heuristic', () => {
  it('is the exact string true', () => {
    expect(isTurnMemoryEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTurnMemoryEnabled({ OPERATOR_TURN_MEMORY_ENABLED: 'yes' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isTurnMemoryEnabled(ON)).toBe(true);
  });

  it('skips empty and trivial turns, keeps tool turns and substantive replies', () => {
    expect(shouldExtract('', 'x'.repeat(300))).toBe(false);
    expect(shouldExtract('hi', 'hello there')).toBe(false);
    expect(shouldExtract('what is the staging commit?', 'It is 2545dcc.')).toBe(false);
    expect(shouldExtract('what is the staging commit?', 'short', [{ name: 'dev_aws_ecs_status', result: '{}' }])).toBe(true);
    expect(shouldExtract('from now on route the operator stage through deepseek first', 'Understood. '.repeat(20))).toBe(true);
  });
});

describe('VTID-04025 prompt + parse', () => {
  it('the prompt names the allowed categories, the cap, the exclusions, the thread summary and the tool calls', () => {
    const p = buildExtractionPrompt({ userText: 'u', reply: 'r', summary: 'S so far', tools: [{ name: 'dev_db_query', result: '{"rows":[]}' }] });
    expect(p).toContain(`max ${MAX_ITEMS_PER_TURN} items`);
    expect(p).toContain(EXTRACTABLE_CATEGORIES.join('|'));
    expect(p).not.toMatch(/one of .*task_outcome/);
    expect(p).toContain('Do NOT record: transient status');
    expect(p).toContain('Thread so far: S so far');
    expect(p).toContain('- dev_db_query: {"rows":[]}');
    expect(p).toContain('USER: u\n\nASSISTANT: r');
    expect(buildExtractionPrompt({ userText: 'u', reply: 'r' })).not.toContain('Thread so far');
  });

  it('parses a fenced array, drops unknown/short items and task_outcome, clamps, dedupes, caps, and picks up VTIDs', () => {
    const text = '```json\n' + JSON.stringify([
      { category: 'Decision', title: 'Operator stage routes DeepSeek Flash first', content: 'Owner decided the operator stage is deepseek-flash primary with Bedrock Sonnet as fallback (VTID-03817).', importance: 500 },
      { category: 'task_outcome', title: 'PR opened for something', content: 'should never be accepted from the model, that category is owned elsewhere' },
      { category: 'weird', title: 'Unknown category item', content: 'this must be dropped because the category is not allowed' },
      { category: 'gotcha', title: 'x', content: 'title too short so dropped entirely' },
      { category: 'gotcha', title: 'pnpm lockfile must be regenerated too', content: 'TEST-SUITE installs with pnpm --frozen-lockfile; an npm-only lockfile change fails ERR_PNPM_OUTDATED_LOCKFILE.', importance: -3 },
      { category: 'gotcha', title: 'PNPM LOCKFILE MUST BE REGENERATED TOO', content: 'duplicate of the previous title, must be deduped away entirely', importance: 70 },
      { category: 'preference', title: 'Owner wants emoji-rich operator replies', content: 'A style instruction, not a hardcoded sentence; see the operator_chat personality default.', vtid: 'VTID-03817' },
      { category: 'incident', title: 'A fourth item that must be capped away', content: 'because the cap is three items per turn and this is the fourth valid one.' },
    ]) + '\n```';
    const items = parseExtraction(text, 'VTID-04025');
    expect(items).toHaveLength(MAX_ITEMS_PER_TURN);
    expect(items[0]).toMatchObject({ category: 'decision', importance: 90, vtid: 'VTID-03817' });
    expect(items[1]).toMatchObject({ category: 'gotcha', importance: 10, vtid: 'VTID-04025' });
    expect(items[2]).toMatchObject({ category: 'preference', importance: 50, vtid: 'VTID-03817' });
    expect(items.map((i) => i.title)).not.toContain('PR opened for something');
  });

  it('returns [] for empty, non-JSON, non-array and "[]" outputs, and clamps long fields', () => {
    expect(parseExtraction('')).toEqual([]);
    expect(parseExtraction('Nothing durable here.')).toEqual([]);
    expect(parseExtraction('{"category":"decision"}')).toEqual([]);
    expect(parseExtraction('[]')).toEqual([]);
    expect(parseExtraction('[ not json ]')).toEqual([]);
    const [long] = parseExtraction(JSON.stringify([{ category: 'convention', title: 't'.repeat(TITLE_MAX + 50), content: 'c'.repeat(CONTENT_MAX + 50) }]));
    expect(long.title.length).toBe(TITLE_MAX + 1);
    expect(long.content.length).toBe(CONTENT_MAX + 1);
  });
});

describe('VTID-04025 extractAndRecordTurnMemory', () => {
  const turn = { threadId: 'thread-abcdef12', userText: 'From now on the agent executor is DeepSeek Flash primary, Bedrock fallback — never the reverse.', reply: 'Recorded. The executor policy is DeepSeek Flash 4.1 primary with Bedrock Claude Sonnet 4.6 as the fallback; I will apply it to every run going forward and never route to Google.', tools: [] };

  it('is a no-op when disabled and when the turn is trivial — no extractor call', async () => {
    const extract = jest.fn(async () => '[]');
    expect(await extractAndRecordTurnMemory(turn, { extract, write: okWrite, env: {} as NodeJS.ProcessEnv })).toEqual({ written: 0, skipped: 'disabled' });
    expect(await extractAndRecordTurnMemory({ ...turn, reply: 'ok' }, { extract, write: okWrite, env: ON })).toEqual({ written: 0, skipped: 'trivial_turn' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('writes each extracted item with the session source, tags, category and VTID, and appends the thread provenance', async () => {
    const extract = jest.fn(async (prompt: string) => {
      expect(prompt).toContain('USER: From now on the agent executor');
      return JSON.stringify([{ category: 'decision', title: 'Agent executor model policy: DeepSeek Flash primary, Bedrock fallback', content: 'The owner set DeepSeek Flash 4.1 as the agent executor primary and Bedrock Claude as fallback, never the reverse and never Google.', importance: 80, vtid: 'VTID-04006' }]);
    });
    const r = await extractAndRecordTurnMemory(turn, { extract, write: okWrite, env: ON });
    expect(r).toEqual({ written: 1 });
    expect(okWrite).toHaveBeenCalledTimes(1);
    const w = (okWrite.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(w).toMatchObject({ repo: 'vitana-platform', category: 'decision', vtid: 'VTID-04006', importance: 80, source: 'session', tags: ['operator-console', 'turn-extracted', 'decision'] });
    expect(w.content).toContain('never Google');
    expect(w.content).toContain('(Operator Console thread thread-a, extracted from the turn by VTID-04025.)');
  });

  it('fails open: extractor throws → 0 written; empty extractor → skipped; a failed write is logged and counted out', async () => {
    expect(await extractAndRecordTurnMemory(turn, { extract: async () => { throw new Error('router down'); }, write: okWrite, env: ON })).toEqual({ written: 0, skipped: 'error' });
    expect(await extractAndRecordTurnMemory(turn, { extract: async () => null, write: okWrite, env: ON })).toEqual({ written: 0, skipped: 'extractor_empty' });
    const failing = jest.fn(async () => ({ ok: false as const, error: 'embedding_failed' }));
    const two = JSON.stringify([
      { category: 'gotcha', title: 'First durable gotcha title', content: 'content long enough to be accepted by the parser here' },
      { category: 'incident', title: 'Second durable incident title', content: 'content long enough to be accepted by the parser here too' },
    ]);
    expect(await extractAndRecordTurnMemory(turn, { extract: async () => two, write: failing, env: ON })).toEqual({ written: 0 });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('the default extractor goes through the memory routing stage', async () => {
    const { callViaRouter } = require('../src/services/llm-router');
    (callViaRouter as jest.Mock).mockResolvedValue({ ok: true, text: '[]', provider: 'bedrock' });
    expect(await extractAndRecordTurnMemory(turn, { write: okWrite, env: ON })).toEqual({ written: 0 });
    expect(callViaRouter).toHaveBeenCalledWith('memory', expect.stringContaining('long-term engineering memory'), expect.objectContaining({ service: 'operator-turn-memory' }));
  });
});

describe('VTID-04025 executor outcomes', () => {
  it('a run that opened a PR becomes a task_outcome row; a failed run becomes a gotcha row carrying the reason', () => {
    const ok = buildExecutionOutcomeMemory({ executionId: '4f7d5ea4-0000', ok: true, prUrl: 'https://github.com/exafyltd/vitana-platform/pull/3382', branch: 'dev-autopilot/4f7d5ea4', vtid: 'VTID-04012', executor: 'agent', filePaths: ['services/gateway/src/routes/orb-live.ts'] });
    expect(ok).toMatchObject({ category: 'task_outcome', source: 'autopilot', vtid: 'VTID-04012', importance: 40, tags: ['dev-autopilot', 'execution', 'pr_opened'], stage: 'worker', filePaths: ['services/gateway/src/routes/orb-live.ts'] });
    // BOOTSTRAP file-scope wiring: an omitted filePaths list defaults to [], never undefined,
    // so a caller that doesn't yet have a cheap file list still gets a well-formed write.
    expect(buildExecutionOutcomeMemory({ executionId: 'no-files', ok: true }).filePaths).toEqual([]);
    expect(ok.title).toBe('Dev Autopilot 4f7d5ea4 (VTID-04012) opened a PR');
    expect(ok.content).toContain('agent executor run 4f7d5ea4 for VTID-04012 opened https://github.com/exafyltd/vitana-platform/pull/3382 from branch dev-autopilot/4f7d5ea4');
    const bad = buildExecutionOutcomeMemory({ executionId: '47a4d6eb-0000', ok: false, error: 'CI failed: Test Suite\n\n  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"', vtid: 'VTID-04008' });
    expect(bad).toMatchObject({ category: 'gotcha', source: 'autopilot', vtid: 'VTID-04008', importance: 55, tags: ['dev-autopilot', 'execution', 'failed'] });
    expect(bad.title).toContain('Dev Autopilot 47a4d6eb (VTID-04008) failed: CI failed: Test Suite ERR_PNPM_OUTDATED_LOCKFILE');
    expect(bad.content).toContain('Reason: CI failed: Test Suite ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile"');
    expect(buildExecutionOutcomeMemory({ executionId: 'x', ok: false }).content).toContain('Reason: unknown');
  });

  it('recordExecutionOutcomeMemory honours the gate, writes once, and never throws', async () => {
    expect(await recordExecutionOutcomeMemory({ executionId: 'e1', ok: true, prUrl: 'u' }, { write: okWrite, env: {} as NodeJS.ProcessEnv })).toBe(false);
    expect(okWrite).not.toHaveBeenCalled();
    expect(await recordExecutionOutcomeMemory({ executionId: 'e1', ok: true, prUrl: 'u' }, { write: okWrite, env: ON })).toBe(true);
    expect(okWrite).toHaveBeenCalledTimes(1);
    expect(await recordExecutionOutcomeMemory({ executionId: 'e1', ok: false, error: 'x' }, { write: async () => { throw new Error('db down'); }, env: ON })).toBe(false);
    expect(await recordExecutionOutcomeMemory({ executionId: 'e1', ok: false, error: 'x' }, { write: async () => ({ ok: false as const, error: 'embedding_failed' }), env: ON })).toBe(false);
  });
});

describe('VTID-04025 wiring (source check)', () => {
  it('the chat route extracts after the reply, fire-and-forget, with the thread summary and the VTID hint', () => {
    const src = readFileSync(join(__dirname, '../src/routes/operator.ts'), 'utf8');
    expect(src).toContain("import { extractAndRecordTurnMemory, isTurnMemoryEnabled } from '../services/operator-turn-memory';");
    const i = src.indexOf('if (isTurnMemoryEnabled()) {');
    expect(i).toBeGreaterThan(src.indexOf('const geminiResult = await processWithGemini('));
    const block = src.slice(i, i + 700);
    expect(block).toContain('extractAndRecordTurnMemory({');
    expect(block).toContain('summary: threadSummary');
    expect(block).toContain('vtidHint: validatedVtid || undefined');
    expect(block).toContain('.catch(');
  });

  it('applyExecutionResult records a task_outcome on pr_opened and a gotcha on failure, fire-and-forget', () => {
    const src = readFileSync(join(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
    expect(src).toContain("import { recordExecutionOutcomeMemory } from './operator-turn-memory';");
    const fn = src.slice(src.indexOf('export async function applyExecutionResult('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('recordExecutionOutcomeMemory({ executionId: execId, ok: true, prUrl: result.pr_url, branch: result.branch })');
    expect(body).toContain('ok: false,\n    error: result.error,');
    expect((body.match(/\.catch\(\(err: unknown\) => console\.warn\(`\$\{LOG_PREFIX\} outcome memory error/g) || []).length).toBe(2);
  });
});
