/**
 * VTID-04877: the recall log line carries the broker flag-check time and the
 * part of the total nothing else explains, so staging confirms (or rejects)
 * that the flag check was the serial delay in front of every memory read.
 */
import { formatGateMs, formatUnaccountedMs, recallOrbMemoryItems } from '../../../src/services/memory/recall';

describe('VTID-04877 log helpers', () => {
  it('formats a known gate time and "-" when the pack has none', () => {
    expect(formatGateMs(3.6)).toBe('4');
    expect(formatGateMs(0)).toBe('0');
    expect(formatGateMs(undefined)).toBe('-');
    expect(formatGateMs(NaN)).toBe('-');
  });

  it('unaccounted = total - gate - slowest stream, never negative', () => {
    expect(formatUnaccountedMs(542, 280, { a: 250, b: 249, c: 263 })).toBe('0');
    expect(formatUnaccountedMs(542, 2, { a: 250, b: 249, c: 263 })).toBe('277');
    expect(formatUnaccountedMs(100, 0, {})).toBe('100');
    expect(formatUnaccountedMs(100, undefined, { a: 50 })).toBe('-');
  });
});

describe('VTID-04877 recall log line', () => {
  const pack = (meta: Record<string, unknown>) => async () => ({
    ok: true, intent: 'recall_history',
    blocks: { SEMANTIC: { kind: 'SEMANTIC', facts: [{ id: 'f', fact_key: 'spouse_name', fact_value: 'Maria', entity: 'self', confidence: 0.9, asserted_at: new Date().toISOString() }] } },
    meta: { degraded: false, streams_hit: ['memory_facts'], latency_ms_per_stream: { memory_facts: 0 }, total_latency_ms: 0, pack_size_bytes: 1, ...meta },
  }) as any;

  async function lineFor(read: any): Promise<string> {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    await recallOrbMemoryItems({ user_id: 'u', tenant_id: 't' }, { read });
    spy.mockRestore();
    return lines.find((l) => l.includes('[VTID-04452] orb recall in'))!;
  }

  it('carries gate_ms and unaccounted_ms, and no member text', async () => {
    const line = await lineFor(pack({ gate_ms: 0 }));
    expect(line).toMatch(/ gate_ms=0 unaccounted_ms=\d+$/);
    expect(line).not.toContain('Maria');
  });

  it('prints "-" for a pack without gate_ms (older or injected readers)', async () => {
    const line = await lineFor(pack({}));
    expect(line).toContain('gate_ms=- unaccounted_ms=-');
  });

  it('the unavailable warn line carries gate_ms too', async () => {
    const warns: string[] = [];
    const spy = jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')); });
    const read = async () => ({ ok: false, intent: 'recall_history', blocks: {}, error: 'memory_broker_disabled',
      meta: { degraded: true, streams_hit: [], latency_ms_per_stream: {}, total_latency_ms: 1, pack_size_bytes: 0, block_count: 0, gate_ms: 1 } }) as any;
    await recallOrbMemoryItems({ user_id: 'u', tenant_id: 't' }, { read });
    spy.mockRestore();
    expect(warns.find((w) => w.includes('orb recall unavailable'))).toContain('memory_broker_disabled gate_ms=1');
  });
});
