/**
 * VTID-04424 (Plan v1 WS-3.1) — the Nova mid-session probe's scenario set and
 * summary math. The probe itself runs against Bedrock and is not run in CI;
 * these tests keep the scenarios that back the decision note from drifting.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { SCENARIOS, summarize, type RunResult } from '../../../scripts/nova-midsession-probe';

const run = (over: Partial<RunResult>): RunResult => ({
  scenario: 's', run: 1, connected: true, errors: [], content_filter_blocked: false, closed: null,
  responses: [], unsolicited_responses: 0, question_latency_ms: null, hello_latency_ms: null,
  tool_calls: [], tool_to_audio_ms: null, question_answer_text: '', recall: false, transcripts: [], log: [],
  ...over,
});

describe('nova mid-session probe', () => {
  it('covers every option the decision note reports on, with unique ids', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'baseline_fact_in_system_prompt',
      'inject_system_noninteractive',
      'inject_system_interactive',
      'inject_user_noninteractive',
      'inject_user_interactive',
      'inject_assistant_noninteractive',
      'tool_prefetched_instant',
      'tool_fetched_1500ms',
      'get_guidance_tool',
      'get_guidance_tool_health_note',
      'tool_list_change_midsession',
      'prompt_rollover_new_tools',
    ]) expect(ids).toContain(id);
  });

  it('every injection scenario leaves a silent watch window before the question', () => {
    for (const s of SCENARIOS.filter((x) => x.id.startsWith('inject_'))) {
      const i = s.steps.findIndex((st) => st.kind === 'inject');
      expect(i).toBeGreaterThan(-1);
      const next = s.steps[i + 1];
      expect(next.kind).toBe('silence');
      expect((next as { ms: number }).ms).toBeGreaterThanOrEqual(5_000);
      expect(s.steps[i + 2]).toMatchObject({ kind: 'say', label: 'question' });
    }
  });

  it('injected notes and guidance are intents, never lines to recite', () => {
    const texts = SCENARIOS.flatMap((s) => [
      s.system,
      ...s.steps.flatMap((st) => (st.kind === 'inject' ? [st.text] : [])),
      ...Object.values(s.toolResults ?? {}).map((r) => JSON.stringify(r.output)),
    ]);
    expect(texts.length).toBeGreaterThan(SCENARIOS.length);
    for (const t of texts) expect(t).not.toMatch(/say exactly|verbatim|word for word/i);
  });

  it('summarizes errors, unsolicited responses, recall and median latency per scenario', () => {
    const s = summarize([
      run({ scenario: 'a', question_latency_ms: 1000, recall: true }),
      run({ scenario: 'a', run: 2, question_latency_ms: 3000, recall: true, unsolicited_responses: 1 }),
      run({ scenario: 'a', run: 3, question_latency_ms: 2000, errors: [{ t: 1, code: 'nova_validation', diagnostic: 'x' }] }),
      run({ scenario: 'b', content_filter_blocked: true, errors: [{ t: 1, code: 'nova_validation', diagnostic: 'blocked by our content filters' }] }),
    ]);
    expect(s.find((x) => x.scenario === 'a')).toMatchObject({
      runs: 3, errored: 1, unsolicited_responses: 1, answered: 3, recall: 2, question_latency_ms_median: 2000,
    });
    expect(s.find((x) => x.scenario === 'b')).toMatchObject({ runs: 1, content_filter_blocked: 1, answered: 0, question_latency_ms_median: null });
  });

  it('the decision note and its evidence are committed', () => {
    const dir = join(__dirname, '../../../../../docs/validation/VTID-04424');
    expect(existsSync(join(dir, 'decision-note.md'))).toBe(true);
    const evidence = JSON.parse(readFileSync(join(dir, 'outputs/probe-summary.json'), 'utf8'));
    expect(evidence.summary.length).toBe(SCENARIOS.length);
  });
});
