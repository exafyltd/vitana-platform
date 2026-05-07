/**
 * Unit tests for intent-cover-service.
 *
 * Mocks Supabase, GoogleAuth, and the global `fetch` so the suite
 * exercises the full resolution chain:
 *   1. cache hit (existing cover_url short-circuits)
 *   2. user_library — exact-category-tagged photo from profile library
 *   3. user_universal — single fallback photo on profile
 *   4. AI generation (gender-aware Vertex Imagen)
 *   5. fallback_curated — server-shipped JPGs when AI fails
 *
 * Plus: ownership check, rate-limit (only on the AI path), DRY_RUN.
 */

const supabaseMock = {
  from: jest.fn(),
  storage: { from: jest.fn() },
};
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => supabaseMock),
}));

jest.mock('google-auth-library', () => {
  const getAccessToken = jest.fn(async () => ({ token: 'fake-access-token' }));
  return {
    __esModule: true,
    GoogleAuth: jest.fn().mockImplementation(() => ({
      getClient: jest.fn(async () => ({ getAccessToken })),
    })),
  };
});

const vertexFetch = jest.fn();
(global as { fetch: typeof fetch }).fetch = vertexFetch as unknown as typeof fetch;

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
    // For library lookup: the chain ends with .eq() returning a thenable
    // result. The test rig resolves the chain via maybeSingle / single
    // for single-row queries; for the library case the service awaits the
    // chain itself, which is implemented via the `then` shim below.
    then: undefined as unknown as jest.Mock,
  };
  // For multi-row queries (library lookup): the service does
  //   await supabase.from(...).select(...).eq(...).eq(...)
  // i.e. awaits the chain directly. Make the chain awaitable.
  if (returns.data !== undefined && Array.isArray(returns.data)) {
    (stub.eq as jest.Mock).mockImplementation(() => {
      const inner: Stub = {
        ...stub,
        eq: jest.fn(async () => returns),
      };
      return inner;
    });
  }
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
  vertexFetch.mockReset();
  process.env.SUPABASE_URL = 'http://supabase.local';
  process.env.SUPABASE_SERVICE_ROLE = 'service-role';
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
  process.env.VERTEX_LOCATION = 'us-central1';
  process.env.INTENT_COVER_DRY_RUN = '';
  process.env.INTENT_COVER_RATE_LIMIT_PER_DAY = '10';
});

// Standard mock-chain order for the AI path (no library, no universal):
//   1. intent fetch
//   2. library lookup        (empty array)
//   3. universal lookup      (null)
//   4. rate-limit count
//   5. gender lookup
//   6. persistCover update

