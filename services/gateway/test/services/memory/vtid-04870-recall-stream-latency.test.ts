/**
 * VTID-04870: the recall log line names each stream's latency, so a slow
 * stream can be found from logs (recall was 2-3x slower than the legacy
 * read with tiny tables, VTID-04784 shadow).
 */
import { formatStreamMs, recallOrbMemoryItems } from '../../../src/services/memory/recall';

describe('VTID-04870 formatStreamMs', () => {
  it('lists streams sorted with rounded ms', () => {
    expect(formatStreamMs({ memory_items: 640.4, memory_facts: 120, memory_diary_entries: 88.6 }))
      .toBe('memory_diary_entries:89,memory_facts:120,memory_items:640');
  });
  it('is "-" when nothing was timed', () => {
    expect(formatStreamMs({})).toBe('-');
    expect(formatStreamMs(undefined)).toBe('-');
    expect(formatStreamMs({ x: NaN })).toBe('-');
  });
});

describe('VTID-04870 recall log line', () => {
  it('carries stream_ms and no member text', async () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    const read = async () => ({
      ok: true, intent: 'recall_history',
      blocks: { SEMANTIC: { kind: 'SEMANTIC', facts: [{ id: 'f', fact_key: 'spouse_name', fact_value: 'Maria', entity: 'self', confidence: 0.9, asserted_at: new Date().toISOString() }] } },
      meta: { degraded: false, streams_hit: ['memory_facts'], latency_ms_per_stream: { memory_facts: 42 }, total_latency_ms: 42, pack_size_bytes: 1 },
    }) as any;
    await recallOrbMemoryItems({ user_id: 'u', tenant_id: 't' }, { read });
    spy.mockRestore();
    const line = lines.find((l) => l.includes('[VTID-04452] orb recall in'))!;
    expect(line).toContain('stream_ms=memory_facts:42');
    expect(line).not.toContain('Maria');
    expect(line).not.toContain('spouse');
  });
});
