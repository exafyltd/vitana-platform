/**
 * VTID-03273 Pillar A — decision-table tests for the single Opening Contract.
 * Proves the one authority's speak/silent + source + basis for every branch,
 * including the Pillar-B reconnect→silent synergy and the no-verbatim-repeat
 * guard that kills "the same greeting every session".
 */
import {
  decideOpening,
  formatOpeningDecisionLog,
  OPENING_SOURCE_BASELINE_LEAD,
  type OpeningContext,
} from '../../../../src/orb/live/instruction/opening-contract';

const base: OpeningContext = {
  isAnonymous: false,
  hasResumptionHandle: false,
  isReconnect: false,
};

describe('VTID-03273 Pillar A: decideOpening (single authority)', () => {
  it('reconnect + native resume handle → SILENT (no re-greet, model continues)', () => {
    const d = decideOpening({ ...base, isReconnect: true, hasResumptionHandle: true });
    expect(d.mode).toBe('silent');
    expect(d.source).toBe('native_resume');
    expect(d.basis).toBe('resumed');
  });

  it('reconnect without a handle → SILENT (recovery path owns continuity, never a fresh greeting)', () => {
    const d = decideOpening({ ...base, isReconnect: true, hasResumptionHandle: false });
    expect(d.mode).toBe('silent');
    expect(d.source).toBe('reconnect_no_handle');
    expect(d.basis).toBe('resumed');
  });

  it('fresh open + cadence skip → SILENT', () => {
    const d = decideOpening({ ...base, wakeCadenceSkip: true });
    expect(d.mode).toBe('silent');
    expect(d.source).toBe('cadence_skip');
    expect(d.basis).toBe('fresh');
  });

  it('fresh open + selected wake line → SPEAK that exact line, source names the provider', () => {
    const d = decideOpening({
      ...base,
      wakeSelectedLine: '  Lass uns deinen nächsten Schritt ansehen.  ',
      wakeSelectedKind: 'journey_guide',
    });
    expect(d.mode).toBe('speak');
    expect(d.line).toBe('Lass uns deinen nächsten Schritt ansehen.');
    expect(d.source).toBe('wake:journey_guide');
  });

  it('fresh open + selected line IDENTICAL to last opener → SPEAK but downgrade to a lead (no verbatim replay)', () => {
    const line = 'Lass uns dein Profil gemeinsam vervollständigen.';
    const d = decideOpening({
      ...base,
      wakeSelectedLine: line,
      wakeSelectedKind: 'journey_guide',
      lastOpenerLine: line,
    });
    expect(d.mode).toBe('speak');
    expect(d.line).toBeNull(); // leads via opening-shape matrix instead of replaying
    expect(d.source).toBe('wake:journey_guide:varied');
  });

  it('fresh open + selected line DIFFERENT from last opener → SPEAK it (not a repeat)', () => {
    const d = decideOpening({
      ...base,
      wakeSelectedLine: 'Schön, dass du wieder da bist. Weiter geht’s.',
      wakeSelectedKind: 'new_day_return',
      lastOpenerLine: 'Lass uns dein Profil gemeinsam vervollständigen.',
    });
    expect(d.mode).toBe('speak');
    expect(d.line).toBe('Schön, dass du wieder da bist. Weiter geht’s.');
    expect(d.source).toBe('wake:new_day_return');
  });

  it('fresh open + no selected line → SPEAK, model leads via the opening-shape matrix', () => {
    const d = decideOpening({ ...base });
    expect(d.mode).toBe('speak');
    expect(d.line).toBeNull();
    expect(d.source).toBe(OPENING_SOURCE_BASELINE_LEAD);
    expect(d.basis).toBe('fresh');
  });

  it('reconnect-silence takes precedence over a selected wake line', () => {
    const d = decideOpening({
      ...base,
      isReconnect: true,
      hasResumptionHandle: true,
      wakeSelectedLine: 'should not be spoken on resume',
      wakeSelectedKind: 'journey_guide',
    });
    expect(d.mode).toBe('silent');
    expect(d.source).toBe('native_resume');
  });

  it('formatOpeningDecisionLog emits exactly one greppable line', () => {
    const d = decideOpening({ ...base, wakeSelectedLine: 'Weiter geht’s.', wakeSelectedKind: 'next_action' });
    const log = formatOpeningDecisionLog('sess-1', d);
    expect(log).toContain('[opening-decision]');
    expect(log).toContain('mode=speak');
    expect(log).toContain('source=wake:next_action');
    expect(log).toContain('basis=fresh');
  });
});
