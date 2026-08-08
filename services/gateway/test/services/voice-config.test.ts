// VTID-02857 — unit tests for the voice configuration helper
// (voice-config.ts). Phase 7 (Voice/ORB tools) of docs/TEST_COVERAGE_PLAN.md.
//
// Scope:
//   1. getVoiceConfig() defaults when Supabase is unavailable / rows missing.
//   2. buildConfig() branch coverage via getVoiceConfig(): active_provider
//      mapping (vertex/livekit/nova_sonic + defensive fallback), unwrap()
//      of legacy `{provider: ...}` JSONB shape, voice/language empty-string
//      -> null normalization, speaking_rate clamp boundaries (0.25 / 4.0)
//      including non-finite fallback to the default.
//   3. The 30s in-process cache: hit/miss at the exact TTL boundary, `force`
//      bypass, and invalidateVoiceConfigCache().
//   4. putVoiceConfig(): unimplemented-provider refusal (no DB read even
//      attempted), diffing against current config (including the
//      empty-string-equals-null edge case for voice/language), speaking
//      rate clamping before diffing, no-op when nothing changed, upsert
//      short-circuit on first error, and updated_by defaulting.

interface Row {
  key: string;
  value: unknown;
}

function createSupabaseMock(rows: Row[] = []) {
  const inMock = jest.fn(() => Promise.resolve({ data: rows, error: null }));
  const selectMock = jest.fn(() => ({ in: inMock }));
  const upsertCalls: Array<{ payload: any; opts: any }> = [];
  const upsertErrorQueue: Array<{ message: string } | null> = [];
  const upsertMock = jest.fn((payload: any, opts: any) => {
    upsertCalls.push({ payload, opts });
    const err = upsertErrorQueue.length > 0 ? upsertErrorQueue.shift()! : null;
    return Promise.resolve({ error: err });
  });
  const fromMock = jest.fn(() => ({ select: selectMock, upsert: upsertMock }));
  return {
    from: fromMock,
    __inMock: inMock,
    __upsertMock: upsertMock,
    __upsertCalls: upsertCalls,
    __queueUpsertError: (e: { message: string } | null) => upsertErrorQueue.push(e),
  };
}

function createErrorSupabaseMock() {
  const inMock = jest.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } }));
  const selectMock = jest.fn(() => ({ in: inMock }));
  const fromMock = jest.fn(() => ({ select: selectMock }));
  return { from: fromMock, __inMock: inMock };
}

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: any[]) => mockGetSupabase(...args),
}));

import {
  getVoiceConfig,
  invalidateVoiceConfigCache,
  putVoiceConfig,
  IMPLEMENTED_TTS_PROVIDERS,
  IMPLEMENTED_STT_PROVIDERS,
} from '../../src/services/voice-config';

const DEFAULTS = {
  active_provider: 'vertex',
  tts: {
    provider: 'google_tts',
    model: 'neural2',
    voice: null,
    language: null,
    speaking_rate: 1.0,
  },
  stt: {
    provider: 'google_stt',
    model: 'default',
  },
};

beforeEach(() => {
  invalidateVoiceConfigCache();
  mockGetSupabase.mockReset();
  jest.useRealTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('IMPLEMENTED provider sets', () => {
  test('only google_tts / google_stt are implemented', () => {
    expect(IMPLEMENTED_TTS_PROVIDERS.has('google_tts')).toBe(true);
    expect(IMPLEMENTED_TTS_PROVIDERS.has('elevenlabs')).toBe(false);
    expect(IMPLEMENTED_STT_PROVIDERS.has('google_stt')).toBe(true);
    expect(IMPLEMENTED_STT_PROVIDERS.has('whisper')).toBe(false);
  });
});

describe('getVoiceConfig() — Supabase unavailable / row errors', () => {
  test('returns DEFAULT_CONFIG when getSupabase() returns null', async () => {
    mockGetSupabase.mockReturnValue(null);
    const cfg = await getVoiceConfig(true);
    expect(cfg).toEqual(DEFAULTS);
  });

  test('returns DEFAULT_CONFIG when the system_config read errors', async () => {
    mockGetSupabase.mockReturnValue(createErrorSupabaseMock());
    const cfg = await getVoiceConfig(true);
    expect(cfg).toEqual(DEFAULTS);
  });

  test('returns DEFAULT_CONFIG when no rows are stored at all', async () => {
    mockGetSupabase.mockReturnValue(createSupabaseMock([]));
    const cfg = await getVoiceConfig(true);
    expect(cfg).toEqual(DEFAULTS);
  });
});

describe('getVoiceConfig() — active_provider (V2V) mapping', () => {
  test('"livekit" row maps to active_provider "livekit"', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'voice.active_provider', value: 'livekit' }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.active_provider).toBe('livekit');
  });

  test('"nova_sonic" row maps to active_provider "nova_sonic"', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'voice.active_provider', value: 'nova_sonic' }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.active_provider).toBe('nova_sonic');
  });

  test('an unrecognized provider value defensively falls back to "vertex"', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'voice.active_provider', value: 'some_future_provider' }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.active_provider).toBe('vertex');
  });

  test('legacy object-shaped row ({"provider": "livekit"}) is unwrapped correctly', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'voice.active_provider', value: { provider: 'livekit' } }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.active_provider).toBe('livekit');
  });
});