describe('generateCoverForIntent', () => {
  it('returns cached cover_url when one is already set and force is not requested', async () => {
    supabaseMock.from.mockReturnValueOnce(
      chain({
        data: {
          intent_id: 'i1',
          requester_user_id: 'u1',
          cover_url: 'https://x/y.png',
          cover_source: 'user_library',
          category: 'sport.tennis',
        },
      }),
    );
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' });
    expect(out).toEqual({
      cover_url: 'https://x/y.png',
      source: 'user_library',
      cached: true,
    });
    expect(vertexFetch).not.toHaveBeenCalled();
  });

  it('rejects when caller is not the intent owner', async () => {
    supabaseMock.from.mockReturnValueOnce(
      chain({
        data: {
          intent_id: 'i1',
          requester_user_id: 'someone-else',
          cover_url: null,
          cover_source: null,
          category: 'dance.salsa',
        },
      }),
    );
    const { generateCoverForIntent, CoverGenError } = await import(
      '../src/services/intent-cover-service'
    );
    await expect(
      generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' }),
    ).rejects.toBeInstanceOf(CoverGenError);
  });

  it('user_library: returns the user-uploaded category-tagged photo without calling Vertex', async () => {
    supabaseMock.from
      // intent
      .mockReturnValueOnce(
        chain({
          data: {
            intent_id: 'i1',
            requester_user_id: 'u1',
            cover_url: null,
            cover_source: null,
            category: 'sport.tennis',
          },
        }),
      )
      // library lookup — one match
      .mockReturnValueOnce(
        chain({ data: [{ cover_url: 'https://lib.example/tennis.jpg' }] }),
      )
      // persistCover update
      .mockReturnValueOnce(chain({ data: null, error: null }));

    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({
      intentId: 'i1',
      userId: 'u1',
      theme: 'tennis',
      force: true,
    });
    expect(out).toEqual({
      cover_url: 'https://lib.example/tennis.jpg',
      source: 'user_library',
      cached: false,
    });
    expect(vertexFetch).not.toHaveBeenCalled();
  });

  it('user_universal: when no library match, uses the profile universal photo', async () => {
    supabaseMock.from
      .mockReturnValueOnce(
        chain({
          data: {
            intent_id: 'i1',
            requester_user_id: 'u1',
            cover_url: null,
            cover_source: null,
            category: 'food.cooking_class',
          },
        }),
      )
      // library lookup — no match
      .mockReturnValueOnce(chain({ data: [] }))
      // universal lookup — set
      .mockReturnValueOnce(chain({ data: { universal_intent_cover_url: 'https://prof.example/me.jpg' } }))
      // persistCover update
      .mockReturnValueOnce(chain({ data: null, error: null }));

    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({
      intentId: 'i1',
      userId: 'u1',
      theme: 'cooking',
      force: true,
    });
    expect(out).toEqual({
      cover_url: 'https://prof.example/me.jpg',
      source: 'user_universal',
      cached: false,
    });
    expect(vertexFetch).not.toHaveBeenCalled();
  });

  it('rate-limits when >= configured generations in last 24h (only on AI path)', async () => {
    supabaseMock.from
      .mockReturnValueOnce(
        chain({
          data: {
            intent_id: 'i1',
            requester_user_id: 'u1',
            cover_url: null,
            cover_source: null,
            category: 'fitness.gym',
          },
        }),
      )
      // library — empty
      .mockReturnValueOnce(chain({ data: [] }))
      // universal — null
      .mockReturnValueOnce(chain({ data: { universal_intent_cover_url: null } }))
      // rate-limit count — over the cap
      .mockReturnValueOnce(chain({ count: 10 }));
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    await expect(
      generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'fitness' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('falls back to curated library when DRY_RUN is set (no library, no universal)', async () => {
    process.env.INTENT_COVER_DRY_RUN = 'true';
    supabaseMock.from
      .mockReturnValueOnce(
        chain({
          data: {
            intent_id: 'i1',
            requester_user_id: 'u1',
            cover_url: null,
            cover_source: null,
            category: 'fitness.gym',
          },
        }),
      )
      .mockReturnValueOnce(chain({ data: [] })) // library
      .mockReturnValueOnce(chain({ data: { universal_intent_cover_url: null } })) // universal
      .mockReturnValueOnce(chain({ count: 0 })) // rate-limit
      .mockReturnValueOnce(chain({ data: { gender: 'female' } })) // gender
      .mockReturnValueOnce(chain({ data: null, error: null })); // persist
    supabaseMock.storage.from.mockReturnValue(
      storageStub({ publicUrl: 'https://files.example/fallback.jpg' }),
    );
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'fitness' });
    expect(out.source).toBe('fallback_curated');
    expect(out.cached).toBe(false);
    expect(vertexFetch).not.toHaveBeenCalled();
  });

  it('AI happy path: provider returns image, uploads to storage, persists URL', async () => {
    supabaseMock.from
      .mockReturnValueOnce(
        chain({
          data: {
            intent_id: 'i1',
            requester_user_id: 'u1',
            cover_url: null,
            cover_source: null,
            category: 'dance.salsa',
          },
        }),
      )
      .mockReturnValueOnce(chain({ data: [] })) // library
      .mockReturnValueOnce(chain({ data: { universal_intent_cover_url: null } })) // universal
      .mockReturnValueOnce(chain({ count: 0 })) // rate-limit
      .mockReturnValueOnce(chain({ data: { gender: 'male' } })) // gender
      .mockReturnValueOnce(chain({ data: null, error: null })); // persist
    supabaseMock.storage.from.mockReturnValue(
      storageStub({ publicUrl: 'https://files.example/ai.png' }),
    );
    vertexFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        predictions: [{ bytesBase64Encoded: Buffer.from('img').toString('base64') }],
      }),
      text: async () => '',
    } as unknown as Response);
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' });
    expect(out).toEqual({
      cover_url: 'https://files.example/ai.png',
      source: 'ai_generated',
      cached: false,
    });
    expect(vertexFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(vertexFetch.mock.calls[0][1].body) as {
      instances: { prompt: string }[];
    };
    expect(sentBody.instances[0].prompt).toMatch(/one smiling man/i);
    expect(sentBody.instances[0].prompt).toMatch(/dance studio/i);
  });

  it('AI failure → curated fallback (still resolves with success)', async () => {
    supabaseMock.from
      .mockReturnValueOnce(
        chain({
          data: {
            intent_id: 'i1',
            requester_user_id: 'u1',
            cover_url: null,
            cover_source: null,
            category: 'dance.salsa',
          },
        }),
      )
      .mockReturnValueOnce(chain({ data: [] }))
      .mockReturnValueOnce(chain({ data: { universal_intent_cover_url: null } }))
      .mockReturnValueOnce(chain({ count: 0 }))
      .mockReturnValueOnce(chain({ data: { gender: null } }))
      .mockReturnValueOnce(chain({ data: null, error: null }));
    supabaseMock.storage.from.mockReturnValue(
      storageStub({ publicUrl: 'https://files.example/fb.jpg' }),
    );
    vertexFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'RAI safety filter blocked this prompt',
    } as unknown as Response);
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    const out = await generateCoverForIntent({ intentId: 'i1', userId: 'u1', theme: 'dance' });
    expect(out.source).toBe('fallback_curated');
  });

  it('skips the profile gender lookup when caller passes gender explicitly', async () => {
    supabaseMock.from
      .mockReturnValueOnce(
        chain({
          data: {
            intent_id: 'i1',
            requester_user_id: 'u1',
            cover_url: null,
            cover_source: null,
            category: 'sport.tennis',
          },
        }),
      )
      .mockReturnValueOnce(chain({ data: [] })) // library
      .mockReturnValueOnce(chain({ data: { universal_intent_cover_url: null } })) // universal
      .mockReturnValueOnce(chain({ count: 0 })) // rate-limit
      // No gender lookup mocked — caller passed gender, the service must
      // not hit profiles for gender.
      .mockReturnValueOnce(chain({ data: null, error: null })); // persist
    supabaseMock.storage.from.mockReturnValue(
      storageStub({ publicUrl: 'https://files.example/ai.png' }),
    );
    vertexFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        predictions: [{ bytesBase64Encoded: Buffer.from('img').toString('base64') }],
      }),
      text: async () => '',
    } as unknown as Response);
    const { generateCoverForIntent } = await import('../src/services/intent-cover-service');
    await generateCoverForIntent({
      intentId: 'i1',
      userId: 'u1',
      theme: 'tennis',
      gender: 'female',
    });
    const sentBody = JSON.parse(vertexFetch.mock.calls[0][1].body) as {
      instances: { prompt: string }[];
    };
    expect(sentBody.instances[0].prompt).toMatch(/one smiling woman/i);
    expect(sentBody.instances[0].prompt).toMatch(/tennis/i);
    // 5 chains: intent, library, universal, rate-limit, persist.
    expect(supabaseMock.from).toHaveBeenCalledTimes(5);
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

  it('maps the expanded activity categories', async () => {
    const { themeFromCategory } = await import('../src/services/intent-cover-service');
    expect(themeFromCategory('sport.tennis')).toBe('tennis');
    expect(themeFromCategory('sport.soccer')).toBe('soccer');
    expect(themeFromCategory('sport.football')).toBe('soccer');
    expect(themeFromCategory('sport.basketball')).toBe('basketball');
    expect(themeFromCategory('sport.cycling')).toBe('biking');
    expect(themeFromCategory('sport.hiking')).toBe('walking');
    expect(themeFromCategory('sport.running')).toBe('walking');
    expect(themeFromCategory('sport.gym')).toBe('fitness');
    expect(themeFromCategory('sport.yoga')).toBe('fitness');
    expect(themeFromCategory('food.cooking_class')).toBe('cooking');
    expect(themeFromCategory('learning.book_club')).toBe('panel');
  });
});

