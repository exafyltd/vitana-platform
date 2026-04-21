/**
 * @jest-environment node
 *
 * Test suite for services/gateway/src/routes/media-hub.ts
 * Covers GET /search and POST /shorts/auto-metadata endpoints.
 */

// ---------------------------------------------------------------------------
// jest.mock hoists — must appear before any import statements
// ---------------------------------------------------------------------------

jest.mock('@supabase/supabase-js', () => {
  let uploadsResponse: { data: unknown[] | null; error: unknown } = { data: [], error: null };
  let videosResponse: { data: unknown[] | null; error: unknown } = { data: [], error: null };

  const makeBuilder = (responseRef: { current: { data: unknown[] | null; error: unknown } }) => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;

    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.in = jest.fn(chain);
    builder.or = jest.fn(chain);
    builder.order = jest.fn(chain);
    builder.limit = jest.fn(() => Promise.resolve(responseRef.current));

    return builder;
  };

  const uploadsRef = { current: uploadsResponse };
  const videosRef = { current: videosResponse };

  const uploadsBuilder = makeBuilder(uploadsRef);
  const videosBuilder = makeBuilder(videosRef);

  const mockSupabase = {
    from: jest.fn((table: string) => {
      if (table === 'media_uploads') return uploadsBuilder;
      if (table === 'media_videos') return videosBuilder;
      return uploadsBuilder;
    }),
    __setUploadsResponse: (resp: { data: unknown[] | null; error: unknown }) => {
      uploadsRef.current = resp;
      uploadsResponse = resp;
    },
    __setVideosResponse: (resp: { data: unknown[] | null; error: unknown }) => {
      videosRef.current = resp;
      videosResponse = resp;
    },
    __getUploadsBuilder: () => uploadsBuilder,
    __getVideosBuilder: () => videosBuilder,
    __reset: () => {
      uploadsRef.current = { data: [], error: null };
      videosRef.current = { data: [], error: null };
      Object.values(uploadsBuilder).forEach((fn) => (fn as jest.Mock).mockClear && (fn as jest.Mock).mockClear());
      Object.values(videosBuilder).forEach((fn) => (fn as jest.Mock).mockClear && (fn as jest.Mock).mockClear());
      (mockSupabase.from as jest.Mock).mockClear();
      // Re-wire limit to use the ref
      uploadsBuilder.limit = jest.fn(() => Promise.resolve(uploadsRef.current));
      videosBuilder.limit = jest.fn(() => Promise.resolve(videosRef.current));
      // Re-wire chain for uploads
      const uploadsChain = () => uploadsBuilder;
      uploadsBuilder.select = jest.fn(uploadsChain);
      uploadsBuilder.eq = jest.fn(uploadsChain);
      uploadsBuilder.in = jest.fn(uploadsChain);
      uploadsBuilder.or = jest.fn(uploadsChain);
      uploadsBuilder.order = jest.fn(uploadsChain);
      // Re-wire chain for videos
      const videosChain = () => videosBuilder;
      videosBuilder.select = jest.fn(videosChain);
      videosBuilder.eq = jest.fn(videosChain);
      videosBuilder.in = jest.fn(videosChain);
      videosBuilder.or = jest.fn(videosChain);
      videosBuilder.order = jest.fn(videosChain);
    },
  };

  return {
    createClient: jest.fn(() => mockSupabase),
    __mockSupabase: mockSupabase,
  };
});

jest.mock('../services/anthropic-vision-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = jest.requireActual('../services/anthropic-vision-client') as any;
  return {
    analyzeShortFrames: jest.fn(),
    VisionClientError: actual.VisionClientError,
  };
});

jest.mock('../middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((
    _req: import('express').Request,
    _res: import('express').Response,
    next: import('express').NextFunction,
  ) => next()),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are hoisted)
// ---------------------------------------------------------------------------

import express from 'express';
import request from 'supertest';
import type { Express } from 'express';

// The router under test
import mediaHubRouter from './media-hub';

// Typed handles into the mocked modules
import * as supabaseMod from '@supabase/supabase-js';
import * as visionMod from '../services/anthropic-vision-client';
import * as authMod from '../middleware/auth-supabase-jwt';

// ---------------------------------------------------------------------------
// Typed aliases for mock internals
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabaseMock = supabaseMod as any;
const mockSupabase = supabaseMock.__mockSupabase as {
  from: jest.Mock;
  __setUploadsResponse: (r: { data: unknown[] | null; error: unknown }) => void;
  __setVideosResponse: (r: { data: unknown[] | null; error: unknown }) => void;
  __getUploadsBuilder: () => Record<string, jest.Mock>;
  __getVideosBuilder: () => Record<string, jest.Mock>;
  __reset: () => void;
};

