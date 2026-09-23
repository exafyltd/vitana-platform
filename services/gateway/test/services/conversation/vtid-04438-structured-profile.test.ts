/**
 * VTID-04438 (Plan v1 WS-4.1) — the broader nightly profile: more inputs, a
 * structured answer, and a bounded block that reaches the brain's core
 * instruction (and so the core snapshot).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../../src/services/llm-router', () => ({
  callViaRouter: jest.fn(async () => ({ ok: true, provider: 'bedrock', model: 'm', text: modelText })),
}));

let modelText = '';

import {
  PROFILE_BLOCK_HEADER,
  PROFILE_BLOCK_MAX_CHARS,
  PROFILE_LIST_MAX,
  computeSuggestionFit,
  isProfileBlockEnabled,
  parseProfileOutput,
  profileFromStoredValue,
  profileSectionsFilled,
  renderProfileBlock,
  type StructuredProfile,
} from '../../../src/services/conversation/user-profile';
import {
  buildSynthesisPrompt,
  computeInputsHash,
  hasEnoughSynthesisInputs,
  readUserProfileBlock,
  readUserProfileNarrative,
  synthesizeUserModel,
  type SynthesisInputs,
} from '../../../src/services/user-model-synthesis';
import { packBootstrapContext } from '../../../src/orb/live/instruction/bootstrap-packer';
import { summarizeNarrativeFreshness } from '../../../src/services/conversation/conversation-metrics';
import { isVerbatimRecitationDirective } from '../../../src/services/conversation/phrasing-rule';

const SRC = join(__dirname, '../../../src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const NOW = Date.UTC(2026, 8, 23, 12);

const JSON_ANSWER = JSON.stringify({
  summary: 'The user is training for a half marathon and has been sleeping poorly before early runs; they value short, concrete plans.',
  preferences: ['Prefers short answers in the morning', 'Likes concrete plans', 'Likes concrete plans'],
  routines: ['Runs at 6:30 on weekdays'],
  open_threads: ['Deciding whether to join the Sunday running group'],
  what_works: ['A plan for the next day in the evening'],
});

const BASE: SynthesisInputs = {
  facts: [
    { fact_key: 'goal', fact_value: 'half marathon', provenance_source: 'user_stated' },
    { fact_key: 'sport', fact_value: 'running', provenance_source: 'user_stated' },
  ],
  routines: [],
  goal: null,
  index: null,
};

describe('parseProfileOutput', () => {
  it('parses the structured answer, bounds and de-duplicates the lists', () => {
    const p = parseProfileOutput('Here it is: ' + JSON_ANSWER)!;
    expect(p.summary).toMatch(/^The user is training/);
    expect(p.preferences).toEqual(['Prefers short answers in the morning', 'Likes concrete plans']);
    expect(p.open_threads).toEqual(['Deciding whether to join the Sunday running group']);
    const many = parseProfileOutput(JSON.stringify({ summary: 'x'.repeat(60), routines: Array.from({ length: 20 }, (_, i) => `r${i} ` + 'y'.repeat(400)) }))!;
    expect(many.routines).toHaveLength(PROFILE_LIST_MAX);
    expect(many.routines.every((r) => r.length <= 160)).toBe(true);
  });

  it('accepts prose (the previous shape) and refuses empty, short or broken output', () => {
    const prose = parseProfileOutput('The user is planning a wedding and has been focusing on evening walks lately.')!;
    expect(prose.summary).toMatch(/wedding/);
    expect(prose.preferences).toEqual([]);
    for (const bad of ['', null, 'too short', '{"summary": "short"}', '{broken json that is long enough to pass length']) {
      expect(parseProfileOutput(bad)).toBeNull();
    }
  });
});

describe('computeSuggestionFit', () => {
  it('is computed from counts, needs 3 settled offers, and names providers in plain words', () => {
    const fit = computeSuggestionFit([
      { provider: 'journey_guide', accepted: 4, declined: 1, ignored: 0 },
      { provider: 'login_briefing', accepted: 0, declined: 3, ignored: 2 },
      { provider: 'reminder_due', accepted: 1, declined: 0, ignored: 1 },
      { provider: 'goal_completion_inquiry', accepted: 2, declined: 2, ignored: 1 },
    ]);
    expect(fit).toEqual([
      { provider: 'journey_guide', label: 'next steps on their journey', accepted: 4, settled: 5, fit: 'takes_up' },
      { provider: 'login_briefing', label: 'a daily briefing', accepted: 0, settled: 5, fit: 'turns_down' },
    ]);
  });
});

describe('renderProfileBlock', () => {
  const profile: StructuredProfile = {
    ...parseProfileOutput(JSON_ANSWER)!,
    suggestion_fit: computeSuggestionFit([{ provider: 'journey_guide', accepted: 4, declined: 1, ignored: 0 }]),
  };

  it('renders a data block with a packer header, the summary and labelled lists', () => {
    const b = renderProfileBlock(profile, '5 hours');
    expect(b.startsWith(PROFILE_BLOCK_HEADER)).toBe(true);
    expect(b).toMatch(/generated 5 hours ago/);
    expect(b).toMatch(/Open threads:\n- Deciding whether/);
    expect(b).toMatch(/Suggestions they usually take up:\n- next steps on their journey \(4 of 5 taken up\)/);
    expect(b.endsWith('=== END USER PROFILE ===')).toBe(true);
  });

  it('is background, not a script: no recitation directive and no imperative pile', () => {
    const b = renderProfileBlock(profile, '5 hours');
    expect(isVerbatimRecitationDirective(b)).toBe(false);
    expect(b).not.toMatch(/\b(NEVER|MUST|Do NOT)\b/);
  });

  it('stays within its bound, dropping list items before the frame', () => {
    const huge: StructuredProfile = {
      summary: 's'.repeat(900),
      preferences: Array.from({ length: 6 }, () => 'p'.repeat(160)),
      routines: Array.from({ length: 6 }, () => 'r'.repeat(160)),
      open_threads: Array.from({ length: 6 }, () => 'o'.repeat(160)),
      what_works: Array.from({ length: 6 }, () => 'w'.repeat(160)),
      suggestion_fit: [],
    };
    const b = renderProfileBlock(huge, '1 hour');
    expect(b.length).toBeLessThanOrEqual(PROFILE_BLOCK_MAX_CHARS);
    expect(b.startsWith(PROFILE_BLOCK_HEADER)).toBe(true);
    expect(b.endsWith('=== END USER PROFILE ===')).toBe(true);
    expect(b).toContain('s'.repeat(900));
  });

  it('the packer knows the block: its own section, kept at priority 2', () => {
    const b = renderProfileBlock(profile, '5 hours');
    const r = packBootstrapContext(`=== USER MEMORY CONTEXT ===\n${'m'.repeat(20_000)}\n${b}`, 6_000);
    const sec = r.sections.find((s) => s.key === 'user_profile');
    expect(sec).toMatchObject({ priority: 2, outcome: 'kept' });
  });
});

describe('stored values', () => {
  it('reads both the v1 prose value and the v2 structured value', () => {
    expect(profileFromStoredValue({ narrative: 'Prose narrative that is long enough.' })).toMatchObject({ summary: 'Prose narrative that is long enough.', preferences: [] });
    const v2 = profileFromStoredValue({ narrative: 'x', structured: { ...parseProfileOutput(JSON_ANSWER), suggestion_fit: [{ provider: 'a', label: 'A', accepted: 3, settled: 3, fit: 'takes_up' }, { bad: true }] } })!;
    expect(v2.routines).toEqual(['Runs at 6:30 on weekdays']);
    expect(v2.suggestion_fit).toHaveLength(1);
    expect(profileSectionsFilled(v2)).toBe(6);
    expect(profileFromStoredValue(null)).toBeNull();
    expect(profileFromStoredValue({ narrative: '   ' })).toBeNull();
  });
});

describe('the synthesis', () => {
  it('has enough to say with 3 facts, or with conversations and diary alongside fewer facts', () => {
    expect(hasEnoughSynthesisInputs(BASE)).toBe(false);
    expect(hasEnoughSynthesisInputs({ ...BASE, facts: [...BASE.facts, BASE.facts[0]] })).toBe(true);
    expect(hasEnoughSynthesisInputs({ ...BASE, summaries: [{ summary: 's', themes: [], ended_at: null }, { summary: 't', themes: [], ended_at: null }], diary: [{ text: 'd', created_at: null }] })).toBe(true);
  });

  it('the prompt carries conversations, diary and the computed suggestion history', () => {
    const p = buildSynthesisPrompt({
      ...BASE,
      summaries: [{ summary: 'Talked about the race plan.', themes: ['running'], ended_at: '2026-09-20T10:00:00Z' }],
      diary: [{ text: 'Slept badly again.', created_at: '2026-09-21T07:00:00Z' }],
      outcomes: [{ provider: 'journey_guide', accepted: 4, declined: 1, ignored: 0 }],
    });
    expect(p).toMatch(/RECENT CONVERSATIONS[\s\S]*2026-09-20: Talked about the race plan\. \[themes: running\]/);
    expect(p).toMatch(/RECENT DIARY ENTRIES[\s\S]*2026-09-21: Slept badly again\./);
    expect(p).toMatch(/SUGGESTION HISTORY[\s\S]*usually takes up next steps on their journey \(4 of 5\)/);
  });

  it('a new conversation, diary entry or outcome changes the inputs hash', () => {
    const h = computeInputsHash(BASE);
    expect(computeInputsHash({ ...BASE, summaries: [{ summary: 's', themes: [], ended_at: '2026-09-20' }] })).not.toBe(h);
    expect(computeInputsHash({ ...BASE, diary: [{ text: 'd', created_at: '2026-09-20' }] })).not.toBe(h);
    expect(computeInputsHash({ ...BASE, outcomes: [{ provider: 'a', accepted: 1, declined: 0, ignored: 0 }] })).not.toBe(h);
  });

  function stub(existing: unknown = null) {
    const upserts: any[] = [];
    const tables: Record<string, unknown[]> = {
      memory_facts: [0, 1, 2, 3].map((i) => ({ fact_key: `k${i}`, fact_value: `v${i}`, provenance_source: 'user_stated' })),
      user_routines: [], life_compass: [], vitana_index_scores: [],
      user_session_summaries: [{ summary: 'Planned the week of training.', themes: ['running'], ended_at: '2026-09-22T18:00:00Z' }],
      diary_entries: [{ text: 'Felt strong on the run.', created_at: '2026-09-22T07:00:00Z' }],
    };
    const client: any = {
      from: (t: string) => {
        const chain: any = {};
        for (const m of ['select', 'eq', 'is', 'order', 'limit', 'gte']) chain[m] = () => chain;
        chain.then = (res: any) => Promise.resolve({ data: tables[t] ?? [], error: null }).then(res);
        chain.maybeSingle = () => Promise.resolve({ data: existing, error: null });
        chain.upsert = (row: any) => { upserts.push(row); return Promise.resolve({ error: null }); };
        return chain;
      },
      rpc: () => Promise.resolve({ data: [{ provider: 'journey_guide', made: 5, accepted: 4, declined: 1, ignored: 0, open: 0 }], error: null }),
    };
    return { client, upserts };
  }

  it('stores the structured profile beside the narrative, with the computed fit and input counts', async () => {
    modelText = JSON_ANSWER;
    const { client, upserts } = stub();
    const r = await synthesizeUserModel(client, 't1', 'u1');
    expect(r).toEqual({ ok: true, written: true });
    const v = upserts[0].value;
    expect(v.narrative).toBe(v.structured.summary);
    expect(v.schema_version).toBe(2);
    expect(v.structured.open_threads).toEqual(['Deciding whether to join the Sunday running group']);
    expect(v.structured.suggestion_fit[0]).toMatchObject({ provider: 'journey_guide', fit: 'takes_up' });
    expect(v.inputs_counts).toEqual({ facts: 4, routines: 0, summaries: 1, diary: 1, outcome_providers: 1 });
    expect(v.sections_filled).toBe(6);
  });

  it('a prose answer still writes a usable narrative', async () => {
    modelText = 'The user is training for a half marathon and has been sleeping poorly before early runs.';
    const { client, upserts } = stub();
    expect(await synthesizeUserModel(client, 't1', 'u1')).toEqual({ ok: true, written: true });
    expect(upserts[0].value.narrative).toBe(modelText);
    expect(upserts[0].value.structured.preferences).toEqual([]);
  });

  it('broken input reads leave those inputs empty rather than failing', async () => {
    modelText = JSON_ANSWER;
    const { client, upserts } = stub();
    const orig = client.from;
    client.from = (t: string) => (t === 'diary_entries' || t === 'user_session_summaries' ? (() => { throw new Error('down'); })() : orig(t));
    client.rpc = () => Promise.reject(new Error('rpc down'));
    expect(await synthesizeUserModel(client, 't1', 'u1')).toEqual({ ok: true, written: true });
    expect(upserts[0].value.inputs_counts).toMatchObject({ summaries: 0, diary: 0, outcome_providers: 0 });
  });
});

describe('the block in the brain', () => {
  const stored = (value: unknown) => ({
    from: () => {
      const chain: any = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: { value }, error: null });
      return chain;
    },
  }) as any;
  const fresh = new Date(NOW - 3 * 3_600_000).toISOString();

  it('renders a fresh structured profile and a fresh prose one', async () => {
    const v2 = { narrative: 'x', generated_at: fresh, structured: { ...parseProfileOutput(JSON_ANSWER), suggestion_fit: [] } };
    const b = await readUserProfileBlock('t', 'u', { supabase: stored(v2), nowMs: NOW });
    expect(b).toMatch(/^=== USER PROFILE \(nightly synthesis\) — generated 3 hours ago/);
    expect(b).toMatch(/Routines:\n- Runs at 6:30 on weekdays/);
    const v1 = await readUserProfileBlock('t', 'u', { supabase: stored({ narrative: 'A prose narrative that is long enough.', generated_at: fresh }), nowMs: NOW });
    expect(v1).toMatch(/A prose narrative that is long enough\./);
  });

  it('is empty when stale, absent, disabled, slow or failing', async () => {
    const old = new Date(NOW - 30 * 86_400_000).toISOString();
    expect(await readUserProfileBlock('t', 'u', { supabase: stored({ narrative: 'old but long enough text', generated_at: old }), nowMs: NOW })).toBe('');
    expect(await readUserProfileBlock('t', 'u', { supabase: stored(null), nowMs: NOW })).toBe('');
    const slow = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => {}) }) }) }) }) }) } as any;
    expect(await readUserProfileBlock('t', 'u', { supabase: slow, nowMs: NOW, timeoutMs: 20 })).toBe('');
    expect(await readUserProfileBlock('t', 'u', { supabase: { from: () => { throw new Error('x'); } } as any })).toBe('');
    expect(await readUserProfileBlock('', 'u', { supabase: stored({}) })).toBe('');
    const prev = process.env.BRAIN_PROFILE_BLOCK;
    process.env.BRAIN_PROFILE_BLOCK = 'false';
    try {
      expect(isProfileBlockEnabled()).toBe(false);
      expect(await readUserProfileBlock('t', 'u', { supabase: stored({ narrative: 'long enough prose narrative', generated_at: fresh }), nowMs: NOW })).toBe('');
    } finally {
      if (prev === undefined) delete process.env.BRAIN_PROFILE_BLOCK; else process.env.BRAIN_PROFILE_BLOCK = prev;
    }
  });

  it('the reader keeps the pre-VTID shape for prose rows and adds `structured` only for v2', async () => {
    const r1 = await readUserProfileNarrative(stored({ narrative: 'Prose.', generated_at: fresh }), 't', 'u', { nowMs: NOW });
    expect(r1).not.toHaveProperty('structured');
    const r2 = await readUserProfileNarrative(stored({ narrative: 'x', generated_at: fresh, structured: { summary: 'A structured summary long enough.' } }), 't', 'u', { nowMs: NOW });
    expect(r2!.structured!.summary).toBe('A structured summary long enough.');
  });

  it('the brain puts the block in the core instruction (community only), so the core snapshot carries it', () => {
    const brain = read('services/vitana-brain.ts');
    expect(brain).toMatch(/isCommunitySurface\s*\? import\('\.\/user-model-synthesis'\)\.then\(\(m\) => m\.readUserProfileBlock\(input\.tenant_id, input\.user_id\)\)/);
    const core = brain.slice(brain.indexOf('const coreInstruction = `'), brain.indexOf('const instruction = `'));
    expect(core).toContain('${userProfileBlock}');
  });

  it('the legacy profiler renders the structured block and keeps the prose line otherwise', () => {
    const src = read('services/user-context-profiler.ts');
    expect(src).toMatch(/narrative\.structured && profileSectionsFilledFn\(narrative\.structured\) > 1\s*\? renderProfileBlockFn\(narrative\.structured, narrative\.age_label\)/);
    expect(src).toContain('[PROFILE SYNTHESIS — generated ${narrative.age_label} ago');
  });
});

describe('Learning health', () => {
  it('summarizes profile quality and which inputs each profile saw', () => {
    const at = new Date(NOW - 3_600_000).toISOString();
    const f = summarizeNarrativeFreshness([
      { generated_at: at, schema_version: '2', sections_filled: '6', summaries: '3', diary: '0', outcome_providers: '2' },
      { generated_at: at, schema_version: '2', sections_filled: '3', summaries: '0', diary: '2', outcome_providers: '0' },
      { generated_at: at },
    ], NOW);
    expect(f).toMatchObject({ users_with_narrative: 3, fresh_7d: 3, structured: 2, avg_sections_filled: 4.5, with_conversations: 1, with_diary: 1, with_outcomes: 1 });
  });

  it('the read selects stamps and counts only — never the text', () => {
    const repo = read('routes/conversation-hub-repository.ts');
    expect(repo).toMatch(/schema_version:value->>schema_version, sections_filled:value->>sections_filled, summaries:value->inputs_counts->>summaries/);
    expect(repo).not.toMatch(/value->>narrative|value->structured/);
  });

  it('the Command Hub shows the new tiles', () => {
    const app = read('frontend/command-hub/app.js');
    expect(app).toMatch(/_convTile\('Structured profiles', String\(n\.structured \|\| 0\)/);
    expect(app).toMatch(/_convTile\('Inputs seen', /);
  });
});
