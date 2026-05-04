import { registerAllActionExecutors } from '../../src/services/action-executors';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------
const mockRegister = jest.fn();
const mockGetSupabase = jest.fn();
const mockEmitClick = jest.fn();

type ExecutorFn = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown> | any>;
const executors: Record<string, ExecutorFn> = {};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('../../src/services/consent-gate', () => ({
  registerActionExecutor: jest.fn((...args: any[]) => mockRegister(...args)),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn((...args: any[]) => mockGetSupabase(...args)),
}));

jest.mock('../../src/services/reward-events', () => ({
  emitClickOutbound: jest.fn((...args: any[]) => mockEmitClick(...args)),
}));

// ---------------------------------------------------------------------------
// Supabase stub builder
// ---------------------------------------------------------------------------
function buildSupabaseMock(
  rpcResult?: { data?: unknown; error?: { message: string } | null },
  fromResult?: { data?: unknown; error?: { message: string } | null }
) {
  const rpc = jest.fn().mockResolvedValue(rpcResult || { data: null, error: null });
  const single = jest.fn().mockResolvedValue(fromResult || { data: null, error: null });
  const select = jest.fn().mockReturnValue({ single });
  const insert = jest.fn().mockReturnValue({ select });
  const from = jest.fn().mockReturnValue({ insert });

  return { rpc, from, insert, select, single };
}

