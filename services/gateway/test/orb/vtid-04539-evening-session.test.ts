/**
 * VTID-04539 — owner's production voice session, 2026-09-25 18:30 CEST.
 *
 * 1. Vitana greeted "Guten Morgen" in the evening. The user's local clock lived
 *    only in ENVIRONMENT CONTEXT, inside the bootstrap, which the instruction
 *    budget drops whole — the model had no clock at all. The clock is now in
 *    the preserved TEMPORAL AND JOURNEY CONTEXT scaffold.
 * 2. She said "you asked yesterday" about a question from seven minutes
 *    earlier: the continuity line mapped 0 days to "gestern".
 * 3. A stalled Nova reply was cut by the watchdog and never reconnected: the
 *    Nova close handler ignored `_stallRecoveryPending`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildLiveSystemInstruction,
  formatLocalClockLine,
} from '../../src/orb/live/instruction/live-system-instruction';
import {
  enforceInstructionBudget,
  decomposeInstructionSections,
  BOOTSTRAP_CONTEXT_START_MARKER,
} from '../../src/orb/live/instruction/instruction-budget';
import { renderLine } from '../../src/services/assistant-continuation/providers/next-action/sources/continuity-pending-thread';
import { shouldRecoverNovaStall } from '../../src/routes/orb-live';

const EVENING = {
  ip: '0.0.0.0',
  timezone: 'Europe/Madrid',
  localTime: 'Thursday evening, 18:30',
  timeOfDay: 'evening',
};

describe('VTID-04539 — the local clock is always in the prompt', () => {
  test('clock line names the local time, zone and time of day', () => {
    const line = formatLocalClockLine(EVENING)!;
    expect(line).toContain('Thursday evening, 18:30');
    expect(line).toContain('Europe/Madrid');
    expect(line).toContain('it is evening for the user');
  });

  test('no clock line without a resolved timezone (never a UTC clock passed off as local)', () => {
    expect(formatLocalClockLine({ localTime: 'Thursday afternoon, 16:30', timeOfDay: 'afternoon' })).toBeNull();
    expect(formatLocalClockLine(undefined)).toBeNull();
  });

  test('the clock survives the instruction budget dropping the whole bootstrap', () => {
    const bootstrap = 'ENVIRONMENT CONTEXT:\nLocal time: Thursday evening, 18:30\n' + 'memory line\n'.repeat(4000);
    const text = buildLiveSystemInstruction(
      'de', 'warm', bootstrap, 'community', undefined, undefined, true,
      { time: new Date(Date.now() - 7 * 60_000).toISOString(), wasFailure: false },
      '/me/profile', [], EVENING as any,
    );
    expect(text).toContain(BOOTSTRAP_CONTEXT_START_MARKER);
    const r = enforceInstructionBudget(decomposeInstructionSections(text), 30_720);
    expect(r.trimmedSections).toContain('bootstrap');
    expect(r.text).not.toContain('memory line');
    expect(r.text).toContain("User's local time right now: Thursday evening, 18:30 (Europe/Madrid)");
  });
});

describe('VTID-04539 — a thread from today is not "yesterday"', () => {
  test('0 days → vorhin / earlier today', () => {
    expect(renderLine('Geburtstag', null, 0, 'de')).toContain('vorhin');
    expect(renderLine('Geburtstag', null, 0, 'de')).not.toContain('gestern');
    expect(renderLine('birthday', null, 0, 'en')).toContain('earlier today');
  });

  test('1 day is still yesterday, more is N days ago', () => {
    expect(renderLine('Geburtstag', null, 1, 'de')).toContain('gestern');
    expect(renderLine('birthday', null, 3, 'en')).toContain('3 days ago');
  });
});

describe('VTID-04539 — Nova reconnects after a watchdog stall', () => {
  const base = { stallRecoveryPending: true, sessionActive: true, rotationInFlight: false };

  test('recovers on the production signature', () => {
    expect(shouldRecoverNovaStall(base)).toBe(true);
  });

  test('does not recover without the watchdog flag, on an ended session, or mid-rotation', () => {
    expect(shouldRecoverNovaStall({ ...base, stallRecoveryPending: false })).toBe(false);
    expect(shouldRecoverNovaStall({ ...base, sessionActive: false })).toBe(false);
    expect(shouldRecoverNovaStall({ ...base, rotationInFlight: true })).toBe(false);
  });

  test('the Nova close handler consults it before the content-filter and premature-close branches', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/orb-live.ts'), 'utf8');
    const onClose = src.indexOf('novaClient.onClose((closeEvent) => {');
    const stall = src.indexOf('if (shouldRecoverNovaStall({', onClose);
    const contentFilter = src.indexOf('const shouldFallbackOnGuidedTopicBlock', onClose);
    const retry = src.indexOf('const shouldRetryNova = shouldRetryNovaOnPrematureClose', onClose);
    expect(onClose).toBeGreaterThan(0);
    expect(stall).toBeGreaterThan(onClose);
    expect(stall).toBeLessThan(contentFilter);
    expect(stall).toBeLessThan(retry);
    const block = src.slice(stall, contentFilter);
    expect(block).toContain('_stallRecoveryPending = false');
    expect(block).toContain('attemptTransparentReconnect(');
    expect(block).toContain("emitConnectionIssue(session, 'upstream_disconnected')");
  });
});