const analyzeShortFrames = visionMod.analyzeShortFrames as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { VisionClientError } = visionMod as any;
const requireAuth = authMod.requireAuth as jest.Mock;

// ---------------------------------------------------------------------------
// Module-scope fixtures
// ---------------------------------------------------------------------------

const VALID_FRAME = {
  position_ratio: 0.5,
  data_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL',
};

const VALID_BODY = {
  filename: 'clip.mp4',
  duration_seconds: 30,
  mime_type: 'video/mp4',
  frames: [VALID_FRAME],
};

const DEFAULT_METADATA_RESULT = {
  title: 'T',
  description: 'D',
  category: 'C',
  tags: ['a'],
  model: 'claude-sonnet-4-6',
  latencyMs: 120,
};

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

let app: Express;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/v1/media-hub', mediaHubRouter);
});

beforeEach(() => {
  jest.clearAllMocks();

  // Restore env vars to valid dummy strings
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';

  // Reset supabase mock state
  mockSupabase.__reset();

  // Reset requireAuth to pass-through
  requireAuth.mockImplementation(
    (
      _req: import('express').Request,
      _res: import('express').Response,
      next: import('express').NextFunction,
    ) => next(),
  );

  // Reset analyzeShortFrames to default success result
  analyzeShortFrames.mockResolvedValue(DEFAULT_METADATA_RESULT);
});

// ---------------------------------------------------------------------------
// GET /api/v1/media-hub/search
// ---------------------------------------------------------------------------

describe('GET /search — input validation', () => {
  it('returns 400 when q is absent', async () => {
    const res = await request(app).get('/api/v1/media-hub/search');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'q is required' });
  });

  it('returns 400 when q is empty string after trim', async () => {
    const res = await request(app).get('/api/v1/media-hub/search?q=   ');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'q is required' });
  });
});

describe('GET /search — env guard', () => {
  it('returns 503 when SUPABASE_URL is unset', async () => {
    delete process.env.SUPABASE_URL;
    const res = await request(app).get('/api/v1/media-hub/search?q=test');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'Service unavailable' });
  });

  it('returns 503 when SUPABASE_SERVICE_ROLE is unset', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE;
    const res = await request(app).get('/api/v1/media-hub/search?q=test');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'Service unavailable' });
  });
});

describe('GET /search — type=music', () => {
  it('returns music hits with artist populated', async () => {
    mockSupabase.__setUploadsResponse({
      data: [
        {
          id: 'u1',
          title: 'Song One',
          media_type: 'music',
          file_url: 'https://cdn/s1.mp3',
          thumbnail_url: null,
          created_at: '2024-01-01T00:00:00Z',
          music_metadata: [{ artist: 'Artist A', album: 'Album A', genre: 'Pop' }],
        },
        {
          id: 'u2',
          title: 'Song Two',
          media_type: 'music',
          file_url: 'https://cdn/s2.mp3',
          thumbnail_url: null,
          created_at: '2024-01-02T00:00:00Z',
          // music_metadata as plain object (not array)
          music_metadata: { artist: 'Artist B', album: 'Album B', genre: 'Jazz' },
        },
      ],
      error: null,
    });

    const res = await request(app).get('/api/v1/media-hub/search?q=song&type=music');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hits).toHaveLength(2);
    res.body.hits.forEach((hit: Record<string, unknown>) => {
      expect(hit.type).toBe('music');
      expect(hit.artist).toBeDefined();
      expect(hit.host).toBeUndefined();
      expect(hit.series).toBeUndefined();
    });

    // Confirm .in was called with music filter
    const uploadsBuilder = mockSupabase.__getUploadsBuilder();
    const inCalls = uploadsBuilder.in.mock.calls;
    const hasMediaTypeFilter = inCalls.some(
      (call: unknown[]) =>
        call[0] === 'media_type' &&
        Array.isArray(call[1]) &&
        (call[1] as string[]).includes('music'),
    );
    expect(hasMediaTypeFilter).toBe(true);
  });
});

describe('GET /search — type=podcast', () => {
  it('returns podcast hits with host and series populated', async () => {
    mockSupabase.__setUploadsResponse({
      data: [
        {
          id: 'p1',
          title: 'Episode One',
          media_type: 'podcast',
          file_url: 'https://cdn/e1.mp3',
          thumbnail_url: 'https://cdn/thumb.jpg',
          created_at: '2024-01-01T00:00:00Z',
          podcast_metadata: [{ host_name: 'Host H', series_name: 'Series S', episode_number: 1 }],
        },
      ],
      error: null,
    });

    const res = await request(app).get('/api/v1/media-hub/search?q=episode&type=podcast');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hits).toHaveLength(1);

    const hit = res.body.hits[0];
    expect(hit.type).toBe('podcast');
    expect(hit.host).toBeDefined();
    expect(hit.series).toBeDefined();
    expect(hit.artist).toBeUndefined();
  });
});

