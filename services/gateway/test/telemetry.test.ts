/**
 * Gateway Telemetry Tests
 * VTID: DEV-CICDL-0034
 * VT_LAYER: CICDL
 * VT_MODULE: GATEWAY
 * 
 * Test suite for Gateway telemetry functionality with mocked dependencies
 */

import { createMockSupabaseClient, createMockOasisClient, clearMockData } from '../__mocks__/supabase';

describe('Gateway Telemetry', () => {
  let supabaseClient: ReturnType<typeof createMockSupabaseClient>;
  let oasisClient: ReturnType<typeof createMockOasisClient>;

  beforeEach(() => {
    clearMockData();
    supabaseClient = createMockSupabaseClient();
    oasisClient = createMockOasisClient();
  });

  describe('Event Logging', () => {
    it('should log telemetry event to OASIS', async () => {
      // Arrange
      const event = {
        vtid: 'DEV-CICDL-0034',
        vt_layer: 'CICDL',
        vt_module: 'GATEWAY',
        event_type: 'api_request',
        timestamp: new Date().toISOString(),
        metadata: {
          endpoint: '/api/v1/health',
          method: 'GET',
          status: 200
        }
      };

      // Act
      const result = await oasisClient.telemetry.sendEvent(event);

      // Assert
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.eventId).toMatch(/^mock-event-/);
      expect(oasisClient.telemetry.sendEvent).toHaveBeenCalledWith(event);
      expect(oasisClient.telemetry.sendEvent).toHaveBeenCalledTimes(1);
    });

    it('should batch multiple telemetry events', async () => {
      // Arrange
      const events = [
        { vtid: 'DEV-CICDL-0034', event_type: 'event_1' },
        { vtid: 'DEV-CICDL-0034', event_type: 'event_2' },
        { vtid: 'DEV-CICDL-0034', event_type: 'event_3' }
      ];

      // Act
      const result = await oasisClient.telemetry.sendBatch(events);

      // Assert
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(oasisClient.telemetry.sendBatch).toHaveBeenCalledWith(events);
    });
  });

  describe('Database Operations', () => {
    it('should store telemetry event in Supabase', async () => {
      // Arrange
      const event = {
        vtid: 'DEV-CICDL-0034',
        vt_layer: 'CICDL',
        vt_module: 'GATEWAY',
        event_type: 'user_action',
        metadata: {
          action: 'button_click',
          component: 'navigation'
        }
      };

      // Act
      const { data, error } = await supabaseClient
        .from('telemetry_events')
        .insert(event);

      // Assert
      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({
        vtid: 'DEV-CICDL-0034',
        event_type: 'user_action',
        vt_layer: 'CICDL',
        vt_module: 'GATEWAY'
      });
      expect(data![0].id).toMatch(/^mock-id-/);
      expect(data![0].created_at).toBeDefined();
    });

    it('should query telemetry events by VTID', async () => {
      // Arrange
      await supabaseClient.from('telemetry_events').insert([
        { id: 'event-1', vtid: 'DEV-CICDL-0034', event_type: 'test_1' },
        { id: 'event-2', vtid: 'DEV-CICDL-0034', event_type: 'test_2' },
        { id: 'event-3', vtid: 'OTHER-VTID', event_type: 'test_3' }
      ]);

      // Act
      const { data, error } = await supabaseClient
        .from('telemetry_events')
        .select('*')
        .eq('vtid', 'DEV-CICDL-0034');

      // Assert
      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data!.length).toBeGreaterThanOrEqual(2);
      expect(data!.every(event => event.vtid === 'DEV-CICDL-0034')).toBe(true);
    });
  });

  describe('Health Checks', () => {
    it('should verify OASIS health', async () => {
      // Act
      const health = await oasisClient.health.check();

      // Assert
      expect(health).toBeDefined();
      expect(health.status).toBe('healthy');
      expect(health.timestamp).toBeDefined();
    });
  });
});

describe('Gateway Integration', () => {
  it('should complete full telemetry flow: log -> store -> query', async () => {
    // Arrange
    const supabase = createMockSupabaseClient();
    const oasis = createMockOasisClient();
    const event = {
      vtid: 'DEV-CICDL-0034',
      vt_layer: 'CICDL',
      vt_module: 'GATEWAY',
      event_type: 'integration_test',
      metadata: { flow: 'complete', stage: 'testing' }
    };

    // Act 1: Send to OASIS
    const oasisResult = await oasis.telemetry.sendEvent(event);
    expect(oasisResult.success).toBe(true);

    // Act 2: Store in Supabase
    const { data: storedData } = await supabase
      .from('telemetry_events')
      .insert({ ...event, oasis_event_id: oasisResult.eventId });
    expect(storedData).toHaveLength(1);

    // Act 3: Query back from Supabase
    const { data: queriedData } = await supabase
      .from('telemetry_events')
      .select('*')
      .eq('event_type', 'integration_test');

    // Assert
    expect(queriedData).toHaveLength(1);
    expect(queriedData![0].oasis_event_id).toBe(oasisResult.eventId);
    expect(queriedData![0].event_type).toBe('integration_test');
    expect(queriedData![0].vtid).toBe('DEV-CICDL-0034');
  });
});
