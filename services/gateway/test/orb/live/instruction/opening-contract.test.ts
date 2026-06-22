/**
 * VTID-03273 Pillar A — decision-table tests for the single Opening Contract.
 * Proves the one authority's speak/silent + source + basis for every branch,
 * including the Pillar-B reconnect→silent synergy and the no-verbatim-repeat
 * guard that kills "the same greeting every session".
 */
import {
  decideOpening,
  formatOpeningDecisionLog,
  assessOpenerQuality,
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

describe('VTID-03273 Pillar D: assessOpenerQuality (content-quality guard)', () => {
  it('accepts concrete, leading openers', () => {
    for (const good of [
      'Lass uns deinen nächsten Schritt im Lebenskompass ansehen.',
      'Let me show you your sleep insights from last night.',
      'Weiter geht’s mit deinem Ernährungs-Check.',
      // Codex review fix: a QUALIFIED "something" names the value — must pass.
      'Let me show you something about your sleep score.',
      'I want to introduce you to something in your profile.',
      'Ich möchte dir etwas über deinen Schlaf zeigen.',
    ]) {
      expect(assessOpenerQuality(good).ok).toBe(true);
    }
  });

  it('rejects preference questions in every supported language', () => {
    for (const bad of [
      'How can I help you?',
      'What would you like to do today?',
      "What's on your mind?",
      'Wie kann ich dir helfen?',
      'Womit kann ich dienen?',
      'Was möchtest du heute machen?',
      'En quoi puis-je vous aider ?',
      '¿En qué puedo ayudarte hoy?',
    ]) {
      const v = assessOpenerQuality(bad);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('forbidden_preference_question');
    }
  });

  it('rejects contentless teasers that name no value/step', () => {
    for (const vague of [
      'I want to introduce you to something.',
      'Let me show you something.',
      'Ich möchte dir etwas zeigen.',
      'Hallo!',
    ]) {
      expect(assessOpenerQuality(vague).ok).toBe(false);
    }
  });

  // BOOTSTRAP-ORB-NO-VAGUE-GREETING — the exact lines the user kept hearing on
  // every reopen must be rejected by the central guard, regardless of which path
  // selects them, so they can never be spoken again.
  it('rejects the banned "next step" teaser in EN and DE', () => {
    for (const banned of [
      'Welcome back. Let me show you your next step.',
      'Let me show you the next step.',
      'Hi again. Let me take you to your next step.',
      'Hallo nochmal. Lass mich dir deinen nächsten Schritt zeigen.',
      'Willkommen zurück. Lass mich dir den nächsten Schritt zeigen.',
      'Ich bin für dich da. Lass mich dich zum nächsten Schritt führen.',
    ]) {
      expect(assessOpenerQuality(banned)).toEqual({ ok: false, reason: 'contentless' });
    }
  });

  // A grounded line that NAMES the concrete step must still pass — the guard is
  // end-anchored so it only catches the bare teaser.
  it('accepts a grounded next-step line that names the concrete step', () => {
    for (const grounded of [
      'Letztes Mal ging es um Vitana Index. Als Nächstes nehmen wir Index verbessern.',
      'Your next step is to track your biomarkers — shall we?',
    ]) {
      expect(assessOpenerQuality(grounded).ok).toBe(true);
    }
  });

  it('rejects lines too short to carry a named next step', () => {
    const v = assessOpenerQuality('Hi.');
    expect(v.ok).toBe(false);
  });

  it('decideOpening downgrades a rejected line to a lead — speak, line=null, source names the reason', () => {
    const d = decideOpening({
      isAnonymous: false, hasResumptionHandle: false, isReconnect: false,
      wakeSelectedLine: 'Wie kann ich dir helfen?',
      wakeSelectedKind: 'voice_wake_brief',
    });
    expect(d.mode).toBe('speak');
    expect(d.line).toBeNull();
    expect(d.source).toBe('wake:voice_wake_brief:quality_forbidden_preference_question');
  });
});
