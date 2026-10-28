/**
 * VTID-04311 — placeholder specs are redrafted by the triage stage and never
 * dispatched to Dev Autopilot.
 */
import {
  isPlaceholderSpec,
  draftPlaceholderSpecsTick,
  resetSpecDraftThrottle,
  MAX_DRAFT_ATTEMPTS,
} from '../src/services/feedback-spec-drafter';

const S = { url: 'https://sb.test', key: 'svc' };
const SQL_PLACEHOLDER = '# Devon auto-draft spec (placeholder)\n\nUser report: …';
const LLM_FALLBACK = '**Devon draft (LLM unavailable, placeholder)**\n\n_Router returned no text_';

describe('isPlaceholderSpec', () => {
  it('flags empty, SQL auto-triage and LLM-fallback placeholders', () => {
    expect(isPlaceholderSpec(null)).toBe(true);
    expect(isPlaceholderSpec('   ')).toBe(true);
    expect(isPlaceholderSpec(SQL_PLACEHOLDER)).toBe(true);
    expect(isPlaceholderSpec(LLM_FALLBACK)).toBe(true);
  });
  it('accepts a real spec, even one that mentions the word lower down', () => {
    expect(isPlaceholderSpec('## Problem\nLogin redirect loops\n\n## Fix\n…')).toBe(false);
    expect(isPlaceholderSpec('## Problem\na\n\nb\n\nc\n\nnote: remove the (placeholder) text in the UI')).toBe(false);
  });
});

describe('draftPlaceholderSpecsTick', () => {
  let calls: Array<{ url: string; method: string; body: any }>;
  let rows: any[];
  beforeEach(() => {
    resetSpecDraftThrottle();
    calls = [];
    rows = [{ id: 't1', ticket_number: 'FB-1', kind: 'bug', status: 'spec_ready', spec_md: SQL_PLACEHOLDER,
      raw_transcript: 'broken', intake_messages: null, structured_fields: null, classifier_meta: {}, screen_path: '/x',
      app_version: '1', vitana_id: 'V1', priority: 'p2', supervisor_notes: null }];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const payload = method === 'GET' ? rows : [{ id: 't1' }];
      return { ok: true, status: 200, json: async () => payload } as any;
    });
  });

  it('replaces a placeholder spec with a real LLM draft, guarded on spec_ready', async () => {
    const draft = jest.fn().mockResolvedValue({ markdown: '## Problem\nreal spec\n', provider: 'llm' });
    const r = await draftPlaceholderSpecsTick(S, { draft, force: true });
    expect(r).toEqual({ drafted: 1, failed: 0, skipped: 0, dispatched: 0, dispatch_failed: 0 });
    const write = calls.filter((c) => c.method === 'PATCH').pop()!;
    expect(write.url).toContain('status=eq.spec_ready');
    expect(write.body.spec_md).toBe('## Problem\nreal spec\n');
    expect(write.body.classifier_meta).toMatchObject({ spec_drafted_by: 'devon-llm', spec_draft_attempts: 1, spec_draft_claimed_at: null });
    expect(calls[0].url).toContain('kind=in.(bug,ux_issue)');
  });

  it('keeps the placeholder when the model falls back, and counts the attempt', async () => {
    const draft = jest.fn().mockResolvedValue({ markdown: LLM_FALLBACK, provider: 'fallback' });
    const r = await draftPlaceholderSpecsTick(S, { draft, force: true });
    expect(r.failed).toBe(1);
    expect(calls.some((c) => c.body && 'spec_md' in c.body)).toBe(false);
  });

  it('stops after MAX_DRAFT_ATTEMPTS and skips a freshly claimed ticket', async () => {
    const draft = jest.fn();
    rows[0].classifier_meta = { spec_draft_attempts: MAX_DRAFT_ATTEMPTS };
    expect((await draftPlaceholderSpecsTick(S, { draft, force: true })).skipped).toBe(1);
    rows[0].classifier_meta = { spec_draft_claimed_at: new Date().toISOString() };
    expect((await draftPlaceholderSpecsTick(S, { draft, force: true })).skipped).toBe(1);
    expect(draft).not.toHaveBeenCalled();
  });

  it('is throttled and can be disabled', async () => {
    const draft = jest.fn().mockResolvedValue({ markdown: '## real', provider: 'llm' });
    await draftPlaceholderSpecsTick(S, { draft, now: () => 1_000_000 });
    await draftPlaceholderSpecsTick(S, { draft, now: () => 1_000_000 + 60_000 });
    expect(draft).toHaveBeenCalledTimes(1);
    resetSpecDraftThrottle();
    await draftPlaceholderSpecsTick(S, { draft, force: true, env: { FEEDBACK_SPEC_DRAFT_ENABLED: 'false' } as any });
    expect(draft).toHaveBeenCalledTimes(1);
  });
});