describe('getVoiceConfig() — tts.voice / tts.language empty-string normalization', () => {
  test('empty-string voice normalizes to null', async () => {
    mockGetSupabase.mockReturnValue(createSupabaseMock([{ key: 'tts.voice', value: '' }]));
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.voice).toBeNull();
  });

  test('non-empty voice is kept as-is', async () => {
    mockGetSupabase.mockReturnValue(createSupabaseMock([{ key: 'tts.voice', value: 'Aoede' }]));
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.voice).toBe('Aoede');
  });

  test('empty-string language normalizes to null', async () => {
    mockGetSupabase.mockReturnValue(createSupabaseMock([{ key: 'tts.language', value: '' }]));
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.language).toBeNull();
  });

  test('non-string value for provider/model falls back to DEFAULT_CONFIG value', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([
        { key: 'tts.provider', value: 42 },
        { key: 'stt.model', value: { nested: true } },
      ]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.provider).toBe('google_tts');
    expect(cfg.stt.model).toBe('default');
  });
});

describe('getVoiceConfig() — speaking_rate clamp boundaries', () => {
  test('exactly at the lower bound (0.25) is kept unchanged', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'tts.speaking_rate', value: 0.25 }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.speaking_rate).toBe(0.25);
  });

  test('just under the lower bound (0.249) clamps up to 0.25', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'tts.speaking_rate', value: 0.249 }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.speaking_rate).toBe(0.25);
  });

  test('exactly at the upper bound (4.0) is kept unchanged', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'tts.speaking_rate', value: 4.0 }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.speaking_rate).toBe(4.0);
  });

  test('just over the upper bound (4.001) clamps down to 4.0', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'tts.speaking_rate', value: 4.001 }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.speaking_rate).toBe(4.0);
  });

  test('a mid-range value passes through unchanged', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'tts.speaking_rate', value: 1.75 }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.speaking_rate).toBe(1.75);
  });

  test('a numeric string is parsed', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'tts.speaking_rate', value: '1.5' }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.speaking_rate).toBe(1.5);
  });

  test('a non-numeric value falls back to the default (1.0), not 0.25', async () => {
    mockGetSupabase.mockReturnValue(
      createSupabaseMock([{ key: 'tts.speaking_rate', value: 'not-a-number' }]),
    );
    const cfg = await getVoiceConfig(true);
    expect(cfg.tts.speaking_rate).toBe(1.0);
  });
});

describe('getVoiceConfig() — 30s cache behavior', () => {
  test('a second call within the TTL reuses the cache (only one DB read)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    await getVoiceConfig();
    await getVoiceConfig();

    expect(mock.__inMock).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('a call just under the 30s TTL boundary still uses the cache', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    await getVoiceConfig();
    jest.setSystemTime(new Date('2026-01-01T00:00:29.999Z'));
    await getVoiceConfig();

    expect(mock.__inMock).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('a call exactly at the 30s TTL boundary triggers a refetch (boundary is exclusive)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    await getVoiceConfig();
    jest.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
    await getVoiceConfig();

    expect(mock.__inMock).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('force=true always bypasses the cache, even on back-to-back calls', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    await getVoiceConfig(true);
    await getVoiceConfig(true);

    expect(mock.__inMock).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('invalidateVoiceConfigCache() forces the next call to refetch', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    await getVoiceConfig();
    invalidateVoiceConfigCache();
    await getVoiceConfig();

    expect(mock.__inMock).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});

describe('putVoiceConfig() — unimplemented provider refusal', () => {
  test('rejects an unimplemented TTS provider and never touches the DB', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ tts: { provider: 'elevenlabs' } }, 'alice');

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/elevenlabs/);
    expect(res.error).toMatch(/no dispatcher implementation/);
    expect(mock.__inMock).not.toHaveBeenCalled();
    expect(mock.__upsertMock).not.toHaveBeenCalled();
  });

  test('rejects an unimplemented STT provider and never touches the DB', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ stt: { provider: 'whisper' } }, 'alice');

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/whisper/);
    expect(mock.__inMock).not.toHaveBeenCalled();
    expect(mock.__upsertMock).not.toHaveBeenCalled();
  });

  test('accepts the implemented google_tts / google_stt providers', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig(
      { tts: { provider: 'google_tts' }, stt: { provider: 'google_stt' } },
      'alice',
    );

    // Same as current defaults -> no diff, but must not be refused.
    expect(res.ok).toBe(true);
    expect(res.diff).toEqual({});
  });
});

