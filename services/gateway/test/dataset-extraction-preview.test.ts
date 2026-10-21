/**
 * Dataset extraction PREVIEW mode — Phase 1 W2 readiness
 * (BOOTSTRAP-DATASET-READINESS).
 *
 * Verifies the read-only preview path: same projection as the real extractor,
 * counts/groups/samples the projected rows, and writes NOTHING. These are pure
 * functions, so no prod access or network is involved.
 */

import { summarizePreview, tenantKeyFromEvent } from '../scripts/datasets/lib';
import { projectRows as projectVoice } from '../scripts/datasets/voice-tool-routing';
import { projectRows as projectIntent } from '../scripts/datasets/intent-kind';
import { projectRows as projectPillar } from '../scripts/datasets/pillar-classification';
import type { OasisEventRow } from '../scripts/datasets/types';

function ev(partial: Partial<OasisEventRow> & { id: string }): OasisEventRow {
  return {
    created_at: '2026-06-01T00:00:00.000Z',
    topic: 'orb.turn.responded',
    metadata: null,
    message: null,
    ...partial,
  };
}

describe('dataset preview — tenantKeyFromEvent', () => {
  it('reads metadata.tenant_id', () => {
    expect(tenantKeyFromEvent(ev({ id: '1', metadata: { tenant_id: 'tenant-a' } }))).toBe('tenant-a');
  });
  it('reads nested identity.tenant_id', () => {
    expect(
      tenantKeyFromEvent(ev({ id: '1', metadata: { identity: { tenant_id: 'tenant-b' } } })),
    ).toBe('tenant-b');
  });
  it('falls back to "unknown" when absent', () => {
    expect(tenantKeyFromEvent(ev({ id: '1', metadata: { foo: 'bar' } }))).toBe('unknown');
    expect(tenantKeyFromEvent(ev({ id: '1', metadata: null }))).toBe('unknown');
    expect(tenantKeyFromEvent(undefined)).toBe('unknown');
  });
});

describe('dataset preview — voice-tool-routing projection', () => {
  const events: OasisEventRow[] = [
    ev({
      id: 'v1',
      topic: 'orb.turn.responded',
      metadata: { tenant_id: 'tenant-a', transcript: 'play some jazz', tool_name: 'media.play' },
    }),
    ev({
      id: 'v2',
      topic: 'orb.turn.responded',
      metadata: { tenant_id: 'tenant-b', input_text: 'set a timer', tool_call: { name: 'timer.set' } },
    }),
    // dropped — no tool
    ev({ id: 'v3', metadata: { tenant_id: 'tenant-a', transcript: 'hello there' } }),
    // dropped — input too short
    ev({ id: 'v4', metadata: { transcript: 'a', tool_name: 'x.y' } }),
  ];

  it('projects only valid (user_input, tool_chosen) rows', () => {
    const rows = projectVoice(events);
    expect(rows.map((r) => r.source_id)).toEqual(['v1', 'v2']);
    expect(rows[0].payload).toMatchObject({ user_input: 'play some jazz', tool_chosen: 'media.play' });
  });

  it('summarizePreview counts + groups by tenant and source, writes nothing', () => {
    const projected = projectVoice(events);
    const summary = summarizePreview('voice-tool-routing', events, projected);
    expect(summary.preview).toBe(true);
    expect(summary.rows_total).toBe(4); // raw query result count
    expect(summary.rows_projected).toBe(2);
    expect(summary.rows_after_dedup).toBe(2);
    expect(summary.by_tenant).toEqual({ 'tenant-a': 1, 'tenant-b': 1 });
    expect(summary.by_source).toEqual({ 'orb.turn.responded': 2 });
    expect(summary.samples.length).toBe(2);
  });

  it('dedupes by source_id in the projected count', () => {
    const dupes = [events[0], events[0], events[1]];
    const summary = summarizePreview('voice-tool-routing', dupes, projectVoice(dupes));
    expect(summary.rows_projected).toBe(3);
    expect(summary.rows_after_dedup).toBe(2);
  });
});

describe('dataset preview — intent-kind projection', () => {
  it('keeps only valid intent kinds', () => {
    const events: OasisEventRow[] = [
      ev({
        id: 'i1',
        topic: 'autopilot.intent.created',
        metadata: { tenant_id: 't1', intent_kind: 'task', detected_text: 'remind me to call mom' },
      }),
      // dropped — unknown kind
      ev({
        id: 'i2',
        topic: 'autopilot.intent.created',
        metadata: { intent_kind: 'nonsense', detected_text: 'something' },
      }),
    ];
    const summary = summarizePreview('intent-kind', events, projectIntent(events));
    expect(summary.rows_after_dedup).toBe(1);
    expect(summary.by_source).toEqual({ 'autopilot.intent.created': 1 });
  });
});

describe('dataset preview — pillar-classification projection', () => {
  it('requires non-empty pillars and a long-enough text', () => {
    const events: OasisEventRow[] = [
      ev({
        id: 'p1',
        topic: 'memory.write.user_message',
        metadata: { tenant_id: 't9', content: 'I have been sleeping much better lately', vitana_pillars: ['health'] },
      }),
      // dropped — no pillars
      ev({ id: 'p2', topic: 'memory.write.assistant_message', metadata: { content: 'a long enough message here', pillars: [] } }),
    ];
    const summary = summarizePreview('pillar-classification', events, projectPillar(events));
    expect(summary.rows_after_dedup).toBe(1);
    expect(summary.by_tenant).toEqual({ t9: 1 });
    expect(summary.samples[0].payload).toMatchObject({ pillars: ['health'] });
  });
});

describe('dataset preview — empty input (unconsented prod yields 0)', () => {
  it('reports zeros and empty groupings without throwing', () => {
    const summary = summarizePreview('voice-tool-routing', [], []);
    expect(summary).toMatchObject({
      rows_total: 0,
      rows_projected: 0,
      rows_after_dedup: 0,
      by_tenant: {},
      by_source: {},
      samples: [],
    });
  });
});