// ---------------------------------------------------------------------------
// Shared test context
// ---------------------------------------------------------------------------
const CTX = {
  action_id: 'action-abc',
  tenant_id: 'tenant-123',
  user_id: 'user-456',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeAll(() => {
  mockRegister.mockImplementation((type: string, fn: ExecutorFn) => {
    executors[type] = fn;
  });
  registerAllActionExecutors();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Happy-path stub by default
  mockGetSupabase.mockReturnValue(
    buildSupabaseMock(
      { data: { ok: true, id: 'offer-1', strength_delta: 1 }, error: null },
      { data: { id: 'default-insert-id' }, error: null }
    )
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('registerAllActionExecutors', () => {

  // ---- boot ----------------------------------------------------------------
  describe('boot', () => {
    it('registers exactly 5 executors', () => {
      expect(mockRegister).toHaveBeenCalledTimes(5);
      expect(Object.keys(executors)).toHaveLength(5);
      expect(Object.keys(executors).sort()).toEqual([
        'calendar_add_event',
        'share_milestone',
        'shopping_add_to_list',
        'social_post_story',
        'wearable_log_workout',
      ]);
    });
  });

  // ---- shopping_add_to_list ------------------------------------------------
  describe('shopping_add_to_list', () => {
    it('happy path returns ok:true with external_id and result', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock({ data: { ok: true, id: 'offer-1', strength_delta: 1 }, error: null })
      );
      const res = await executors['shopping_add_to_list']({ product_id: 'prod-1', note: 'test note' }, CTX);
      expect(res.ok).toBe(true);
      expect(res.external_id).toBe('offer-1');
      expect((res.result as Record<string, unknown>).product_id).toBe('prod-1');
      expect((res.result as Record<string, unknown>).state).toBe('saved');
    });

    it('returns error when product_id is missing', async () => {
      const res = await executors['shopping_add_to_list']({}, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('product_id required');
    });

    it('returns error when product_id is wrong type (number)', async () => {
      const res = await executors['shopping_add_to_list']({ product_id: 42 }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('product_id required');
    });

    it('returns error when rpc returns a DB error', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock({ data: null, error: { message: 'rpc failed' } })
      );
      const res = await executors['shopping_add_to_list']({ product_id: 'prod-1' }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('rpc failed');
    });

    it('returns error when data.ok is false with custom error', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock({ data: { ok: false, error: 'product not found' }, error: null })
      );
      const res = await executors['shopping_add_to_list']({ product_id: 'prod-1' }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('product not found');
    });

    it('returns error when data.ok is false with no custom error (falls back to Unknown)', async () => {
      mockGetSupabase.mockReturnValue(
        buildSupabaseMock({ data: { ok: false }, error: null })
      );
      const res = await executors['shopping_add_to_list']({ product_id: 'prod-1' }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Unknown');
    });

    it('returns DB unavailable when getSupabase() returns null', async () => {
      mockGetSupabase.mockReturnValue(null);
      const res = await executors['shopping_add_to_list']({ product_id: 'prod-1' }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('DB unavailable');
    });
  });

  // ---- share_milestone -----------------------------------------------------
  describe('share_milestone', () => {
    it('happy path returns ok:true with a share URL containing action_id', async () => {
      const res = await executors['share_milestone'](
        { channel: 'twitter', milestone_text: 'I hit my goal!' },
        CTX
      );
      expect(res.ok).toBe(true);
      expect(typeof res.external_id).toBe('string');
      expect(res.external_id).toContain(CTX.action_id);
      expect((res.result as Record<string, unknown>).channel).toBe('twitter');
    });

    it('channel defaults to copy_link when not provided', async () => {
      const res = await executors['share_milestone']({}, CTX);
      expect((res.result as Record<string, unknown>).channel).toBe('copy_link');
    });

    it('milestone_text is truncated to 280 characters', async () => {
      const longText = 'A'.repeat(400);
      const res = await executors['share_milestone']({ milestone_text: longText }, CTX);
      const result = res.result as Record<string, unknown>;
      expect((result.milestone_text as string).length).toBe(280);
    });
  });

  // ---- social_post_story ---------------------------------------------------
  describe('social_post_story', () => {
    it('happy path returns ok:true with copy_and_open action', async () => {
      const res = await executors['social_post_story'](
        { caption: 'My story!', provider: 'instagram' },
        CTX
      );
      expect(res.ok).toBe(true);
      expect((res.result as Record<string, unknown>).action).toBe('copy_and_open');
      expect((res.result as Record<string, unknown>).provider).toBe('instagram');
    });

    it('caption is truncated to 2200 characters', async () => {
      const longCaption = 'B'.repeat(3000);
      const res = await executors['social_post_story']({ caption: longCaption }, CTX);
      const result = res.result as Record<string, unknown>;
      expect((result.caption as string).length).toBe(2200);
    });

    it('provider defaults to instagram when not provided', async () => {
      const res = await executors['social_post_story']({}, CTX);
      expect((res.result as Record<string, unknown>).provider).toBe('instagram');
    });
  });

  // ---- wearable_log_workout ------------------------------------------------
  describe('wearable_log_workout', () => {
    it('happy path inserts and returns ok:true with external_id', async () => {
      const mockDb = buildSupabaseMock(undefined, { data: { id: 'workout-99' }, error: null });
      mockGetSupabase.mockReturnValue(mockDb);
      const res = await executors['wearable_log_workout'](
        { workout_type: 'run', duration_minutes: 45, calories: 300 },
        CTX
      );
      expect(res.ok).toBe(true);
      expect(res.external_id).toBe('workout-99');
      expect((res.result as Record<string, unknown>).workout_type).toBe('run');
      expect((res.result as Record<string, unknown>).duration_minutes).toBe(45);
    });

    it('coerces non-number duration_minutes to null', async () => {
      const mockDb = buildSupabaseMock(undefined, { data: { id: 'workout-100' }, error: null });
      mockGetSupabase.mockReturnValue(mockDb);
      await executors['wearable_log_workout']({ workout_type: 'run', duration_minutes: 'fast' }, CTX);
      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.objectContaining({ duration_minutes: null })
      );
    });

    it('coerces non-number calories to null', async () => {
      const mockDb = buildSupabaseMock(undefined, { data: { id: 'workout-101' }, error: null });
      mockGetSupabase.mockReturnValue(mockDb);
      await executors['wearable_log_workout']({ workout_type: 'run', calories: 'many' }, CTX);
      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.objectContaining({ calories: null })
      );
    });

    it('returns DB unavailable when getSupabase() returns null', async () => {
      mockGetSupabase.mockReturnValue(null);
      const res = await executors['wearable_log_workout']({ workout_type: 'run' }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('DB unavailable');
    });

    it('returns error when insert returns a DB error', async () => {
      const mockDb = buildSupabaseMock(undefined, { data: null, error: { message: 'insert failed' } });
      mockGetSupabase.mockReturnValue(mockDb);
      const res = await executors['wearable_log_workout']({ workout_type: 'run' }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('insert failed');
    });
  });

  // ---- calendar_add_event --------------------------------------------------
  describe('calendar_add_event', () => {
    it('happy path inserts and returns ok:true with external_id', async () => {
      const mockDb = buildSupabaseMock(undefined, { data: { id: 'cal-event-1' }, error: null });
      mockGetSupabase.mockReturnValue(mockDb);
      const res = await executors['calendar_add_event'](
        {
          title: 'Morning Yoga',
          start_time: '2026-01-01T10:00:00.000Z',
          duration_minutes: 60,
        },
        CTX
      );
      expect(res.ok).toBe(true);
      expect(res.external_id).toBe('cal-event-1');
      expect((res.result as Record<string, unknown>).title).toBe('Morning Yoga');
    });

    it('end_time is start_time + duration_minutes * 60000 ms', async () => {
      const mockDb = buildSupabaseMock(undefined, { data: { id: 'cal-event-2' }, error: null });
      mockGetSupabase.mockReturnValue(mockDb);
      const res = await executors['calendar_add_event'](
        {
          title: 'Test',
          start_time: '2026-01-01T10:00:00.000Z',
          duration_minutes: 60,
        },
        CTX
      );
      expect((res.result as Record<string, unknown>).end_time).toBe('2026-01-01T11:00:00.000Z');
      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.objectContaining({ end_time: '2026-01-01T11:00:00.000Z' })
      );
    });

    it('returns DB unavailable when getSupabase() returns null', async () => {
      mockGetSupabase.mockReturnValue(null);
      const res = await executors['calendar_add_event'](
        { title: 'Test', start_time: '2026-01-01T10:00:00.000Z' },
        CTX
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe('DB unavailable');
    });

    it('returns error when insert returns a DB error', async () => {
      const mockDb = buildSupabaseMock(undefined, { data: null, error: { message: 'calendar insert failed' } });
      mockGetSupabase.mockReturnValue(mockDb);
      const res = await executors['calendar_add_event'](
        { title: 'Test', start_time: '2026-01-01T10:00:00.000Z' },
        CTX
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe('calendar insert failed');
    });
  });

});