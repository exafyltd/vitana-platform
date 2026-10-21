/**
 * VTID-04340 — the "who is this person" narrative (AP-0911) is only injected
 * while it is fresh, and is labelled with its real age instead of "nightly".
 * The AP-0911 cron stopped in July, so without this guard every voice session
 * was handed a months-old profile presented as current.
 */
jest.mock('../../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));

import {
  readUserProfileNarrative,
  resolveNarrativeMaxAgeDays,
  describeNarrativeAge,
  DEFAULT_NARRATIVE_MAX_AGE_DAYS,
} from '../../src/services/user-model-synthesis';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-23T12:00:00.000Z');

function clientWith(value: unknown, error: unknown = null): any {
  return {
    from: () => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'is', 'order', 'limit']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: value === undefined ? null : { value }, error });
      return chain;
    },
  };
}

describe('readUserProfileNarrative freshness (VTID-04340)', () => {
  it('returns a fresh narrative with its age', async () => {
    const generated_at = new Date(NOW - 5 * 3_600_000).toISOString();
    const r = await readUserProfileNarrative(clientWith({ narrative: 'Fresh profile.', generated_at }), 't', 'u', {
      nowMs: NOW,
    });
    expect(r).toEqual({ narrative: 'Fresh profile.', generated_at, age_ms: 5 * 3_600_000 });
  });

  it('drops a narrative older than the default max age (the July rows)', async () => {
    const r = await readUserProfileNarrative(
      clientWith({ narrative: 'July profile.', generated_at: '2026-07-06T23:14:14.298Z' }),
      't',
      'u',
      { nowMs: NOW },
    );
    expect(r).toBeNull();
  });

  it('keeps a narrative exactly at the max age and drops one just past it', async () => {
    const at = new Date(NOW - DEFAULT_NARRATIVE_MAX_AGE_DAYS * DAY).toISOString();
    const past = new Date(NOW - DEFAULT_NARRATIVE_MAX_AGE_DAYS * DAY - 1).toISOString();
    expect(
      await readUserProfileNarrative(clientWith({ narrative: 'x', generated_at: at }), 't', 'u', { nowMs: NOW }),
    ).not.toBeNull();
    expect(
      await readUserProfileNarrative(clientWith({ narrative: 'x', generated_at: past }), 't', 'u', { nowMs: NOW }),
    ).toBeNull();
  });

  it('honours an explicit maxAgeDays', async () => {
    const generated_at = new Date(NOW - 2 * DAY).toISOString();
    const client = clientWith({ narrative: 'x', generated_at });
    expect(await readUserProfileNarrative(client, 't', 'u', { nowMs: NOW, maxAgeDays: 1 })).toBeNull();
    expect(await readUserProfileNarrative(client, 't', 'u', { nowMs: NOW, maxAgeDays: 3 })).not.toBeNull();
  });

  it.each([
    ['missing generated_at', { narrative: 'x' }],
    ['unparseable generated_at', { narrative: 'x', generated_at: 'not-a-date' }],
    ['non-string generated_at', { narrative: 'x', generated_at: 12345 }],
    ['empty narrative', { narrative: '   ', generated_at: new Date(NOW).toISOString() }],
  ])('returns null for %s', async (_label, value) => {
    expect(await readUserProfileNarrative(clientWith(value), 't', 'u', { nowMs: NOW })).toBeNull();
  });

  it('returns null when there is no row or the read errors', async () => {
    expect(await readUserProfileNarrative(clientWith(undefined), 't', 'u', { nowMs: NOW })).toBeNull();
    expect(
      await readUserProfileNarrative(clientWith({ narrative: 'x', generated_at: new Date(NOW).toISOString() }, { message: 'boom' }), 't', 'u', { nowMs: NOW }),
    ).toBeNull();
  });
});

describe('resolveNarrativeMaxAgeDays', () => {
  it('defaults to 7 and accepts a positive override', () => {
    expect(resolveNarrativeMaxAgeDays(undefined)).toBe(7);
    expect(resolveNarrativeMaxAgeDays('3')).toBe(3);
  });
  it.each(['0', '-2', 'abc', ''])('falls back to the default for %p', (raw) => {
    expect(resolveNarrativeMaxAgeDays(raw)).toBe(DEFAULT_NARRATIVE_MAX_AGE_DAYS);
  });
});

describe('describeNarrativeAge', () => {
  it.each([
    [10 * 60_000, 'less than an hour'],
    [3_600_000, '1 hour'],
    [5 * 3_600_000, '5 hours'],
    [47 * 3_600_000, '47 hours'],
    [3 * DAY, '3 days'],
  ])('%p ms -> %p', (ms, label) => {
    expect(describeNarrativeAge(ms)).toBe(label);
  });
});

describe('profiler section label (source contract)', () => {
  it('no longer claims "nightly" and labels the real age', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/services/user-context-profiler.ts'),
      'utf8',
    );
    expect(src).not.toContain('[PROFILE SYNTHESIS — nightly');
    expect(src).toContain('[PROFILE SYNTHESIS — generated ${narrative.age_label} ago');
  });
});
