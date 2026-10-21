/**
 * VTID-01962: Recurrence Sentinel Tests
 *
 * Verifies the class-level state machine (active|quarantined|probation|released),
 * threshold evaluation, and the dispatch gate the adapter consults.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  appendVerdict,
  evaluateAndQuarantine,
  releaseQuarantine,
  getQuarantineState,
  isDispatchAllowed,
} from '../src/services/voice-recurrence-sentinel';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResp(body: unknown, status = 200, contentRange?: string): Response {
  const headers = new Map<string, string>();
  if (contentRange) headers.set('content-range', contentRange);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) || null },
  } as unknown as Response;
}

beforeEach(() => mockFetch.mockReset());

describe('VTID-01962: Recurrence Sentinel — appendVerdict', () => {
  test('writes a row to voice_healing_history', async () => {
    let captured: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('voice_healing_history')) {
        captured = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({}));
      }
      throw new Error('unexpected: ' + url);
    });
    await appendVerdict({
      class: 'voice.config_missing',
      normalized_signature: 'vertex_project_id_empty',
      verdict: 'ok',
      vtid: 'VTID-99001',
    });
    expect(captured).toMatchObject({
      class: 'voice.config_missing',
      normalized_signature: 'vertex_project_id_empty',
      verdict: 'ok',
      vtid: 'VTID-99001',
    });
  });
});

describe('VTID-01962: Recurrence Sentinel — evaluateAndQuarantine', () => {
  test('burst threshold: 5+ ok in 24h → quarantine with reason burst_threshold', async () => {
    let upsertedRow: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('voice_healing_quarantine?class')) {
        // Initial state read — no row → active
        return Promise.resolve(jsonResp([]));
      }
      if (url.includes('voice_healing_history') && url.includes('count=exact')) {
        // not used; we use Prefer header — returned by content-range
      }
      if (url.includes('voice_healing_history')) {
        if (url.includes('verdict=eq.ok')) {
          return Promise.resolve(jsonResp([], 200, '0-4/5'));
        }
        if (url.includes('verdict=eq.rollback')) {
          return Promise.resolve(jsonResp([], 200, '*/0'));
        }
        // persistence + dispatchToday
        return Promise.resolve(jsonResp([], 200, '*/0'));
      }
      if (url.includes('voice_healing_quarantine?on_conflict')) {
        upsertedRow = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({}));
      }
      if (url.includes('oasis_events')) {
        return Promise.resolve(jsonResp({ id: 'e' }));
      }
      throw new Error('unexpected: ' + url);
    });
    const reason = await evaluateAndQuarantine('voice.config_missing', 'sigA');
    expect(reason).toBe('burst_threshold');
    expect(upsertedRow.status).toBe('quarantined');
    expect(upsertedRow.reason).toBe('burst_threshold');
  });

  test('failed-fix threshold: 4+ rollbacks in 7d → quarantine with reason failed_fix_threshold', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(jsonResp([]));
      }
      if (url.includes('voice_healing_history')) {
        if (url.includes('verdict=eq.ok')) {
          return Promise.resolve(jsonResp([], 200, '*/0'));
        }
        if (url.includes('verdict=eq.rollback')) {
          return Promise.resolve(jsonResp([], 200, '0-3/4'));
        }
        return Promise.resolve(jsonResp([], 200, '*/0'));
      }
      if (url.includes('voice_healing_quarantine?on_conflict')) {
        return Promise.resolve(jsonResp({}));
      }
      if (url.includes('oasis_events')) {
        return Promise.resolve(jsonResp({}));
      }
      throw new Error('unexpected: ' + url);
    });
    const reason = await evaluateAndQuarantine('voice.upstream_disconnect', 'sigB');
    expect(reason).toBe('failed_fix_threshold');
  });

  test('counts under threshold → null (no quarantine)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(jsonResp([]));
      }
      if (url.includes('voice_healing_history')) {
        return Promise.resolve(jsonResp([], 200, '*/2'));
      }
      throw new Error('unexpected: ' + url);
    });
    const reason = await evaluateAndQuarantine('voice.model_stall', 'sigC');
    expect(reason).toBeNull();
  });
});

describe('VTID-01962: Recurrence Sentinel — releaseQuarantine', () => {
  test('quarantined → probation transition with probation_until in future', async () => {
    let upserted: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(
          jsonResp([
            {
              class: 'voice.config_missing',
              normalized_signature: 'sigA',
              status: 'quarantined',
              quarantined_at: new Date().toISOString(),
              reason: 'burst_threshold',
              probation_until: null,
              investigation_id: null,
              updated_at: new Date().toISOString(),
            },
          ]),
        );
      }
      if (url.includes('voice_healing_quarantine?on_conflict')) {
        upserted = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({}));
      }
      throw new Error('unexpected: ' + url);
    });
    const r = await releaseQuarantine('voice.config_missing', 'sigA', 'manual_ops_release');
    expect(r.ok).toBe(true);
    expect(r.new_status).toBe('probation');
    expect(r.probation_until).toBeTruthy();
    expect(upserted.status).toBe('probation');
  });

  test('cannot release from active state → returns error', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(
          jsonResp([
            {
              class: 'voice.config_missing',
              normalized_signature: 'sigA',
              status: 'active',
              quarantined_at: null,
              reason: null,
              probation_until: null,
              investigation_id: null,
              updated_at: new Date().toISOString(),
            },
          ]),
        );
      }
      throw new Error('unexpected: ' + url);
    });
    const r = await releaseQuarantine('voice.config_missing', 'sigA');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cannot_release_from_active');
  });

  test('no quarantine row → error no_quarantine_row', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(jsonResp([]));
      }
      throw new Error('unexpected: ' + url);
    });
    const r = await releaseQuarantine('voice.config_missing', 'sigA');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_quarantine_row');
  });
});

