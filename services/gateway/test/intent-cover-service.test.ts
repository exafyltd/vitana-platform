/**
 * BOOTSTRAP-INTENT-COVER-GEN — unit tests for intent-cover-service.
 *
 * Mocks both Supabase and the OpenAI SDK so the suite exercises:
 *   - cache hit (existing cover_url short-circuits)
 *   - rate-limit (>= configured cap returns 'rate_limited')
 *   - ownership check
 *   - AI happy path (provider OK → upload OK → persist OK)
 *   - AI failure → curated-fallback path (still resolves)
 *   - DRY_RUN env flag goes straight to fallback without touching OpenAI
 */

const supabaseMock = {
  from: jest.fn(),
  storage: { from: jest.fn() },
};
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => supabaseMock),
}));

const openaiGenerate = jest.fn();
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      images: { generate: openaiGenerate },
    })),
  };
});

// Stub fs.readFile so the fallback path doesn't need real files on disk.
jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  return {
    ...real,
    promises: {
      ...real.promises,
      readFile: jest.fn(async () => Buffer.from('fallback-bytes')),
    },
  };
});

// Helper: chainable supabase.from(...) builder.
type Stub = Record<string, jest.Mock>;
function chain(returns: { data?: unknown; error?: unknown; count?: number } = {}): Stub {
  const stub: Stub = {
    select: jest.fn(() => stub),
    insert: jest.fn(() => stub),
    update: jest.fn(() => stub),
    eq: jest.fn(() => stub),
    in: jest.fn(() => stub),
    gte: jest.fn(() => stub),
    maybeSingle: jest.fn(async () => returns),
    single: jest.fn(async () => returns),
    then: undefined as unknown as jest.Mock,
  };
  // Supabase counts use { count, head } in select(); the test relies on the
  // `count` property when rate-limit checks read it.
  if (returns.count !== undefined) {
    (stub as unknown as { count: number }).count = returns.count;
    (stub.select as jest.Mock).mockImplementation(() => ({
      eq: jest.fn(() => ({
        gte: jest.fn(async () => ({ count: returns.count, error: returns.error })),
      })),
    }));
  }
  return stub;
}

function storageStub({
  uploadError = null,
  publicUrl = 'https://files.example/cover.png',
}: { uploadError?: unknown; publicUrl?: string } = {}) {
  return {
    upload: jest.fn(async () => ({ error: uploadError })),
    getPublicUrl: jest.fn(() => ({ data: { publicUrl } })),
  };
}

beforeEach(() => {
  jest.resetModules();
  supabaseMock.from.mockReset();
  supabaseMock.storage.from.mockReset();
  openaiGenerate.mockReset();
  process.env.SUPABASE_URL = 'http://supabase.local';
  process.env.SUPABASE_SERVICE_ROLE = 'service-role';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.INTENT_COVER_DRY_RUN = '';
  process.env.INTENT_COVER_RATE_LIMIT_PER_DAY = '10';
});

describe('generateCoverForIntent', () => {
  it('returns cached cover_url when one is already set and force is not requested', async () => {
    supabaseMock.from
      .mockReturnValueOnce(
        chain({ data: { intent_id: 'i1', requester_user_id: 'u1', cover_url: 'https://x/y.png' } }),
      );
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' });
    expect(out).toEqual({ cover_url: 'https://x/y.png', source: 'ai_generated', cached: true });
    expect(openaiGenerate).not.toHaveBeenCalled();
  });

  it('rejects when caller is not the intent owner', async () => {
    supabaseMock.from.mockReturnValueOnce(
      chain({ data: { intent_id: 'i1', requester_user_id: 'someone-else', cover_url: null } }),
    );
    const { generateCoverForIntent, CoverGenError } = await import(
      '../src/services/intent-cover-service'
    );
    await expect(
      generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' }),
    ).rejects.toBeInstanceOf(CoverGenError);
  });

  it('rate-limits when >= configured generations in last 24h', async () => {
    supabaseMock.from
      // intent fetch
      .mockReturnValueOnce(chain({ data: { intent_id: 'i1', requester_user_id: 'u1', cover_url: null } }))
      // rate-limit count
      .mockReturnValueOnce(chain({ count: 10 }));
    const { generateCoverForIntent, CoverGenError } = await import(
      '../src/services/intent-cover-service'
    );
    await expect(
      generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'fitness' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(CoverGenError).toBeDefined();
  });

  it('falls back to curated library when DRY_RUN is set', async () => {
    process.env.INTENT_COVER_DRY_RUN = 'true';
    supabaseMock.from
      .mockReturnValueOnce(chain({ data: { intent_id: 'i1', requester_user_id: 'u1', cover_url: null } }))
      .mockReturnValueOnce(chain({ count: 0 }))
      // persistCover update
      .mockReturnValueOnce(chain({ data: null, error: null }));
    supabaseMock.storage.from.mockReturnValue(
      storageStub({ publicUrl: 'https://files.example/fallback.jpg' }),
    );
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'fitness' });
    expect(out.source).toBe('fallback_curated');
    expect(out.cached).toBe(false);
    expect(openaiGenerate).not.toHaveBeenCalled();
  });

  it('AI happy path: provider returns image, uploads to storage, persists URL', async () => {
    supabaseMock.from
      .mockReturnValueOnce(chain({ data: { intent_id: 'i1', requester_user_id: 'u1', cover_url: null } }))
      .mockReturnValueOnce(chain({ count: 0 }))
      .mockReturnValueOnce(chain({ data: null, error: null }));
    supabaseMock.storage.from.mockReturnValue(
      storageStub({ publicUrl: 'https://files.example/ai.png' }),
    );
    openaiGenerate.mockResolvedValueOnce({ data: [{ b64_json: Buffer.from('img').toString('base64') }] });
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' });
    expect(out).toEqual({ cover_url: 'https://files.example/ai.png', source: 'ai_generated', cached: false });
    expect(openaiGenerate).toHaveBeenCalledTimes(1);
  });

  it('AI failure → curated fallback (still resolves with success)', async () => {
    supabaseMock.from
      .mockReturnValueOnce(chain({ data: { intent_id: 'i1', requester_user_id: 'u1', cover_url: null } }))
      .mockReturnValueOnce(chain({ count: 0 }))
      .mockReturnValueOnce(chain({ data: null, error: null }));
    supabaseMock.storage.from.mockReturnValue(
      storageStub({ publicUrl: 'https://files.example/fb.jpg' }),
    );
    openaiGenerate.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 'content_policy_violation' }),
    );
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' });
    expect(out.source).toBe('fallback_curated');
  });
});

describe('themeFromCategory', () => {
  it('maps dance.* / fitness.* / other categories', async () => {
    const { themeFromCategory } = await import('../src/services/intent-cover-service');
    expect(themeFromCategory('dance.salsa')).toBe('dance');
    expect(themeFromCategory('fitness.gym')).toBe('fitness');
    expect(themeFromCategory('commercial.buy')).toBe('generic');
    expect(themeFromCategory(null)).toBe('generic');
  });
});