describe('GET /search — type=shorts', () => {
  it('returns shorts hits with file_url mapped from src_url', async () => {
    mockSupabase.__setVideosResponse({
      data: [
        {
          id: 'v1',
          title: 'Short One',
          src_url: 'https://cdn/v1.mp4',
          thumbnail_url: 'https://cdn/v1-thumb.jpg',
          created_at: '2024-01-01T00:00:00Z',
          tags: ['fun'],
        },
        {
          id: 'v2',
          title: 'Short Two',
          src_url: 'https://cdn/v2.mp4',
          thumbnail_url: null,
          created_at: '2024-01-02T00:00:00Z',
          tags: [],
        },
      ],
      error: null,
    });
    mockSupabase.__setUploadsResponse({ data: [], error: null });

    const res = await request(app).get('/api/v1/media-hub/search?q=short&type=shorts');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hits).toHaveLength(2);
    res.body.hits.forEach((hit: Record<string, unknown>) => {
      expect(hit.type).toBe('shorts');
      expect(hit.file_url).toBeDefined();
    });
  });
});

describe('GET /search — type=all (default)', () => {
  it('merges results from both tables and respects the limit', async () => {
    mockSupabase.__setUploadsResponse({
      data: [
        {
          id: 'u1',
          title: 'Music Hit',
          media_type: 'music',
          file_url: 'https://cdn/m1.mp3',
          thumbnail_url: null,
          created_at: '2024-01-01T00:00:00Z',
          music_metadata: [{ artist: 'A', album: 'B', genre: 'C' }],
        },
        {
          id: 'u2',
          title: 'Podcast Hit',
          media_type: 'podcast',
          file_url: 'https://cdn/p1.mp3',
          thumbnail_url: null,
          created_at: '2024-01-01T00:00:00Z',
          podcast_metadata: [{ host_name: 'H', series_name: 'S', episode_number: 2 }],
        },
      ],
      error: null,
    });
    mockSupabase.__setVideosResponse({
      data: [
        {
          id: 'v1',
          title: 'Short Hit',
          src_url: 'https://cdn/v1.mp4',
          thumbnail_url: null,
          created_at: '2024-01-01T00:00:00Z',
          tags: [],
        },
      ],
      error: null,
    });

    const limit = 5;
    const res = await request(app).get(`/api/v1/media-hub/search?q=hit&limit=${limit}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.hits)).toBe(true);
    expect(res.body.hits.length).toBeLessThanOrEqual(limit);
    // We seeded 3 rows total so all should appear (3 <= 5)
    expect(res.body.hits.length).toBe(3);
  });
});

describe('GET /search — limit clamping', () => {
  beforeEach(() => {
    // Seed plenty of rows so the limit is the binding constraint
    const manyUploads = Array.from({ length: 15 }, (_, i) => ({
      id: `u${i}`,
      title: `Music ${i}`,
      media_type: 'music',
      file_url: `https://cdn/m${i}.mp3`,
      thumbnail_url: null,
      created_at: '2024-01-01T00:00:00Z',
      music_metadata: [{ artist: 'A', album: 'B', genre: 'C' }],
    }));
    const manyVideos = Array.from({ length: 15 }, (_, i) => ({
      id: `v${i}`,
      title: `Short ${i}`,
      src_url: `https://cdn/v${i}.mp4`,
      thumbnail_url: null,
      created_at: '2024-01-01T00:00:00Z',
      tags: [],
    }));
    mockSupabase.__setUploadsResponse({ data: manyUploads, error: null });
    mockSupabase.__setVideosResponse({ data: manyVideos, error: null });
  });

  it('clamps limit >20 to 20', async () => {
    const res = await request(app).get('/api/v1/media-hub/search?q=test&limit=99');
    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeLessThanOrEqual(20);
  });

  it('clamps limit <1 to 1 and does not 400', async () => {
    const res = await request(app).get('/api/v1/media-hub/search?q=test&limit=0');
    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to 5 for non-numeric limit', async () => {
    const res = await request(app).get('/api/v1/media-hub/search?q=test&limit=abc');
    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeLessThanOrEqual(5);
  });
});

