/**
 * VTID-04444 (Conversation rebuild WS-4.2) — wiring of the diary theme rollup:
 *   - consolidator loop 10 is the old count-only pass when
 *     CONSOLIDATOR_DIARY_ROLLUP_ENABLED is unset, and the rollup when it is
 *     exactly 'true';
 *   - the profile synthesis prompt carries a fresh rollup, and its inputs
 *     hash is unchanged when there is none (no re-synthesis on deploy);
 *   - AP-0915 is registered, scheduled, and listed in learning health.
 */

const countDiaryEntriesSince = jest.fn(async () => ({ count: 7, error: null }));
jest.mock('../src/services/nightly-consolidator-repository', () => ({
  insertConsolidatorRun: jest.fn(async () => ({ data: { id: 'run-1' } })),
  updateConsolidatorRun: jest.fn(async () => ({ error: null })),
  countDiaryEntriesSince,
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/services/system-controls-service', () => ({ getSystemControl: jest.fn(async () => ({ enabled: true })) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => undefined) }));

const runDiaryThemeRollup = jest.fn(async () => ({
  candidates: 4, processed: 4, written: 2, model_calls: 3, errors: 1,
  outcomes: { written: 2, unchanged: 1, model_failed: 1 }, notes: ['time budget reached; the rest run next pass'],
}));
jest.mock('../src/services/memory/diary-theme-rollup', () => {
  const actual = jest.requireActual('../src/services/memory/diary-theme-rollup');
  return { ...actual, runDiaryThemeRollup };
});

import * as fs from 'fs';
import * as path from 'path';
import { runConsolidator } from '../src/services/nightly-consolidator';
import { buildSynthesisPrompt, computeInputsHash } from '../src/services/user-model-synthesis';
import { LEARNING_AUTOMATIONS } from '../src/services/conversation/conversation-metrics';

beforeEach(() => {
  delete process.env.CONSOLIDATOR_DIARY_ROLLUP_ENABLED;
  countDiaryEntriesSince.mockClear();
  runDiaryThemeRollup.mockClear();
});

describe('consolidator loop 10', () => {
  it('flag unset: the previous count-only pass, no rollup', async () => {
    const r = await runConsolidator({ triggered_by: 'admin', loops: ['loop_10_diary'] });
    expect(runDiaryThemeRollup).not.toHaveBeenCalled();
    expect(countDiaryEntriesSince).toHaveBeenCalledTimes(1);
    expect(r.loops[0]).toMatchObject({
      ok: true, loop: 'loop_10_diary', processed: 7, errors: 0,
      notes: 'verified-only pass; LLM theme rollup deferred to brain unification',
    });
  });

  it('flag "true": runs the rollup with the run scope and reports its outcome', async () => {
    process.env.CONSOLIDATOR_DIARY_ROLLUP_ENABLED = 'true';
    const scope = { tenant_id: 't-1', user_id: 'u-1' };
    const r = await runConsolidator({ triggered_by: 'admin', loops: ['loop_10_diary'], user_scope: scope });
    expect(countDiaryEntriesSince).not.toHaveBeenCalled();
    expect(runDiaryThemeRollup).toHaveBeenCalledWith(expect.anything(), { scope });
    expect(r.loops[0]).toMatchObject({ ok: false, processed: 2, errors: 1 });
    expect(r.loops[0].notes).toContain('4 candidate(s), 3 model call(s)');
    expect(r.loops[0].notes).toContain('model_failed=1');
    expect(r.loops[0].notes).toContain('time budget reached');
  });

  it('any other value leaves it off', async () => {
    process.env.CONSOLIDATOR_DIARY_ROLLUP_ENABLED = 'TRUE';
    await runConsolidator({ triggered_by: 'admin', loops: ['loop_10_diary'] });
    expect(runDiaryThemeRollup).not.toHaveBeenCalled();
  });
});

describe('profile synthesis input', () => {
  const base = {
    facts: [{ fact_key: 'k', fact_value: 'v', provenance_source: 'user_stated' }],
    routines: [],
    goal: null,
    index: null,
  };

  it('renders a fresh rollup as data lines', () => {
    const p = buildSynthesisPrompt({
      ...base,
      diary_themes: {
        themes: [{ label: 'Garden project', entries: 4, trend: 'rising' }, { label: 'Sleep', entries: 1, trend: 'fading' }],
        mood_arc: 'Calmer over the month.',
        people: ['partner'],
        generated_at: '2026-09-22T04:25:00Z',
      },
    });
    expect(p).toContain('DIARY THEMES (last 30 days of the diary, how many entries carry each):');
    expect(p).toContain('- Garden project: 4 entries, rising');
    expect(p).toContain('- Sleep: 1 entry, fading');
    expect(p).toContain('- mood across the entries: Calmer over the month.');
    expect(p).toContain('- people who come up: partner');
  });

  it('leaves the prompt and the inputs hash unchanged without one', () => {
    expect(buildSynthesisPrompt(base)).not.toContain('DIARY THEMES');
    expect(computeInputsHash({ ...base, diary_themes: null })).toBe(computeInputsHash(base));
    expect(computeInputsHash({
      ...base,
      diary_themes: { themes: [{ label: 'x', entries: 1, trend: 'steady' }], mood_arc: null, people: [], generated_at: '2026-09-22T04:25:00Z' },
    })).not.toBe(computeInputsHash(base));
  });
});

describe('AP-0915 scheduling', () => {
  const root = path.resolve(__dirname, '..');
  it('is registered with a handler and listed in learning health', () => {
    const registry = fs.readFileSync(path.join(root, 'src/services/automation-registry.ts'), 'utf8');
    expect(registry).toMatch(/id: 'AP-0915', name: 'Diary Theme Rollup'[\s\S]*?handler: 'runDiaryThemeRollup'/);
    const handlers = fs.readFileSync(path.join(root, 'src/services/automation-handlers/memory-intelligence.ts'), 'utf8');
    expect(handlers).toContain("registerHandler('runDiaryThemeRollup', runDiaryThemeRollupHandler)");
    expect(handlers).toMatch(/runDiaryThemeRollupHandler[\s\S]*?isDiaryRollupEnabled\(\)/);
    expect(LEARNING_AUTOMATIONS).toContain('AP-0915');
  });

  it('has an EventBridge job in the memory group, same cron as the registry', () => {
    const script = fs.readFileSync(path.join(root, '../../scripts/aws/setup-eventbridge-cron-migration.sh'), 'utf8');
    expect(script).toContain('"autopilot-memory-diary-theme-rollup|25 4 * * *|UTC|/api/v1/automations/cron/AP-0915|');
  });

  it('is not pinned on any deploy workflow (off by default)', () => {
    const wf = path.resolve(root, '../../.github/workflows');
    for (const f of fs.readdirSync(wf)) {
      expect(fs.readFileSync(path.join(wf, f), 'utf8')).not.toContain('CONSOLIDATOR_DIARY_ROLLUP_ENABLED');
    }
  });
});
