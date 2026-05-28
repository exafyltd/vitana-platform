/**
 * Session 4 (autopilot-error-capture) — Phase 1 visibility regression test.
 *
 * The OASIS `autopilot.state.failed` event was emitted with a hardcoded
 * `unknown_error` trigger whenever `markFailed` ran without an errorCode and
 * without an in-memory run (the common case after a gateway restart wipes the
 * in-process `activeRuns` map). The real reason — carried on the originating
 * failure event's message/metadata — was swallowed and never reached the feed
 * or the event payload.
 *
 * This locks in:
 *   1. `deriveFailureTrigger` never collapses to the literal "unknown_error".
 *   2. `extractErrorContext` lifts err.name / err.message / stack-prefix from
 *      Error objects, structured metadata, and bare strings.
 *   3. `markFailed`'s no-run branch emits a meaningful trigger AND structured
 *      error fields (error_name / error_message / stack_prefix) on the payload.
 */

// Mock the OASIS emitter so we can capture the payload without a network call.
const emitted: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (event: any) => {
    emitted.push(event);
    return { ok: true, event_id: 'test-event' };
  }),
}));

import {
  extractErrorContext,
  deriveFailureTrigger,
  markFailed,
} from '../src/services/autopilot-controller';

beforeEach(() => {
  emitted.length = 0;
  // Ensure updateLedgerTerminal short-circuits (no Supabase writes in unit test).
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE;
});

describe('extractErrorContext', () => {
  it('lifts name, message and a stack prefix from an Error', () => {
    const err = new TypeError('boom while routing');
    const ctx = extractErrorContext(err);
    expect(ctx.error_name).toBe('TypeError');
    expect(ctx.error_message).toBe('boom while routing');
    expect(ctx.stack_prefix).toContain('TypeError: boom while routing');
    // Stack prefix must be bounded (we keep the first few lines only).
    expect((ctx.stack_prefix || '').split('\n').length).toBeLessThanOrEqual(4);
  });

  it('reads structured metadata objects', () => {
    const ctx = extractErrorContext({
      error_name: 'WorkerDispatchError',
      error_message: 'no worker available',
      stack: 'a\nb\nc\nd\ne\nf',
    });
    expect(ctx.error_name).toBe('WorkerDispatchError');
    expect(ctx.error_message).toBe('no worker available');
    expect((ctx.stack_prefix || '').split('\n').length).toBeLessThanOrEqual(4);
  });

  it('falls back to the raw string', () => {
    expect(extractErrorContext('plain failure').error_message).toBe('plain failure');
  });
});

describe('deriveFailureTrigger', () => {
  it('prefers an explicit error code', () => {
    expect(deriveFailureTrigger('CI_TIMEOUT', { error_name: 'X' })).toBe('CI_TIMEOUT');
  });

  it('uses the error name when no code is present', () => {
    expect(deriveFailureTrigger(undefined, { error_name: 'WorkerDispatchError' })).toBe(
      'WorkerDispatchError'
    );
  });

  it('compacts a message into a trigger slug when only a message exists', () => {
    const t = deriveFailureTrigger(undefined, {
      error_message: 'no worker available\nfor target role DEV',
    });
    expect(t).toBe('no worker available for target role DEV');
    expect(t).not.toContain('\n');
  });

  it('never returns the legacy hardcoded "unknown_error"', () => {
    expect(deriveFailureTrigger(undefined, {})).toBe('unspecified_failure');
    expect(deriveFailureTrigger('', { source_event_type: 'worker.execution.failed' })).toBe(
      'worker.execution.failed'
    );
  });
});

describe('markFailed (no active run / allocated → failed)', () => {
  it('emits a meaningful trigger and structured error fields instead of unknown_error', async () => {
    await markFailed(
      'VTID-90001',
      'no worker available for target role DEV',
      undefined,
      {
        error_name: 'WorkerDispatchError',
        error_message: 'no worker available for target role DEV',
        stack_prefix: 'WorkerDispatchError: no worker available\n    at dispatch (x.ts:1:1)',
        source_event_type: 'worker.execution.failed',
      }
    );

    const failedEvent = emitted.find((e) => e.type === 'autopilot.state.failed');
    expect(failedEvent).toBeDefined();
    // Feed line is built from the trigger — it must not be the legacy default.
    expect(failedEvent.message).toContain('allocated → failed');
    expect(failedEvent.message).not.toContain('unknown_error');
    expect(failedEvent.payload.trigger).toBe('WorkerDispatchError');
    expect(failedEvent.payload.error_name).toBe('WorkerDispatchError');
    expect(failedEvent.payload.error_message).toContain('no worker available');
    expect(failedEvent.payload.stack_prefix).toContain('WorkerDispatchError');
    expect(failedEvent.payload.source_event_type).toBe('worker.execution.failed');
    expect(failedEvent.payload.no_active_run).toBe(true);
  });

  it('still surfaces a reason when only a bare error string is supplied', async () => {
    await markFailed('VTID-90002', 'spec checksum mismatch');
    const failedEvent = emitted.find(
      (e) => e.type === 'autopilot.state.failed' && e.vtid === 'VTID-90002'
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent.payload.trigger).not.toBe('unknown_error');
    expect(failedEvent.payload.error_message).toBe('spec checksum mismatch');
  });
});
