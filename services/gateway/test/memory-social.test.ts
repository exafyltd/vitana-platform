// BOOTSTRAP-SOCIAL-MEMORY — HTTP tests for the /api/v1/memory/social routes.
//
// Contract under test:
//   - auth: 401 without a token on every endpoint
//   - self-scoping: POST /assistant-context rejects a foreign userId (403)
//     but accepts 'current-user' and the caller's own id
//   - happy path: assistant-context returns the spec shape
//   - person privacy: unknown person → 404

import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization === 'Bearer user') {
      req.identity = { user_id: 'user-1', tenant_id: 'tenant-1', exafy_admin: false };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  },
  requireTenant: (req: any, res: any, next: any) => {
    if (!req.identity?.tenant_id) return res.status(400).json({ ok: false, error: 'TENANT_REQUIRED' });
    return next();
  },
}));

const EMPTY_PACK = {
  user: { user_id: 'user-1', display_name: 'Test' },
  relationships: { following: [], followers: [], following_count: 0, followers_count: 0, mutual_ids: [] },
  matches: [],
  messages: [],
  group_chats: [],
  interesting_posts: [],
  interesting_events: [],
  person_context: null,
  activity_context: null,
  memory_highlights: [],
  recommended_actions: [],
  assistant_system_hints: ['hint'],
  meta: { built_at: '', latency_ms: 1, sections_loaded: [], degraded_sections: [], privacy_filters_applied: [] },
};

jest.mock('../src/services/social-memory/social-context-builder', () => ({
  buildSocialContextPack: jest.fn().mockResolvedValue(EMPTY_PACK),
}));
jest.mock('../src/services/social-memory/person-context-builder', () => ({
  buildPersonContext: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/social-memory/community-activity-builder', () => ({
  buildPersonActivity: jest.fn().mockResolvedValue({ person: null, items: [], window_days: 14 }),
}));
jest.mock('../src/services/social-memory/social-memory-service', () => ({
  buildAssistantSocialContext: jest.fn().mockResolvedValue({
    ok: true,
    intent: { is_social: true, kinds: ['matches'], person_hint: null },
    pack: EMPTY_PACK,
    prompt_block: '<social_context></social_context>',
  }),
}));
jest.mock('../src/services/social-memory/social-memory-repository', () => ({
  fetchExclusions: jest.fn().mockResolvedValue({ blocked: new Set(), muted: new Set(), hidden_posts: new Set() }),
  fetchFollowEdges: jest.fn().mockResolvedValue({ following: [], followers: [] }),
  fetchMatches: jest.fn().mockResolvedValue([]),
  fetchRecentMessageContacts: jest.fn().mockResolvedValue([]),
  fetchGroupChats: jest.fn().mockResolvedValue([]),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/memory-social').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/memory/social', router);
  return app;
}

describe('/api/v1/memory/social — auth', () => {
  const endpoints = [
    '/api/v1/memory/social/context/me',
    '/api/v1/memory/social/following',
    '/api/v1/memory/social/followers',
    '/api/v1/memory/social/matches',
    '/api/v1/memory/social/messages',
    '/api/v1/memory/social/group-chats',
    '/api/v1/memory/social/interesting-posts',
    '/api/v1/memory/social/interesting-events',
    '/api/v1/memory/social/person/abc',
    '/api/v1/memory/social/activity/abc',
  ];

  it.each(endpoints)('401 without token: %s', async (path) => {
    const r = await request(makeApp()).get(path);
    expect(r.status).toBe(401);
  });

  it('401 without token on POST /assistant-context', async () => {
    const r = await request(makeApp()).post('/api/v1/memory/social/assistant-context').send({});
    expect(r.status).toBe(401);
  });
});

describe('POST /assistant-context — self-scoping', () => {
  it('403 for a foreign userId in the body', async () => {
    const r = await request(makeApp())
      .post('/api/v1/memory/social/assistant-context')
      .set('Authorization', 'Bearer user')
      .send({ userId: 'someone-else', question: 'Who do I follow?' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('FORBIDDEN_USER_SCOPE');
  });

  it.each(['current-user', 'user-1', undefined])(
    'accepts userId=%s and returns the spec shape',
    async (userId) => {
      const r = await request(makeApp())
        .post('/api/v1/memory/social/assistant-context')
        .set('Authorization', 'Bearer user')
        .send({ userId, question: 'What matches do I have?', surface: 'vitana_assistant' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      for (const key of [
        'user', 'relationships', 'matches', 'messages', 'groupChats',
        'interestingPosts', 'interestingEvents', 'personContext',
        'activityContext', 'memoryHighlights', 'recommendedActions',
        'assistantSystemHints',
      ]) {
        expect(r.body).toHaveProperty(key);
      }
      expect(r.body.intent.kinds).toContain('matches');
    },
  );
});

describe('GET endpoints — happy + not-found paths', () => {
  it('GET /matches returns list shape', async () => {
    const r = await request(makeApp())
      .get('/api/v1/memory/social/matches')
      .set('Authorization', 'Bearer user');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, matches: [], count: 0 });
  });

  it('GET /person/:userId → 404 when person is unknown/blocked', async () => {
    const r = await request(makeApp())
      .get('/api/v1/memory/social/person/nope')
      .set('Authorization', 'Bearer user');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('PERSON_NOT_FOUND');
  });

  it('GET /context/me returns the pack', async () => {
    const r = await request(makeApp())
      .get('/api/v1/memory/social/context/me')
      .set('Authorization', 'Bearer user');
    expect(r.status).toBe(200);
    expect(r.body.relationships.following_count).toBe(0);
  });
});