describe('VTID-01962: Recurrence Sentinel — isDispatchAllowed', () => {
  test('no row → allowed (active)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(jsonResp([]));
      }
      throw new Error('unexpected: ' + url);
    });
    const d = await isDispatchAllowed('voice.config_missing', 'sigA');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('active');
  });

  test('quarantined → not allowed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(
          jsonResp([{ status: 'quarantined', probation_until: null, class: 'c', normalized_signature: 's', quarantined_at: new Date().toISOString(), reason: 'burst_threshold', investigation_id: null, updated_at: new Date().toISOString() }]),
        );
      }
      throw new Error('unexpected: ' + url);
    });
    const d = await isDispatchAllowed('c', 's');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('quarantined');
  });

  test('probation with no dispatches today → allowed (probation_allowed)', async () => {
    const futureMs = Date.now() + 10 * 3600_000;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(
          jsonResp([
            {
              status: 'probation',
              probation_until: new Date(futureMs).toISOString(),
              class: 'c',
              normalized_signature: 's',
              quarantined_at: new Date().toISOString(),
              reason: 'burst_threshold',
              investigation_id: null,
              updated_at: new Date().toISOString(),
            },
          ]),
        );
      }
      if (url.includes('voice_healing_history')) {
        // Default 0 across all four parallel queries
        return Promise.resolve(jsonResp([], 200, '*/0'));
      }
      throw new Error('unexpected: ' + url);
    });
    const d = await isDispatchAllowed('c', 's');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('probation_allowed');
  });

  test('probation with 1+ dispatches today → blocked (probation_capped)', async () => {
    const futureMs = Date.now() + 10 * 3600_000;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(
          jsonResp([
            {
              status: 'probation',
              probation_until: new Date(futureMs).toISOString(),
              class: 'c',
              normalized_signature: 's',
              quarantined_at: new Date().toISOString(),
              reason: 'burst_threshold',
              investigation_id: null,
              updated_at: new Date().toISOString(),
            },
          ]),
        );
      }
      if (url.includes('voice_healing_history')) {
        // Burst (ok), persistence, rollback all 0; dispatch today >= 1
        if (url.includes('verdict=eq.ok')) {
          return Promise.resolve(jsonResp([], 200, '*/0'));
        }
        if (url.includes('verdict=eq.rollback')) {
          return Promise.resolve(jsonResp([], 200, '*/0'));
        }
        if (url.includes('recurrence_after_fix_ms')) {
          return Promise.resolve(jsonResp([], 200, '*/0'));
        }
        // dispatchToday
        return Promise.resolve(jsonResp([], 200, '0-1/2'));
      }
      throw new Error('unexpected: ' + url);
    });
    const d = await isDispatchAllowed('c', 's');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('probation_capped');
  });

  test('probation expired → auto-released, allowed', async () => {
    const pastMs = Date.now() - 1000;
    let upserted: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(
          jsonResp([
            {
              status: 'probation',
              probation_until: new Date(pastMs).toISOString(),
              class: 'c',
              normalized_signature: 's',
              quarantined_at: new Date().toISOString(),
              reason: 'burst_threshold',
              investigation_id: null,
              updated_at: new Date().toISOString(),
            },
          ]),
        );
      }
      if (url.includes('voice_healing_quarantine?on_conflict')) {
        upserted = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({}));
      }
      throw new Error('unexpected: ' + url);
    });
    const d = await isDispatchAllowed('c', 's');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('released');
    expect(upserted.status).toBe('released');
  });

  test('released → allowed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_quarantine?class')) {
        return Promise.resolve(
          jsonResp([{ status: 'released', probation_until: null, class: 'c', normalized_signature: 's', quarantined_at: null, reason: null, investigation_id: null, updated_at: new Date().toISOString() }]),
        );
      }
      throw new Error('unexpected: ' + url);
    });
    const d = await isDispatchAllowed('c', 's');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('released');
  });
});

describe('VTID-01962: Recurrence Sentinel — getQuarantineState', () => {
  test('returns row when present', async () => {
    mockFetch.mockResolvedValue(
      jsonResp([
        {
          class: 'c',
          normalized_signature: 's',
          status: 'quarantined',
          quarantined_at: new Date().toISOString(),
          reason: 'burst_threshold',
          probation_until: null,
          investigation_id: null,
          updated_at: new Date().toISOString(),
        },
      ]),
    );
    const r = await getQuarantineState('c', 's');
    expect(r?.status).toBe('quarantined');
  });

  test('returns null when no row', async () => {
    mockFetch.mockResolvedValue(jsonResp([]));
    const r = await getQuarantineState('c', 's');
    expect(r).toBeNull();
  });
});
