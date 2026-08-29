import * as repo from '../../../src/services/capability-awareness/capability-awareness-service-repository';

describe('capability-awareness-service-repository', () => {
  describe('advanceCapabilityAwareness', () => {
    it('calls the advance_capability_awareness RPC with the exact params passed', async () => {
      const rpc = jest.fn().mockResolvedValue({ data: { ok: true }, error: null });
      const sb = { rpc } as any;
      const params = {
        p_tenant_id: 't1',
        p_user_id: 'u1',
        p_capability_key: 'life_compass',
        p_event_name: 'introduced',
        p_idempotency_key: 'k1',
        p_decision_id: null,
        p_source_surface: null,
        p_occurred_at: null,
        p_metadata: null,
      };
      await repo.advanceCapabilityAwareness(sb, params);
      expect(rpc).toHaveBeenCalledWith('advance_capability_awareness', params);
    });
  });
});
