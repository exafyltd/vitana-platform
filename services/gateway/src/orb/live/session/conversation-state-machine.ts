/**
 * VTID-03273 Pillar C — the explicit, testable conversation state machine.
 *
 * The spec (docs/GOVERNANCE/CONVERSATIONAL-FLOW-SPEC.md §1 Pillar C) requires:
 *
 *   PREWARM → OPENING → (LISTENING ⇄ THINKING ⇄ SPEAKING)
 *
 * with an ORTHOGONAL recovery axis:
 *
 *   RECONNECTING → RESUMED   (always returns to the PRIOR state — never OPENING)
 *
 * `openingDelivered` is a property of the state, not a flag scattered across six
 * call sites (the old `greetingSent` boolean). The opener fires EXACTLY ONCE,
 * in OPENING, for the life of the conversation, no matter how many connections
 * it spans — the structural guarantee behind "never re-greet after reconnect".
 *
 * This module is pure (no I/O) so the §4 Tier-0/1 suites can prove the
 * transition table and the opening-once invariant directly. The session layer
 * holds ONE instance per conversation and asks it whether an opener may be
 * delivered, instead of reading/writing greetingSent in many places.
 */

export type ConversationState =
  | 'PREWARM'
  | 'OPENING'
  | 'LISTENING'
  | 'THINKING'
  | 'SPEAKING'
  | 'RECONNECTING'
  | 'RESUMED';

/** The active (non-recovery) states the machine returns to after a reconnect. */
export type ActiveState = 'OPENING' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export interface StateTransition {
  from: ConversationState;
  to: ConversationState;
  at: number;
  reason?: string;
}

/** Allowed forward transitions on the primary axis. */
const PRIMARY_NEXT: Record<ConversationState, ReadonlyArray<ConversationState>> = {
  PREWARM: ['OPENING', 'RECONNECTING'],
  // OPENING delivers the (single) opener, then hands off to the live loop.
  OPENING: ['LISTENING', 'THINKING', 'SPEAKING', 'RECONNECTING'],
  LISTENING: ['THINKING', 'SPEAKING', 'LISTENING', 'RECONNECTING'],
  THINKING: ['SPEAKING', 'LISTENING', 'THINKING', 'RECONNECTING'],
  SPEAKING: ['LISTENING', 'THINKING', 'SPEAKING', 'RECONNECTING'],
  // Recovery axis: RECONNECTING → RESUMED → (prior active state).
  RECONNECTING: ['RESUMED', 'RECONNECTING'],
  RESUMED: ['LISTENING', 'THINKING', 'SPEAKING', 'RECONNECTING'],
};

export class ConversationStateMachine {
  private _state: ConversationState = 'PREWARM';
  private _openingDelivered = false;
  /** The active state we were in when a reconnect started (to return to). */
  private _stateBeforeReconnect: ActiveState | null = null;
  private readonly _history: StateTransition[] = [];

  get state(): ConversationState {
    return this._state;
  }

  get openingDelivered(): boolean {
    return this._openingDelivered;
  }

  get history(): ReadonlyArray<StateTransition> {
    return this._history;
  }

  /**
   * Pillar C invariant: an opener may be delivered ONLY in OPENING and ONLY
   * once for the life of the conversation. Every other state — including
   * RESUMED after a reconnect — returns false, which is what structurally
   * forbids the re-greet.
   */
  canDeliverOpening(): boolean {
    return this._state === 'OPENING' && !this._openingDelivered;
  }

  /**
   * Mark the single opener as delivered (whether spoken or intentionally
   * silent). Only legal in OPENING — a call from any other state (PREWARM,
   * RESUMED, a recovery path, …) returns false and does NOT consume the opener,
   * so the once-in-OPENING invariant cannot be defeated by a stray/early call
   * (Codex review fix). Idempotent within OPENING.
   */
  markOpeningDelivered(): boolean {
    if (this._state !== 'OPENING') return false;
    if (this._openingDelivered) return false;
    this._openingDelivered = true;
    return true;
  }

  /** Whether `to` is a legal transition from the current state. */
  canTransition(to: ConversationState): boolean {
    return PRIMARY_NEXT[this._state].includes(to);
  }

  /**
   * Apply a transition. Returns true if applied, false if illegal (the machine
   * stays put and records nothing — callers fail loud, never silently corrupt
   * the state). Reconnect bookkeeping is automatic:
   *   - entering RECONNECTING from an active state remembers that state;
   *   - RESUMED → an active state always returns to the remembered one.
   */
  transition(to: ConversationState, reason?: string): boolean {
    if (!this.canTransition(to)) return false;

    if (to === 'RECONNECTING' && this._state !== 'RECONNECTING') {
      if (isActiveState(this._state)) this._stateBeforeReconnect = this._state;
    }

    const at = Date.now();
    this._history.push({ from: this._state, to, at, reason });
    this._state = to;
    return true;
  }

  /**
   * Convenience for the recovery path: go RESUMED and then back to the active
   * state we held before the reconnect (never OPENING — the opener is already
   * delivered, so resuming must not re-open). Defaults to LISTENING if no prior
   * active state was recorded.
   */
  resumeToPriorState(reason?: string): ConversationState {
    if (this._state === 'RECONNECTING') this.transition('RESUMED', reason);
    const target: ActiveState = this._stateBeforeReconnect ?? 'LISTENING';
    // RESUMED → OPENING is intentionally NOT allowed; coerce to LISTENING.
    const safeTarget: ActiveState = target === 'OPENING' ? 'LISTENING' : target;
    this.transition(safeTarget, reason ?? 'resume_to_prior');
    return this._state;
  }
}

export function isActiveState(s: ConversationState): s is ActiveState {
  return s === 'OPENING' || s === 'LISTENING' || s === 'THINKING' || s === 'SPEAKING';
}
