import { registerAllActionExecutors } from '../../src/services/action-executors';
import type { ActionExecutor, ActionType } from '../../src/services/consent-gate';

// ──────────────────────────────────────────────────────────────
// Mock: consent-gate — capture registered executors
// ──────────────────────────────────────────────────────────────
const executors: Record<string, ActionExecutor> = {};
const mockRegister = jest.fn((type: string, fn: ActionExecutor) => {
  executors[type] = fn;
});

jest.mock('../../src/services/consent-gate', () => ({
  registerActionExecutor: (type: ActionType, fn: ActionExecutor) => mockRegister(type, fn),
}));

// ──────────────────────────────────────────────────────────────
// Mock: supabase
// ──────────────────────────────────────────────────────────────
type SupabaseStub = {
  rpc: jest.Mock;
  from: jest.Mock;
};

let mockGetSupabase: jest.Mock<SupabaseStub | null>;

function buildSupabaseMock(
  rpcResult: { data: unknown; error: null | { message: string } } = {
    data: { ok: true, id: 'offer-123', strength_delta: 5 },
    error: null,
  },
  fromResult: { data: unknown; error: null | { message: string } } = {
    data: { id: 'row-456' },
    error: null,
  },
): SupabaseStub {
  const single = jest.fn().mockResolvedValue(fromResult);
  const select = jest.fn().mockReturnValue({ single });
  const insert = jest.fn().mockReturnValue({ select });
  const from = jest.fn().mockReturnValue({ insert });
  const rpc = jest.fn().mockResolvedValue(rpcResult);
  return { rpc, from };
}

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

// ──────────────────────────────────────────────────────────────
// Mock: reward-events
// ──────────────────────────────────────────────────────────────
const mockEmitClick = jest.fn();
jest.mock('../../src/services/reward-events', () => ({
  emitClickOutbound: (...args: unknown[]) => mockEmitClick(...args),
}));

// ──────────────────────────────────────────────────────────────
// Shared ctx
// ──────────────────────────────────────────────────────────────
const CTX = {
  user_id: 'user-abc',
  tenant_id: 'tenant-xyz',
  action_id: 'action-001',
};