describe('GET /search — escapeLike', () => {
  it('escapes %, _, and \\ in q before passing to Supabase .or()', async () => {
    mockSupabase.__setUploadsResponse({ data: [], error: null });
    mockSupabase.__setVideosResponse({ data: [], error: null });

    const res = await request(app).get(
      '/api/v1/media-hub/search?q=foo%25bar_baz%5Cqux',
    );
    expect(res.status).toBe(200);

    // Check the .or() call on either builder contains the escaped pattern
    const uploadsBuilder = mockSupabase.__getUploadsBuilder();
    const videosBuilder = mockSupabase.__getVideosBuilder();

    const allOrCalls = [
      ...uploadsBuilder.or.mock.calls,
      ...videosBuilder.or.mock.calls,
    ] as string[][];

    const orArg = allOrCalls.map((c) => c[0]).join(' ');
    // The escaped form: % → \%, _ → \_, \ → \\
    expect(orArg).toMatch(/\\%/);
    expect(orArg).toMatch(/\\_/);
  });
});

describe('GET /search — Supabase error tolerance', () => {
  it('silently drops uploads error and still returns shorts hits', async () => {
    mockSupabase.__setUploadsResponse({ data: null, error: new Error('DB down') });
    mockSupabase.__setVideosResponse({
      data: [
        {
          id: 'v1',
          title: 'Short OK',
          src_url: 'https://cdn/v1.mp4',
          thumbnail_url: null,
          created_at: '2024-01-01T00:00:00Z',
          tags: [],
        },
      ],
      error: null,
    });

    const res = await request(app).get('/api/v1/media-hub/search?q=test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Only the shorts row survives; music/podcast rows from uploads are dropped
    const types = res.body.hits.map((h: Record<string, unknown>) => h.type);
    expect(types).not.toContain('music');
    expect(types).not.toContain('podcast');
    expect(types).toContain('shorts');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/media-hub/shorts/auto-metadata
// ---------------------------------------------------------------------------

describe('POST /shorts/auto-metadata — auth', () => {
  it('returns 401 when requireAuth denies the request', async () => {
    requireAuth.mockImplementation(
      (_req: import('express').Request, res: import('express').Response) => {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
      },
    );

    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: 'Unauthorized' });
  });
});

describe('POST /shorts/auto-metadata — body validation', () => {
  it('returns 400 for empty body with details array', async () => {
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'Invalid request body' });
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('returns 400 when frames field is missing', async () => {
    const body = { ...VALID_BODY };
    delete (body as Partial<typeof VALID_BODY>).frames;
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when mime_type is not video/*', async () => {
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send({ ...VALID_BODY, mime_type: 'audio/mp3' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when frame data_url is not a JPEG data URL', async () => {
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send({
        ...VALID_BODY,
        frames: [{ position_ratio: 0.5, data_url: 'data:image/png;base64,abc123' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when duration_seconds is negative', async () => {
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send({ ...VALID_BODY, duration_seconds: -1 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when duration_seconds exceeds 600', async () => {
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send({ ...VALID_BODY, duration_seconds: 700 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when frames array is empty', async () => {
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send({ ...VALID_BODY, frames: [] });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /shorts/auto-metadata — success', () => {
  it('returns 200 with correct shape and calls analyzeShortFrames correctly', async () => {
    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      metadata: {
        title: 'T',
        description: 'D',
        category: 'C',
        tags: ['a'],
      },
      model: 'claude-sonnet-4-6',
      latency_ms: 120,
    });

    expect(analyzeShortFrames).toHaveBeenCalledTimes(1);
    expect(analyzeShortFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        frames: [VALID_FRAME],
        filename: 'clip.mp4',
        durationSeconds: 30,
      }),
    );
  });
});

describe('POST /shorts/auto-metadata — VisionClientError mapping', () => {
  test.each([
    ['TIMEOUT', 504],
    ['RATE_LIMIT', 429],
    ['MISSING_API_KEY', 503],
    ['UPSTREAM_ERROR', 502],
  ])('VisionClientError code=%s maps to HTTP %d', async (code, expectedStatus) => {
    analyzeShortFrames.mockRejectedValueOnce(
      new VisionClientError(`Vision error: ${code}`, code),
    );

    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send(VALID_BODY);

    expect(res.status).toBe(expectedStatus);
    expect(res.body).toMatchObject({
      ok: false,
      code,
      error: expect.any(String),
    });
  });
});

describe('POST /shorts/auto-metadata — unexpected error', () => {
  it('returns 500 with INTERNAL code for unexpected Error', async () => {
    analyzeShortFrames.mockRejectedValueOnce(new Error('boom'));

    const res = await request(app)
      .post('/api/v1/media-hub/shorts/auto-metadata')
      .send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      ok: false,
      code: 'INTERNAL',
      error: expect.any(String),
    });
  });
});
