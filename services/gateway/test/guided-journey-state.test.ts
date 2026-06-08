/**
 * VTID-03276 — Guided Journey durable mode/progress state (P1) tests.
 *
 * Covers:
 *  - lossless guided⇄full switching + audit-timestamp rules (handoff Task 2.2)
 *  - state separation: mode changes never touch progress, and the served shape
 *    carries no subscription/entitlement fields (handoff Task 2.3)
 *  - HTTP boundaries: 401 unauth, 400 invalid mode, 200 happy paths
 */

import request from 'supertest';
import express from 'express';

import {
  getJourneyState,
  setJourneyMode,
} from '../src/services/guided-journey/guided-journey-state';

// ---------------------------------------------------------------------------
// In-memory fake Supabase client supporting exactly the chains the service uses:
//   .select('*').eq('user_id', id).maybeSingle()/.single()
//   .upsert({user_id}, {onConflict, ignoreDuplicates}).select('*').maybeSingle()
//   .update(patch).eq('user_id', id).select('*').single()
// ---------------------------------------------------------------------------
const FIXED_NOW = '2026-06-08T00:00:00.000Z';

function defaultRow(userId: string) {
  return {
    user_id: userId,
    mode: 'guided',
    onboarding_status: 'not_started',
    current_session: 1,
    completed_topic_ids: [] as string[],
    completed_practice_count: 0,
    qualification_threshold: 60,
    qualified_at: null,
    skipped_onboarding_at: null,
    entered_full_mode_at: null,
    returned_to_guided_at: null,
    last_opened_topic_id: null,
    metadata: {},
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
  };
}

function makeFakeSupabase() {
  const store = new Map<string, any>();
  const client: any = {
    __store: store,
    from(_table: string) {
      let op: 'select' | 'upsert' | 'update' = 'select';
      let filterId: string | null = null;
      let payload: any = null;
      let upsertOpts: any = null;

      const resolve = (requireRow: boolean) => {
        if (op === 'upsert') {
          const id = payload.user_id;
          if (!store.has(id)) {
            store.set(id, { ...defaultRow(id), ...payload });
            return Promise.resolve({ data: store.get(id), error: null });
          }
          if (upsertOpts?.ignoreDuplicates) {
            return Promise.resolve({ data: null, error: null });
          }
          store.set(id, { ...store.get(id), ...payload });
          return Promise.resolve({ data: store.get(id), error: null });
        }
        if (op === 'update') {
          const row = filterId != null ? store.get(filterId) : null;
          if (!row) {
            return Promise.resolve({ data: null, error: requireRow ? { message: 'no row' } : null });
          }
          store.set(filterId as string, { ...row, ...payload });
          return Promise.resolve({ data: store.get(filterId as string), error: null });
        }
        const row = filterId != null ? store.get(filterId) ?? null : null;
        if (!row && requireRow) return Promise.resolve({ data: null, error: { message: 'no rows' } });
        return Promise.resolve({ data: row, error: null });
      };

      const builder: any = {
        select() { return builder; },
        eq(col: string, val: string) { if (col === 'user_id') filterId = val; return builder; },
        upsert(p: any, opts: any) { op = 'upsert'; payload = p; upsertOpts = opts; return builder; },
        update(p: any) { op = 'update'; payload = p; return builder; },
        maybeSingle() { return resolve(false); },
        single() { return resolve(true); },
      };
      return builder;
    },
  };
  return client;
}

const SUBSCRIPTION_OR_PERMISSION_KEYS = [
  'subscription', 'subscriptionStatus', 'subscription_status',
  'entitlement', 'entitlements', 'featurePermission', 'feature_permission',
  'plan', 'tier', 'billing',
];