// ──────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────
beforeAll(() => {
  mockGetSupabase = jest.fn();
  registerAllActionExecutors();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSupabase.mockReturnValue(buildSupabaseMock());
});

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────
describe('registerAllActionExecutors', () => {
  // ── boot ──────────────────────────────────────────────────
  describe('boot', () => {
    it('registers exactly 5 executors', () => {
      expect(Object.keys(executors)).toHaveLength(5);
      expect(executors['shopping_add_to_list']).toBeDefined();
      expect(executors['share_milestone']).toBeDefined();
      expect(executors['social_post_story']).toBeDefined();
      expect(executors['wearable_log_workout']).toBeDefined();
      expect(executors['calendar_add_event']).toBeDefined();
    });
  });

  // ── shopping_add_to_list ──────────────────────────────────
  describe('shopping_add_to_list', () => {
    it('happy path — rpc ok → returns ok + external_id + result', async () => {
      const result = await executors['shopping_add_to_list'](
        { product_id: 'prod-99', note: 'want this' },
        CTX,
      );
      expect(result.ok).toBe(true);
      expect(result.external_id).toBe('offer-123');
      expect(result.result).toMatchObject({ product_id: 'prod-99', state: 'saved', strength_delta: 5 });
    });

    it('missing product_id → ok=false with message', async () => {
      const result = await executors['shopping_add_to_list']({}, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/product_id required/i);
    });

    it('non-string product_id treated as missing → ok=false', async () => {
      const result = await executors['shopping_add_to_list']({ product_id: 42 }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/product_id required/i);
    });

    it('rpc DB error → ok=false with error message', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock({ data: null, error: { message: 'connection refused' } }),
      );
      const result = await executors['shopping_add_to_list']({ product_id: 'prod-99' }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('connection refused');
    });

    it('data.ok=false with custom error → propagates error text', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock({ data: { ok: false, error: 'Duplicate entry' }, error: null }),
      );
      const result = await executors['shopping_add_to_list']({ product_id: 'prod-99' }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Duplicate entry');
    });

    it('data.ok=false with no error field → falls back to Unknown', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock({ data: { ok: false }, error: null }),
      );
      const result = await executors['shopping_add_to_list']({ product_id: 'prod-99' }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Unknown');
    });

    it('getSupabase() returns null → ok=false DB unavailable', async () => {
      mockGetSupabase.mockReturnValue(null);
      const result = await executors['shopping_add_to_list']({ product_id: 'prod-99' }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/DB unavailable/i);
    });
  });

  // ── share_milestone ───────────────────────────────────────
  describe('share_milestone', () => {
    it('happy path — returns ok + share_url containing action_id', async () => {
      const result = await executors['share_milestone'](
        { milestone_text: 'I did it!', channel: 'twitter', product_id: 'p1' },
        CTX,
      );
      expect(result.ok).toBe(true);
      expect(result.external_id).toContain(CTX.action_id);
      expect(result.result?.share_url).toContain(CTX.action_id);
    });

    it('channel defaults to copy_link when not provided', async () => {
      const result = await executors['share_milestone']({ milestone_text: 'hi' }, CTX);
      expect(result.ok).toBe(true);
      expect(result.result?.channel).toBe('copy_link');
    });

    it('milestone_text truncated to 280 chars', async () => {
      const longText = 'x'.repeat(400);
      const result = await executors['share_milestone']({ milestone_text: longText }, CTX);
      expect(result.ok).toBe(true);
      expect((result.result?.milestone_text as string).length).toBe(280);
    });
  });

  // ── social_post_story ─────────────────────────────────────
  describe('social_post_story', () => {
    it('happy path — returns ok + action=copy_and_open', async () => {
      const result = await executors['social_post_story'](
        { caption: 'Look at me!', provider: 'instagram' },
        CTX,
      );
      expect(result.ok).toBe(true);
      expect(result.result?.action).toBe('copy_and_open');
      expect(result.result?.provider).toBe('instagram');
    });

    it('caption truncated to 2200 chars', async () => {
      const longCaption = 'a'.repeat(3000);
      const result = await executors['social_post_story']({ caption: longCaption }, CTX);
      expect(result.ok).toBe(true);
      expect((result.result?.caption as string).length).toBe(2200);
    });

    it('provider defaults to instagram when not provided', async () => {
      const result = await executors['social_post_story']({}, CTX);
      expect(result.ok).toBe(true);
      expect(result.result?.provider).toBe('instagram');
    });
  });

  // ── wearable_log_workout ──────────────────────────────────
  describe('wearable_log_workout', () => {
    it('happy path — insert ok → returns ok + external_id', async () => {
      const result = await executors['wearable_log_workout'](
        { workout_type: 'run', duration_minutes: 30, calories: 250 },
        CTX,
      );
      expect(result.ok).toBe(true);
      expect(result.external_id).toBe('row-456');
      expect(result.result?.workout_type).toBe('run');
    });

    it('non-number duration_minutes coerced to null', async () => {
      const stub = buildSupabaseMock(
        { data: { ok: true, id: 'offer-123', strength_delta: 0 }, error: null },
        { data: { id: 'row-789' }, error: null },
      );
      mockGetSupabase.mockReturnValue(stub);
      const result = await executors['wearable_log_workout'](
        { workout_type: 'yoga', duration_minutes: 'long', calories: 'lots' },
        CTX,
      );
      expect(result.ok).toBe(true);
      // coercion → duration_minutes and calories are null in the result
      expect(result.result?.duration_minutes).toBeNull();
    });

    it('getSupabase() returns null → ok=false', async () => {
      mockGetSupabase.mockReturnValue(null);
      const result = await executors['wearable_log_workout']({ workout_type: 'run' }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/DB unavailable/i);
    });

    it('insert DB error → ok=false with error message', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock(
          { data: { ok: true, id: 'x', strength_delta: 0 }, error: null },
          { data: null, error: { message: 'table does not exist' } },
        ),
      );
      const result = await executors['wearable_log_workout']({ workout_type: 'swim' }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('table does not exist');
    });
  });

  // ── calendar_add_event ────────────────────────────────────
  describe('calendar_add_event', () => {
    it('happy path — insert ok → returns ok + external_id + result', async () => {
      const result = await executors['calendar_add_event'](
        { title: 'Morning Run', start_time: '2026-01-01T10:00:00.000Z', duration_minutes: 60 },
        CTX,
      );
      expect(result.ok).toBe(true);
      expect(result.external_id).toBe('row-456');
      expect(result.result?.title).toBe('Morning Run');
    });

    it('end_time = start_time + duration_minutes * 60000', async () => {
      const result = await executors['calendar_add_event'](
        { title: 'Yoga', start_time: '2026-01-01T10:00:00.000Z', duration_minutes: 60 },
        CTX,
      );
      expect(result.ok).toBe(true);
      expect(result.result?.end_time).toBe('2026-01-01T11:00:00.000Z');
    });

    it('insert error → ok=false with error message', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock(
          { data: { ok: true, id: 'x', strength_delta: 0 }, error: null },
          { data: null, error: { message: 'calendar_events not found' } },
        ),
      );
      const result = await executors['calendar_add_event'](
        { title: 'Test', start_time: '2026-01-01T10:00:00.000Z', duration_minutes: 30 },
        CTX,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe('calendar_events not found');
    });

    it('getSupabase() returns null → ok=false', async () => {
      mockGetSupabase.mockReturnValue(null);
      const result = await executors['calendar_add_event']({ title: 'Yoga' }, CTX);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/DB unavailable/i);
    });
  });
});