/**
 * VTID-03273 Pillar C — transition-table + opening-once invariant tests for the
 * explicit conversation state machine.
 */
import {
  ConversationStateMachine,
  isActiveState,
} from '../../../../src/orb/live/session/conversation-state-machine';

describe('VTID-03273 Pillar C: ConversationStateMachine', () => {
  it('starts in PREWARM with no opening delivered', () => {
    const m = new ConversationStateMachine();
    expect(m.state).toBe('PREWARM');
    expect(m.openingDelivered).toBe(false);
    expect(m.canDeliverOpening()).toBe(false); // not yet in OPENING
  });

  it('PREWARM → OPENING enables the single opener exactly once', () => {
    const m = new ConversationStateMachine();
    expect(m.transition('OPENING')).toBe(true);
    expect(m.canDeliverOpening()).toBe(true);
    expect(m.markOpeningDelivered()).toBe(true);
    expect(m.openingDelivered).toBe(true);
    expect(m.canDeliverOpening()).toBe(false); // delivered — never again
    expect(m.markOpeningDelivered()).toBe(false); // idempotent
  });

  it('markOpeningDelivered() outside OPENING is a no-op (cannot consume the opener early)', () => {
    const m = new ConversationStateMachine();
    // PREWARM — illegal to deliver yet.
    expect(m.markOpeningDelivered()).toBe(false);
    expect(m.openingDelivered).toBe(false);
    m.transition('OPENING');
    // Now legal — and still available because the early call did NOT consume it.
    expect(m.canDeliverOpening()).toBe(true);
    expect(m.markOpeningDelivered()).toBe(true);
    // After moving past OPENING, a late call is also a no-op.
    m.transition('SPEAKING');
    expect(m.markOpeningDelivered()).toBe(false);
  });

  it('runs the live loop LISTENING ⇄ THINKING ⇄ SPEAKING', () => {
    const m = new ConversationStateMachine();
    m.transition('OPENING');
    m.markOpeningDelivered();
    expect(m.transition('LISTENING')).toBe(true);
    expect(m.transition('THINKING')).toBe(true);
    expect(m.transition('SPEAKING')).toBe(true);
    expect(m.transition('LISTENING')).toBe(true);
  });

  it('a reconnect from an active state RESUMES to that SAME state, never OPENING', () => {
    const m = new ConversationStateMachine();
    m.transition('OPENING');
    m.markOpeningDelivered();
    m.transition('THINKING'); // we were thinking when the drop happened
    expect(m.transition('RECONNECTING')).toBe(true);
    const resumed = m.resumeToPriorState();
    expect(resumed).toBe('THINKING'); // returned to prior state
    expect(m.state).toBe('THINKING');
    expect(m.openingDelivered).toBe(true); // still delivered — no re-greet
    expect(m.canDeliverOpening()).toBe(false);
  });

  it('reconnect mid-OPENING resumes to LISTENING, NOT back to OPENING (opener not replayed)', () => {
    const m = new ConversationStateMachine();
    m.transition('OPENING');
    m.markOpeningDelivered();
    m.transition('RECONNECTING');
    const resumed = m.resumeToPriorState();
    expect(resumed).toBe('LISTENING'); // coerced away from OPENING
    expect(m.canDeliverOpening()).toBe(false);
  });

  it('RESUMED can never transition to OPENING', () => {
    const m = new ConversationStateMachine();
    m.transition('OPENING');
    m.transition('SPEAKING');
    m.transition('RECONNECTING');
    m.transition('RESUMED');
    expect(m.canTransition('OPENING')).toBe(false);
    expect(m.transition('OPENING')).toBe(false);
    expect(m.state).toBe('RESUMED');
  });

  it('rejects illegal transitions and stays put (fail loud, no silent corruption)', () => {
    const m = new ConversationStateMachine();
    expect(m.transition('SPEAKING')).toBe(false); // PREWARM cannot jump to SPEAKING
    expect(m.state).toBe('PREWARM');
    expect(m.history).toHaveLength(0);
  });

  it('records a transition history for the Command Hub inspector', () => {
    const m = new ConversationStateMachine();
    m.transition('OPENING', 'session_start');
    m.transition('LISTENING', 'opener_done');
    expect(m.history.map((h) => `${h.from}->${h.to}`)).toEqual([
      'PREWARM->OPENING',
      'OPENING->LISTENING',
    ]);
    expect(m.history[0].reason).toBe('session_start');
  });

  it('isActiveState classifies the primary-axis states', () => {
    expect(isActiveState('OPENING')).toBe(true);
    expect(isActiveState('LISTENING')).toBe(true);
    expect(isActiveState('THINKING')).toBe(true);
    expect(isActiveState('SPEAKING')).toBe(true);
    expect(isActiveState('PREWARM')).toBe(false);
    expect(isActiveState('RECONNECTING')).toBe(false);
    expect(isActiveState('RESUMED')).toBe(false);
  });
});