describe('guided-journey-state service', () => {
  it('lazily creates a default guided row on first read', async () => {
    const sb = makeFakeSupabase();
    const state = await getJourneyState(sb, 'user-1');
    expect(state.mode).toBe('guided');
    expect(state.onboardingStatus).toBe('not_started');
    expect(state.currentSession).toBe(1);
    expect(state.completedTopicIds).toEqual([]);
    expect(state.qualificationThreshold).toBe(60);
  });

  it('switching to full before qualifying stamps entered_full_mode_at + skip', async () => {
    const sb = makeFakeSupabase();
    const state = await setJourneyMode(sb, 'user-1', 'full', FIXED_NOW);
    expect(state.mode).toBe('full');
    expect(state.enteredFullModeAt).toBe(FIXED_NOW);
    expect(state.skippedOnboardingAt).toBe(FIXED_NOW);
    expect(state.onboardingStatus).toBe('skipped');
  });

  it('does not re-stamp entered_full_mode_at / skip on a second full switch', async () => {
    const sb = makeFakeSupabase();
    await setJourneyMode(sb, 'user-1', 'full', '2026-06-08T01:00:00.000Z');
    await setJourneyMode(sb, 'user-1', 'guided', '2026-06-08T02:00:00.000Z');
    const again = await setJourneyMode(sb, 'user-1', 'full', '2026-06-08T03:00:00.000Z');
    expect(again.enteredFullModeAt).toBe('2026-06-08T01:00:00.000Z'); // first entry preserved
    expect(again.skippedOnboardingAt).toBe('2026-06-08T01:00:00.000Z'); // first skip preserved
  });

  it('returning to guided after a skip resumes as in_progress and stamps return', async () => {
    const sb = makeFakeSupabase();
    await setJourneyMode(sb, 'user-1', 'full', '2026-06-08T01:00:00.000Z');
    const back = await setJourneyMode(sb, 'user-1', 'guided', '2026-06-08T02:00:00.000Z');
    expect(back.mode).toBe('guided');
    expect(back.onboardingStatus).toBe('in_progress');
    expect(back.returnedToGuidedAt).toBe('2026-06-08T02:00:00.000Z');
  });

  it('switching to full when already qualified does NOT mark skipped', async () => {
    const sb = makeFakeSupabase();
    // Seed a qualified user directly in the store.
    (sb.__store as Map<string, any>).set('user-q', {
      ...defaultRow('user-q'),
      onboarding_status: 'qualified',
      completed_practice_count: 60,
      qualified_at: '2026-06-07T00:00:00.000Z',
    });
    const state = await setJourneyMode(sb, 'user-q', 'full', FIXED_NOW);
    expect(state.onboardingStatus).toBe('qualified');
    expect(state.skippedOnboardingAt).toBeNull();
    expect(state.enteredFullModeAt).toBe(FIXED_NOW);
  });

  it('switching mode never mutates progress (current_session, topics, practice count)', async () => {
    const sb = makeFakeSupabase();
    (sb.__store as Map<string, any>).set('user-p', {
      ...defaultRow('user-p'),
      onboarding_status: 'in_progress',
      current_session: 7,
      completed_topic_ids: ['T001', 'T002', 'T003'],
      completed_practice_count: 12,
    });
    const toFull = await setJourneyMode(sb, 'user-p', 'full', FIXED_NOW);
    expect(toFull.currentSession).toBe(7);
    expect(toFull.completedTopicIds).toEqual(['T001', 'T002', 'T003']);
    expect(toFull.completedPracticeCount).toBe(12);

    const backToGuided = await setJourneyMode(sb, 'user-p', 'guided', FIXED_NOW);
    expect(backToGuided.currentSession).toBe(7); // resumes same session
    expect(backToGuided.completedTopicIds).toEqual(['T001', 'T002', 'T003']);
    expect(backToGuided.completedPracticeCount).toBe(12);
  });

  it('served state carries NO subscription/entitlement/permission fields', async () => {
    const sb = makeFakeSupabase();
    const state = await getJourneyState(sb, 'user-1');
    for (const key of SUBSCRIPTION_OR_PERMISSION_KEYS) {
      expect(state).not.toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------
let mockSupabase: any;

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (authHeader === 'Bearer valid-user') {
      req.identity = { user_id: 'http-user-1', email: 'u@example.com', exafy_admin: false };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  },
}));

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guidedJourneyRouter = require('../src/routes/guided-journey').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/journey', guidedJourneyRouter);
  return app;
}

describe('Guided Journey HTTP routes', () => {
  beforeEach(() => {
    mockSupabase = makeFakeSupabase();
  });

  it('GET /state → 401 without a token', async () => {
    const res = await request(makeApp()).get('/api/v1/journey/state');
    expect(res.status).toBe(401);
  });

  it('GET /state → 200 with default guided state', async () => {
    const res = await request(makeApp())
      .get('/api/v1/journey/state')
      .set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state.mode).toBe('guided');
    expect(res.body.vtid).toBe('VTID-03276');
  });

  it('GET /mode → 200 returns just the mode', async () => {
    const res = await request(makeApp())
      .get('/api/v1/journey/mode')
      .set('Authorization', 'Bearer valid-user');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('guided');
  });

  it('POST /mode → 400 on invalid mode', async () => {
    const res = await request(makeApp())
      .post('/api/v1/journey/mode')
      .set('Authorization', 'Bearer valid-user')
      .send({ mode: 'turbo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_mode');
  });

  it('POST /mode → 200 switches to full', async () => {
    const res = await request(makeApp())
      .post('/api/v1/journey/mode')
      .set('Authorization', 'Bearer valid-user')
      .send({ mode: 'full' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state.mode).toBe('full');
    expect(res.body.state.enteredFullModeAt).not.toBeNull();
  });
});