describe('buildCoverPrompt', () => {
  it('produces a realism-anchored prompt and matches the gender of the requester', async () => {
    const { buildCoverPrompt } = await import('../src/services/intent-cover-service');

    const male = buildCoverPrompt('tennis', 'male');
    expect(male).toMatch(/photorealistic/i);
    expect(male).toMatch(/not a cartoon/i);
    expect(male).toMatch(/one smiling man/i);
    expect(male).toMatch(/tennis/i);
    expect(male).toMatch(/mixed group of men and women/i);

    const female = buildCoverPrompt('cooking', 'female');
    expect(female).toMatch(/one smiling woman/i);
    expect(female).toMatch(/kitchen/i);

    const neutral = buildCoverPrompt('panel', null);
    expect(neutral).toMatch(/either a man or a woman/i);
  });

  it('covers every theme without throwing', async () => {
    const { buildCoverPrompt } = await import('../src/services/intent-cover-service');
    const themes = [
      'dance',
      'fitness',
      'walking',
      'tennis',
      'soccer',
      'basketball',
      'biking',
      'cooking',
      'panel',
      'generic',
    ] as const;
    for (const t of themes) {
      const p = buildCoverPrompt(t, null);
      expect(p.length).toBeGreaterThan(120);
      expect(p).toMatch(/photorealistic/i);
      expect(p).toMatch(/not a cartoon/i);
    }
  });
});
