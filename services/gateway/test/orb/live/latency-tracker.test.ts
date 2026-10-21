/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: LatencyTracker.setProvider() — corrects the
 * `provider` label on voice.latency.measured after upstream selection
 * resolves (construction happens before Nova/Vertex is known for the
 * turn-0 establishment tracker).
 */

import { isFeatureLive } from '../../../src/services/feature-flags';
import { emitOasisEvent } from '../../../src/services/oasis-event-service';

jest.mock('../../../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockIsFeatureLive = isFeatureLive as jest.MockedFunction<typeof isFeatureLive>;
const mockEmitOasisEvent = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

import { LatencyTracker } from '../../../src/orb/live/latency-tracker';

describe('LatencyTracker.setProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFeatureLive.mockReturnValue(true);
  });

  it('emits the constructor-time provider when setProvider is never called', async () => {
    const t = new LatencyTracker({ session_id: 's1', surface: 'voice', provider: 'vertex/gemini-live' });
    t.mark('audio_out_first_chunk');
    await t.finalize('success');
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const payload = mockEmitOasisEvent.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.provider).toBe('vertex/gemini-live');
  });

  it('overrides the provider label before finalize — the Nova-vs-Vertex mislabel fix', async () => {
    const t = new LatencyTracker({ session_id: 's2', surface: 'voice', provider: 'vertex/gemini-live' });
    t.mark('upstream_connected');
    t.setProvider('nova_sonic/amazon.nova-2-sonic-v1:0');
    t.mark('audio_out_first_chunk');
    await t.finalize('success');
    const payload = mockEmitOasisEvent.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.provider).toBe('nova_sonic/amazon.nova-2-sonic-v1:0');
  });

  it('setProvider after finalize is a no-op — the emitted event is already sent', async () => {
    const t = new LatencyTracker({ session_id: 's3', surface: 'voice', provider: 'vertex/gemini-live' });
    await t.finalize('success');
    t.setProvider('nova_sonic/amazon.nova-2-sonic-v1:0'); // too late, event already emitted
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const payload = mockEmitOasisEvent.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.provider).toBe('vertex/gemini-live');
  });

  it('feature-flag off: setProvider is harmless and finalize never emits', async () => {
    mockIsFeatureLive.mockReturnValue(false);
    const t = new LatencyTracker({ session_id: 's4', surface: 'voice', provider: 'vertex/gemini-live' });
    t.setProvider('nova_sonic/amazon.nova-2-sonic-v1:0');
    await t.finalize('success');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});
