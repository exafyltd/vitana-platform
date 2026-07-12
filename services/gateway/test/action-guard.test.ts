/**
 * VTID-ASSISTANT-ROLES — action-guard state machine tests.
 *
 * Pins the guard's contract: propose (no confirm) → read-back; confirm →
 * execute exactly once with an OASIS decision event; brake engaged →
 * refuse; rate limit → refuse after N confirmed writes in a minute.
 */

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/system-controls-service', () => ({
  getSystemControl: jest.fn().mockResolvedValue(null), // missing row = enabled
}));

import { runGuardedAction } from '../src/services/orb-tools/action-guard';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { getSystemControl } from '../src/services/system-controls-service';
import type { OrbToolIdentity } from '../src/services/orb-tools-shared';

function identity(sessionId: string): OrbToolIdentity {
  return {
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    role: 'developer',
    session_id: sessionId,
  };
}

describe('runGuardedAction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a read-back and does NOT execute when confirm is absent', async () => {
    const execute = jest.fn();
    const res = await runGuardedAction({}, identity('s1'), {
      tool: 'dev_test_tool',
      tier: 2,
      readBack: 'This will do X.',
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect((res as any).result.requires_confirmation).toBe(true);
    expect((res as any).text).toContain('CONFIRMATION REQUIRED');
    expect((res as any).text).toContain('This will do X.');
    // Proposals are not OASIS decisions — no event.
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });

  it('executes on confirm=true and emits the decision event', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true, text: 'done' });
    const res = await runGuardedAction({ confirm: true }, identity('s2'), {
      tool: 'dev_test_tool',
      tier: 1,
      readBack: 'x',
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(emitOasisEvent).toHaveBeenCalledTimes(1);
    const event = (emitOasisEvent as jest.Mock).mock.calls[0][0];
    expect(event.type).toBe('vtid.decision.assistant_action');
    expect(event.payload.tool).toBe('dev_test_tool');
    expect(event.payload.outcome_ok).toBe(true);
  });

  it('refuses every action when the brake control is explicitly disabled', async () => {
    (getSystemControl as jest.Mock).mockResolvedValueOnce({ key: 'assistant_actions_enabled', enabled: false });
    const execute = jest.fn();
    const res = await runGuardedAction({ confirm: true }, identity('s3'), {
      tool: 'dev_test_tool',
      tier: 1,
      readBack: 'x',
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('assistant_actions_disabled');
  });

  it('treats a missing brake control row as enabled (emergency-brake semantics)', async () => {
    (getSystemControl as jest.Mock).mockResolvedValueOnce(null);
    const execute = jest.fn().mockResolvedValue({ ok: true });
    const res = await runGuardedAction({ confirm: true }, identity('s4'), {
      tool: 'dev_test_tool',
      tier: 1,
      readBack: 'x',
      execute,
    });
    expect(execute).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('rate-limits confirmed writes per session', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true });
    const id = identity('s5-rate');
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      const res = await runGuardedAction({ confirm: true }, id, {
        tool: 'dev_test_tool',
        tier: 1,
        readBack: 'x',
        execute,
      });
      if (res.ok === false && res.error.includes('rate_limited')) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
    expect(execute.mock.calls.length).toBeLessThan(10);
  });

  it('emits a warning decision event when the executed action fails', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: false, error: 'boom' });
    const res = await runGuardedAction({ confirm: true }, identity('s6'), {
      tool: 'dev_test_tool',
      tier: 2,
      readBack: 'x',
      execute,
    });
    expect(res.ok).toBe(false);
    const event = (emitOasisEvent as jest.Mock).mock.calls[0][0];
    expect(event.status).toBe('warning');
    expect(event.payload.outcome_ok).toBe(false);
  });
});
