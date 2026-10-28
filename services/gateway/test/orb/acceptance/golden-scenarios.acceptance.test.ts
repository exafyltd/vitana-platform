/**
 * VTID-03273 Phase 3 — the §2 GOLDEN SCENARIOS as a CI gate.
 *
 * The conversational-flow spec (docs/GOVERNANCE/CONVERSATIONAL-FLOW-SPEC.md §2)
 * defines six scenarios that MUST pass before any conversational-flow change
 * ships. This suite encodes scenarios 1–4 + 6 at the decision level (the pure
 * Opening Contract + state machine — the layers every flow change passes
 * through), so a regression turns CI red before it can reach a user.
 *
 * Scenario 5 (silent-mode iPhone audible — Web Audio ignores the mute switch,
 * VTID-03272) is device-level and is covered by the live E2E harness
 * (vitana-v1 tests/e2e/orb-preview.mjs, run against preview.vitanaland.com),
 * which asserts real audio/greeting signals in a real browser.
 */
import {
  decideOpening,
  assessOpenerQuality,
  formatOpeningDecisionLog,
} from '../../../src/orb/live/instruction/opening-contract';
import { ConversationStateMachine } from '../../../src/orb/live/session/conversation-state-machine';

const fresh = { isAnonymous: false, hasResumptionHandle: false, isReconnect: false };

describe('VTID-03273 §2 GOLDEN SCENARIOS (CI gate)', () => {
  it('1. Fresh open → ONE concrete, leading opener (named next step, no preference question)', () => {
    const d = decideOpening({
      ...fresh,
      wakeSelectedLine: 'Lass uns deinen nächsten Schritt im Lebenskompass ansehen.',
      wakeSelectedKind: 'journey_guide',
    });
    expect(d.mode).toBe('speak');
    expect(d.basis).toBe('fresh');
    // The spoken line is concrete: it passed the Pillar-D quality guard.
    expect(d.line).toBe('Lass uns deinen nächsten Schritt im Lebenskompass ansehen.');
    expect(assessOpenerQuality(d.line!).ok).toBe(true);
    // And it is the contract's line — exactly one authority decided it.
    expect(d.source).toBe('wake:journey_guide');
  });

  it('1b. Fresh open with a FORBIDDEN opener selected → still speaks, but as a concrete lead (never "how can I help")', () => {
    for (const bad of [
      'How can I help you today?',
      'Wie kann ich dir helfen?',
      "What's on your mind?",
      'What would you like to talk about?',
    ]) {
      const d = decideOpening({ ...fresh, wakeSelectedLine: bad, wakeSelectedKind: 'voice_wake_brief' });
      expect(d.mode).toBe('speak');
      expect(d.line).toBeNull(); // the forbidden line is NEVER spoken verbatim
      expect(d.source).toContain('quality_forbidden_preference_question');
    }
  });

  it('1c. Fresh open with a CONTENTLESS opener selected → downgraded to a concrete lead', () => {
    for (const vague of [
      'I want to introduce you to something.',
      'Let me show you something.',
      'Ich möchte dir etwas zeigen.',
      'Hello!',
    ]) {
      const d = decideOpening({ ...fresh, wakeSelectedLine: vague, wakeSelectedKind: 'feature_discovery_teacher' });
      expect(d.mode).toBe('speak');
      expect(d.line).toBeNull();
      expect(d.source).toMatch(/quality_(contentless|too_short)/);
    }
  });

  it('2. Reopen < 10 min → silent continuation, never the full-summary repeat', () => {
    // The journey_guide recency gate / greeting policy report a cadence skip;
    // the contract honors it with silence — no opener, no summary replay.
    const d = decideOpening({ ...fresh, wakeCadenceSkip: true });
    expect(d.mode).toBe('silent');
    expect(d.source).toBe('cadence_skip');
  });

  it('2b. Same opener re-selected on the next session → varied lead, never the identical line again', () => {
    const line = 'Lass uns dein Profil gemeinsam vervollständigen.';
    const d = decideOpening({
      ...fresh,
      wakeSelectedLine: line,
      wakeSelectedKind: 'journey_guide',
      lastOpenerLine: line,
    });
    expect(d.mode).toBe('speak');
    expect(d.line).toBeNull(); // word-for-word replay is structurally impossible
    expect(d.source).toBe('wake:journey_guide:varied');
  });

  it('3. Reconnect mid-greeting → resumes the SAME thread; never re-greets; never generic', () => {
    const sm = new ConversationStateMachine();
    sm.transition('OPENING', 'session_start');
    sm.markOpeningDelivered(); // greeting was being delivered when the drop hit
    sm.transition('RECONNECTING', 'upstream_drop');
    const resumed = sm.resumeToPriorState('native_resume');
    // Never back to OPENING — the opener cannot replay.
    expect(resumed).not.toBe('OPENING');
    expect(sm.canDeliverOpening()).toBe(false);
    // And the contract for that reconnect is SILENT (native resume carries the thread).
    const d = decideOpening({ isAnonymous: false, hasResumptionHandle: true, isReconnect: true });
    expect(d.mode).toBe('silent');
    expect(d.source).toBe('native_resume');
    expect(d.basis).toBe('resumed');
  });

  it('4. Reconnect after a user turn → continues the answer; never "what can I help you with"', () => {
    const sm = new ConversationStateMachine();
    sm.transition('OPENING');
    sm.markOpeningDelivered();
    sm.transition('LISTENING');
    sm.transition('THINKING'); // the user had asked; we were answering
    sm.transition('RECONNECTING', 'upstream_drop');
    expect(sm.resumeToPriorState('native_resume')).toBe('THINKING'); // continues the answer
    // The contract refuses an opener on this reconnect — with or without a handle.
    expect(decideOpening({ isAnonymous: false, hasResumptionHandle: true, isReconnect: true }).mode).toBe('silent');
    expect(decideOpening({ isAnonymous: false, hasResumptionHandle: false, isReconnect: true }).mode).toBe('silent');
    // And "what can I help you with" can never be a sanctioned verbatim opener anywhere:
    expect(assessOpenerQuality('What can I do for you?').ok).toBe(false);
  });

  it('6. Exactly one opening decision per conversation, naming source + speak/silent + fresh/resumed', () => {
    const sm = new ConversationStateMachine();
    sm.transition('OPENING');
    // First (and only) legal delivery window:
    expect(sm.canDeliverOpening()).toBe(true);
    const d = decideOpening({ ...fresh, wakeSelectedLine: 'Weiter geht’s mit deinem Schlaf-Check.', wakeSelectedKind: 'next_action' });
    const log = formatOpeningDecisionLog('sess-golden', d);
    expect(log).toMatch(/^\[opening-decision\] session=sess-golden mode=speak source=wake:next_action basis=fresh/);
    sm.markOpeningDelivered();
    // Every later window in the conversation's life refuses a second opening:
    expect(sm.canDeliverOpening()).toBe(false);
    sm.transition('LISTENING');
    sm.transition('RECONNECTING');
    sm.resumeToPriorState();
    expect(sm.canDeliverOpening()).toBe(false);
    expect(sm.openingDelivered).toBe(true);
  });
});