describe('putVoiceConfig() — supabase unavailable', () => {
  test('returns ok:false when getSupabase() is null', async () => {
    mockGetSupabase.mockReturnValue(null);
    const res = await putVoiceConfig({ tts: { model: 'gemini-2.5-flash-tts' } }, 'alice');
    expect(res).toEqual({ ok: false, error: 'supabase client unavailable' });
  });
});

describe('putVoiceConfig() — diffing against current config', () => {
  test('no-op when nothing actually changed', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ tts: { model: 'neural2' } }, 'alice');

    expect(res).toEqual({ ok: true, diff: {} });
    expect(mock.__upsertMock).not.toHaveBeenCalled();
  });

  test('a genuine model change produces a diff entry and one upsert', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ tts: { model: 'gemini-2.5-flash-tts' } }, 'alice');

    expect(res.ok).toBe(true);
    expect(res.diff).toEqual({
      'tts.model': { from: 'neural2', to: 'gemini-2.5-flash-tts' },
    });
    expect(mock.__upsertMock).toHaveBeenCalledTimes(1);
    expect(mock.__upsertCalls[0].payload).toEqual({
      key: 'tts.model',
      value: 'gemini-2.5-flash-tts',
      updated_by: 'alice',
    });
    expect(mock.__upsertCalls[0].opts).toEqual({ onConflict: 'key' });
  });

  test('setting voice to empty string when current is already null produces NO diff', async () => {
    const mock = createSupabaseMock([]); // current tts.voice defaults to null
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ tts: { voice: '' } }, 'alice');

    expect(res.diff).toEqual({});
    expect(mock.__upsertMock).not.toHaveBeenCalled();
  });

  test('setting a real voice value from null produces a diff, stored verbatim', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ tts: { voice: 'Aoede' } }, 'alice');

    expect(res.diff).toEqual({ 'tts.voice': { from: null, to: 'Aoede' } });
    expect(mock.__upsertCalls[0].payload).toEqual({
      key: 'tts.voice',
      value: 'Aoede',
      updated_by: 'alice',
    });
  });

  test('speaking_rate is clamped BEFORE being compared/diffed', async () => {
    const mock = createSupabaseMock([]); // current default speaking_rate = 1.0
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ tts: { speaking_rate: 0.01 } }, 'alice');

    expect(res.diff).toEqual({
      'tts.speaking_rate': { from: 1.0, to: 0.25 },
    });
    expect(mock.__upsertCalls[0].payload.value).toBe(0.25);
  });

  test('speaking_rate equal to current after clamping produces no diff', async () => {
    const mock = createSupabaseMock([]); // current default is 1.0
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ tts: { speaking_rate: 1.0 } }, 'alice');

    expect(res.diff).toEqual({});
    expect(mock.__upsertMock).not.toHaveBeenCalled();
  });

  test('stt.provider and stt.model diffs are tracked independently from tts', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    const res = await putVoiceConfig({ stt: { model: 'enhanced' } }, 'alice');

    expect(res.diff).toEqual({ 'stt.model': { from: 'default', to: 'enhanced' } });
  });

  test('changedBy=null stores updated_by as "voice-config"', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    await putVoiceConfig({ tts: { model: 'gemini-2.5-flash-tts' } }, null);

    expect(mock.__upsertCalls[0].payload.updated_by).toBe('voice-config');
  });
});

describe('putVoiceConfig() — upsert failure handling', () => {
  test('stops at the first failing upsert and reports its error (does not attempt the rest)', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);
    mock.__queueUpsertError({ message: 'db write failed' });

    const res = await putVoiceConfig(
      { tts: { model: 'gemini-2.5-flash-tts', voice: 'Aoede' } },
      'alice',
    );

    expect(res).toEqual({ ok: false, error: 'db write failed' });
    // Two fields changed -> two potential upserts, but only the first should
    // have been attempted before the early return.
    expect(mock.__upsertMock).toHaveBeenCalledTimes(1);
  });
});

describe('putVoiceConfig() — cache invalidation on success', () => {
  test('a successful write invalidates the cache so the next read is fresh', async () => {
    const mock = createSupabaseMock([]);
    mockGetSupabase.mockReturnValue(mock);

    // Warm the cache.
    await getVoiceConfig();
    expect(mock.__inMock).toHaveBeenCalledTimes(1);

    await putVoiceConfig({ tts: { model: 'gemini-2.5-flash-tts' } }, 'alice');

    // getVoiceConfig() itself calls readRows once via the internal
    // getVoiceConfig(true) inside putVoiceConfig — the cache should now be
    // invalidated, so a subsequent *uncached* read hits the DB again.
    await getVoiceConfig();
    expect(mock.__inMock.mock.calls.length).toBeGreaterThan(2);
  });
});
