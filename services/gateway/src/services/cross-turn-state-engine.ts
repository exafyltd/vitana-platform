/**
 * Cross-Turn State & Continuity Engine - VTID-01118
 *
 * Deterministic state engine that preserves continuity, focus, and intent persistence
 * across conversation turns. ORB remembers *what we are doing*, not just *what was said*.
 *
 * Position in Intelligence Stack:
 *   D21 Intent → D26 Cross-Turn State → D27+ Intelligence
 *
 * State Types (Canonical):
 *   - Active Intent State (primary + secondary)
 *   - Active Domain State
 *   - Open Task / Thread State
 *   - Pending Decisions
 *   - Unresolved Questions
 *   - User Corrections / Constraints
 *
 * Hard Constraints:
 *   - State may NOT override new intent (D21)
 *   - State may NOT bypass domain routing (D22)
 *   - No long-lived state without confirmation
 *   - State is advisory, not authoritative
 *
 * Determinism Rules:
 *   - Same turn sequence → same state evolution
 *   - No implicit carry-over
 *   - State transitions are rule-based
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Types & Constants
// =============================================================================

/**
 * Intent types that ORB can track
 */
export type IntentType =
  | 'task_creation'
  | 'task_status'
  | 'task_list'
  | 'knowledge_query'
  | 'conversation'
  | 'control'
  | 'correction'
  | 'clarification'
  | 'continuation'
  | 'unknown';

/**
 * Domain types for routing context
 */
export type DomainType =
  | 'autopilot'
  | 'memory'
  | 'knowledge'
  | 'health'
  | 'longevity'
  | 'community'
  | 'lifestyle'
  | 'general';

/**
 * State item status
 */
export type StateItemStatus = 'active' | 'pending_confirmation' | 'expired' | 'completed';

/**
 * Expiry condition for state items
 */
export type ExpiryCondition =
  | 'explicit_completion'      // User explicitly marks complete
  | 'user_override'            // User provides contradicting intent
  | 'inactivity_threshold'     // No mention for N turns
  | 'domain_switch'            // Domain changed with low continuity confidence
  | 'session_end'              // Session explicitly ended
  | 'sensitive_auto_expire';   // Medical/financial auto-expire faster

/**
 * Active Intent State - Primary and secondary intents being tracked
 */
export interface ActiveIntentState {
  id: string;
  type: IntentType;
  description: string;
  confidence: number;           // 0.0 - 1.0
  is_primary: boolean;
  created_turn: number;
  last_confirmed_turn: number;
  expiry_condition: ExpiryCondition;
  status: StateItemStatus;
  related_vtid?: string;        // If intent relates to a specific task
  metadata?: Record<string, unknown>;
}

/**
 * Active Domain State - Current domain context
 */
export interface ActiveDomainState {
  id: string;
  domain: DomainType;
  confidence: number;
  created_turn: number;
  last_confirmed_turn: number;
  expiry_condition: ExpiryCondition;
  status: StateItemStatus;
  routing_decision?: string;    // Which tool/service to route to
}

/**
 * Open Task State - VTIDs being actively discussed or worked on
 */
export interface OpenTaskState {
  id: string;
  vtid: string;
  title: string;
  status: 'mentioned' | 'active' | 'awaiting_input' | 'completed';
  created_turn: number;
  last_confirmed_turn: number;
  expiry_condition: ExpiryCondition;
  pending_action?: string;      // What the system is waiting for
}

/**
 * Pending Decision - Decisions awaiting user input
 */
export interface PendingDecision {
  id: string;
  question: string;
  options: string[];
  context: string;
  created_turn: number;
  last_confirmed_turn: number;
  expiry_condition: ExpiryCondition;
  status: StateItemStatus;
  selected_option?: string;
}

/**
 * Unresolved Question - Questions the user has asked that need follow-up
 */
export interface UnresolvedQuestion {
  id: string;
  question: string;
  topic: string;
  created_turn: number;
  last_confirmed_turn: number;
  expiry_condition: ExpiryCondition;
  status: StateItemStatus;
  partial_answer?: string;
  needs_more_info?: boolean;
}

/**
 * User Correction - Explicit corrections or constraints from the user
 */
export interface UserCorrection {
  id: string;
  correction_type: 'preference' | 'constraint' | 'factual' | 'behavioral';
  original_statement: string;
  corrected_to: string;
  created_turn: number;
  last_confirmed_turn: number;
  expiry_condition: ExpiryCondition;
  status: StateItemStatus;
  applies_to?: string;          // What domain/intent this applies to
}

/**
 * Cross-Turn State Snapshot - Complete state at a given turn
 */
export interface CrossTurnStateSnapshot {
  session_id: string;
  conversation_id: string;
  turn_number: number;
  timestamp: string;

  // Core state items
  active_intents: ActiveIntentState[];
  active_domain: ActiveDomainState | null;
  open_tasks: OpenTaskState[];
  pending_decisions: PendingDecision[];
  unresolved_questions: UnresolvedQuestion[];
  user_corrections: UserCorrection[];

  // Derived state
  focus_vtid: string | null;          // Primary VTID in focus
  focus_summary: string;              // Human-readable focus description
  continuity_confidence: number;      // Overall continuity confidence
}

/**
 * State Transition Event - For audit trail
 */
export interface StateTransitionEvent {
  id: string;
  session_id: string;
  conversation_id: string;
  turn_number: number;
  timestamp: string;
  transition_type: 'created' | 'confirmed' | 'downgraded' | 'expired' | 'reset';
  state_item_type: 'intent' | 'domain' | 'task' | 'decision' | 'question' | 'correction';
  state_item_id: string;
  reason: string;
  old_value?: unknown;
  new_value?: unknown;
}

/**
 * State Update Input - Data from the current turn
 */
export interface StateUpdateInput {
  turn_number: number;
  user_message: string;
  assistant_response?: string;
  detected_intent?: IntentType;
  detected_domain?: DomainType;
  tool_calls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  vtid_mentioned?: string[];
  is_correction?: boolean;
  is_clarification?: boolean;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Expiry thresholds (in turns)
 */
const EXPIRY_CONFIG = {
  // Standard thresholds
  INTENT_INACTIVITY: 5,           // Intent expires after 5 turns without mention
  DOMAIN_INACTIVITY: 7,           // Domain expires after 7 turns
  TASK_INACTIVITY: 10,            // Task reference expires after 10 turns
  DECISION_INACTIVITY: 3,         // Pending decision expires after 3 turns
  QUESTION_INACTIVITY: 5,         // Unresolved question expires after 5 turns
  CORRECTION_INACTIVITY: 20,      // User corrections persist longer

  // Sensitive domain thresholds (faster expiry)
  SENSITIVE_INTENT_INACTIVITY: 2,
  SENSITIVE_TASK_INACTIVITY: 5,

  // Confidence thresholds
  MIN_CONFIDENCE_TO_KEEP: 0.3,
  CONFIDENCE_DECAY_PER_TURN: 0.1,
  DOMAIN_SWITCH_MIN_CONFIDENCE: 0.6,
};

/**
 * Sensitive domains that auto-expire faster
 */
const SENSITIVE_DOMAINS: DomainType[] = ['health', 'longevity'];

// =============================================================================
// State Engine Class
// =============================================================================

/**
 * CrossTurnStateEngine - Manages state across conversation turns
 */
export class CrossTurnStateEngine {
  private session_id: string;
  private conversation_id: string;
  private current_turn: number;
  private state: CrossTurnStateSnapshot;
  private transition_log: StateTransitionEvent[];

  constructor(session_id: string, conversation_id: string) {
    this.session_id = session_id;
    this.conversation_id = conversation_id;
    this.current_turn = 0;
    this.transition_log = [];
    this.state = this.createEmptySnapshot();
  }

  /**
   * Create empty state snapshot
   */
  private createEmptySnapshot(): CrossTurnStateSnapshot {
    return {
      session_id: this.session_id,
      conversation_id: this.conversation_id,
      turn_number: this.current_turn,
      timestamp: new Date().toISOString(),
      active_intents: [],
      active_domain: null,
      open_tasks: [],
      pending_decisions: [],
      unresolved_questions: [],
      user_corrections: [],
      focus_vtid: null,
      focus_summary: 'No active focus',
      continuity_confidence: 1.0,
    };
  }

  /**
   * Get current state snapshot
   */
  getState(): CrossTurnStateSnapshot {
    return { ...this.state };
  }

  /**
   * Get current turn number
   */
  getTurnNumber(): number {
    return this.current_turn;
  }

  /**
   * Get transition log for debugging/audit
   */
  getTransitionLog(): StateTransitionEvent[] {
    return [...this.transition_log];
  }

  // ===========================================================================
  // Core State Update Logic (called on every turn)
  // ===========================================================================

  /**
   * Update state based on current turn input
   * This is the main entry point called after each turn
   */
  async updateState(input: StateUpdateInput): Promise<CrossTurnStateSnapshot> {
    this.current_turn = input.turn_number;
    const previousState = { ...this.state };

    // Step 1: Apply expiry rules to existing state
    await this.applyExpiryRules();

    // Step 2: Decay confidence for unconfirmed items
    this.applyConfidenceDecay();

    // Step 3: Process new intent (if detected)
    if (input.detected_intent) {
      await this.processNewIntent(input);
    }

    // Step 4: Process domain changes
    if (input.detected_domain) {
      await this.processDomainChange(input);
    }

    // Step 5: Process VTID mentions (task context)
    if (input.vtid_mentioned && input.vtid_mentioned.length > 0) {
      await this.processVtidMentions(input.vtid_mentioned);
    }

    // Step 6: Process tool calls (update task states)
    if (input.tool_calls && input.tool_calls.length > 0) {
      await this.processToolCalls(input.tool_calls);
    }

    // Step 7: Process corrections
    if (input.is_correction) {
      await this.processCorrection(input);
    }

    // Step 8: Update derived state
    this.updateDerivedState();

    // Step 9: Update snapshot metadata
    this.state.turn_number = this.current_turn;
    this.state.timestamp = new Date().toISOString();

    // Step 10: Emit state change OASIS event (for traceability)
    await this.emitStateSnapshot(previousState);

    return this.getState();
  }

  // ===========================================================================
  // Expiry Rules (State Lifecycle)
  // ===========================================================================

  /**
   * Apply expiry rules to all state items
   */
  private async applyExpiryRules(): Promise<void> {
    // Expire intents
    this.state.active_intents = await this.filterExpiredItems(
      this.state.active_intents,
      'intent',
      (item) => this.shouldExpireIntent(item)
    );

    // Expire domain if necessary
    if (this.state.active_domain && this.shouldExpireDomain(this.state.active_domain)) {
      await this.logTransition('expired', 'domain', this.state.active_domain.id, 'Inactivity threshold reached');
      this.state.active_domain = null;
    }

    // Expire open tasks
    this.state.open_tasks = await this.filterExpiredItems(
      this.state.open_tasks,
      'task',
      (item) => this.shouldExpireTask(item)
    );

    // Expire pending decisions
    this.state.pending_decisions = await this.filterExpiredItems(
      this.state.pending_decisions,
      'decision',
      (item) => this.shouldExpireDecision(item)
    );

    // Expire unresolved questions
    this.state.unresolved_questions = await this.filterExpiredItems(
      this.state.unresolved_questions,
      'question',
      (item) => this.shouldExpireQuestion(item)
    );

    // Corrections expire much slower, but still apply rules
    this.state.user_corrections = await this.filterExpiredItems(
      this.state.user_corrections,
      'correction',
      (item) => this.shouldExpireCorrection(item)
    );
  }

  /**
   * Generic helper to filter expired items with logging
   */
  private async filterExpiredItems<T extends { id: string }>(
    items: T[],
    type: StateTransitionEvent['state_item_type'],
    shouldExpire: (item: T) => boolean
  ): Promise<T[]> {
    const kept: T[] = [];
    for (const item of items) {
      if (shouldExpire(item)) {
        await this.logTransition('expired', type, item.id, 'Expiry condition met');
      } else {
        kept.push(item);
      }
    }
    return kept;
  }

  /**
   * Check if intent should expire
   */
  private shouldExpireIntent(intent: ActiveIntentState): boolean {
    const turnsSinceConfirmed = this.current_turn - intent.last_confirmed_turn;
    const isSensitive = this.isSensitiveDomain();
    const threshold = isSensitive
      ? EXPIRY_CONFIG.SENSITIVE_INTENT_INACTIVITY
      : EXPIRY_CONFIG.INTENT_INACTIVITY;

    return (
      intent.status === 'expired' ||
      turnsSinceConfirmed > threshold ||
      intent.confidence < EXPIRY_CONFIG.MIN_CONFIDENCE_TO_KEEP
    );
  }

  /**
   * Check if domain should expire
   */
  private shouldExpireDomain(domain: ActiveDomainState): boolean {
    const turnsSinceConfirmed = this.current_turn - domain.last_confirmed_turn;
    return (
      domain.status === 'expired' ||
      turnsSinceConfirmed > EXPIRY_CONFIG.DOMAIN_INACTIVITY ||
      domain.confidence < EXPIRY_CONFIG.MIN_CONFIDENCE_TO_KEEP
    );
  }

  /**
   * Check if task should expire
   */
  private shouldExpireTask(task: OpenTaskState): boolean {
    const turnsSinceConfirmed = this.current_turn - task.last_confirmed_turn;
    const isSensitive = this.isSensitiveDomain();
    const threshold = isSensitive
      ? EXPIRY_CONFIG.SENSITIVE_TASK_INACTIVITY
      : EXPIRY_CONFIG.TASK_INACTIVITY;

    return (
      task.status === 'completed' ||
      turnsSinceConfirmed > threshold
    );
  }

  /**
   * Check if decision should expire
   */
  private shouldExpireDecision(decision: PendingDecision): boolean {
    const turnsSinceConfirmed = this.current_turn - decision.last_confirmed_turn;
    return (
      decision.status === 'expired' ||
      decision.status === 'completed' ||
      turnsSinceConfirmed > EXPIRY_CONFIG.DECISION_INACTIVITY
    );
  }

  /**
   * Check if question should expire
   */
  private shouldExpireQuestion(question: UnresolvedQuestion): boolean {
    const turnsSinceConfirmed = this.current_turn - question.last_confirmed_turn;
    return (
      question.status === 'expired' ||
      question.status === 'completed' ||
      turnsSinceConfirmed > EXPIRY_CONFIG.QUESTION_INACTIVITY
    );
  }

  /**
   * Check if correction should expire
   */
  private shouldExpireCorrection(correction: UserCorrection): boolean {
    const turnsSinceConfirmed = this.current_turn - correction.last_confirmed_turn;
    return (
      correction.status === 'expired' ||
      turnsSinceConfirmed > EXPIRY_CONFIG.CORRECTION_INACTIVITY
    );
  }

  /**
   * Check if current domain is sensitive
   */
  private isSensitiveDomain(): boolean {
    if (!this.state.active_domain) return false;
    return SENSITIVE_DOMAINS.includes(this.state.active_domain.domain);
  }

  // ===========================================================================
  // Confidence Decay
  // ===========================================================================

  /**
   * Apply confidence decay to items not confirmed this turn
   */
  private applyConfidenceDecay(): void {
    // Decay intent confidence
    for (const intent of this.state.active_intents) {
      if (intent.last_confirmed_turn < this.current_turn) {
        intent.confidence = Math.max(
          EXPIRY_CONFIG.MIN_CONFIDENCE_TO_KEEP,
          intent.confidence - EXPIRY_CONFIG.CONFIDENCE_DECAY_PER_TURN
        );
      }
    }

    // Decay domain confidence
    if (this.state.active_domain && this.state.active_domain.last_confirmed_turn < this.current_turn) {
      this.state.active_domain.confidence = Math.max(
        EXPIRY_CONFIG.MIN_CONFIDENCE_TO_KEEP,
        this.state.active_domain.confidence - EXPIRY_CONFIG.CONFIDENCE_DECAY_PER_TURN
      );
    }
  }

  // ===========================================================================
  // Intent Processing
  // ===========================================================================

  /**
   * Process new intent detected in current turn
   * CONSTRAINT: New intent from D21 takes priority - state does NOT override
   */
  private async processNewIntent(input: StateUpdateInput): Promise<void> {
    const newIntent = input.detected_intent!;

    // Check if this intent matches an existing one
    const existingIntent = this.state.active_intents.find(i =>
      i.type === newIntent && i.status === 'active'
    );

    if (existingIntent) {
      // Confirm existing intent (boost confidence, update turn)
      existingIntent.last_confirmed_turn = this.current_turn;
      existingIntent.confidence = Math.min(1.0, existingIntent.confidence + 0.2);
      await this.logTransition('confirmed', 'intent', existingIntent.id, 'Intent reconfirmed');
    } else {
      // Create new intent - D21 takes priority, so we may downgrade existing primary
      const hasPrimary = this.state.active_intents.some(i => i.is_primary && i.status === 'active');

      if (hasPrimary && newIntent !== 'continuation') {
        // Downgrade existing primary to secondary
        for (const intent of this.state.active_intents) {
          if (intent.is_primary && intent.status === 'active') {
            intent.is_primary = false;
            await this.logTransition('downgraded', 'intent', intent.id, 'New primary intent detected');
          }
        }
      }

      // Create new intent state
      const newIntentState: ActiveIntentState = {
        id: randomUUID(),
        type: newIntent,
        description: this.describeIntent(newIntent, input.user_message),
        confidence: 0.9,
        is_primary: newIntent !== 'continuation',
        created_turn: this.current_turn,
        last_confirmed_turn: this.current_turn,
        expiry_condition: 'inactivity_threshold',
        status: 'active',
        related_vtid: input.vtid_mentioned?.[0],
        metadata: { original_message: input.user_message.substring(0, 100) },
      };

      this.state.active_intents.push(newIntentState);
      await this.logTransition('created', 'intent', newIntentState.id, `New ${newIntent} intent`);
    }
  }

  /**
   * Generate human-readable intent description
   */
  private describeIntent(type: IntentType, message: string): string {
    const truncatedMessage = message.substring(0, 50) + (message.length > 50 ? '...' : '');
    switch (type) {
      case 'task_creation': return `Creating a new task: "${truncatedMessage}"`;
      case 'task_status': return `Checking task status`;
      case 'task_list': return `Listing tasks`;
      case 'knowledge_query': return `Knowledge query: "${truncatedMessage}"`;
      case 'conversation': return `General conversation`;
      case 'control': return `System control command`;
      case 'correction': return `Correcting previous information`;
      case 'clarification': return `Clarifying previous topic`;
      case 'continuation': return `Continuing previous discussion`;
      default: return `Unknown intent: "${truncatedMessage}"`;
    }
  }

  // ===========================================================================
  // Domain Processing
  // ===========================================================================

  /**
   * Process domain change
   * CONSTRAINT: Does NOT bypass D22 routing - just tracks context
   */
  private async processDomainChange(input: StateUpdateInput): Promise<void> {
    const newDomain = input.detected_domain!;

    if (this.state.active_domain?.domain === newDomain) {
      // Same domain - confirm
      this.state.active_domain.last_confirmed_turn = this.current_turn;
      this.state.active_domain.confidence = Math.min(1.0, this.state.active_domain.confidence + 0.1);
      return;
    }

    // Domain switch - check continuity confidence
    const oldDomain = this.state.active_domain;
    const continuityConfidence = this.calculateContinuityConfidence(input);

    if (continuityConfidence < EXPIRY_CONFIG.DOMAIN_SWITCH_MIN_CONFIDENCE && oldDomain) {
      // Low confidence domain switch - mark old as expired
      oldDomain.status = 'expired';
      oldDomain.expiry_condition = 'domain_switch';
      await this.logTransition('expired', 'domain', oldDomain.id, `Domain switched to ${newDomain}`);
    }

    // Create new domain state
    const newDomainState: ActiveDomainState = {
      id: randomUUID(),
      domain: newDomain,
      confidence: 0.85,
      created_turn: this.current_turn,
      last_confirmed_turn: this.current_turn,
      expiry_condition: SENSITIVE_DOMAINS.includes(newDomain) ? 'sensitive_auto_expire' : 'inactivity_threshold',
      status: 'active',
    };

    this.state.active_domain = newDomainState;
    await this.logTransition('created', 'domain', newDomainState.id, `Entered ${newDomain} domain`);
  }

  /**
   * Calculate continuity confidence for domain transitions
   */
  private calculateContinuityConfidence(input: StateUpdateInput): number {
    // Factors that increase continuity:
    // - Same VTID mentioned
    // - Clarification/continuation intent
    // - High existing domain confidence

    let confidence = 0.5; // Base

    if (input.is_clarification || input.detected_intent === 'continuation') {
      confidence += 0.3;
    }

    if (input.vtid_mentioned?.some(vtid => this.state.open_tasks.some(t => t.vtid === vtid))) {
      confidence += 0.2;
    }

    if (this.state.active_domain && this.state.active_domain.confidence > 0.8) {
      confidence += 0.1;
    }

    return Math.min(1.0, confidence);
  }

  // ===========================================================================
  // Task Processing
  // ===========================================================================

  /**
   * Process VTID mentions to track open tasks
   */
  private async processVtidMentions(vtids: string[]): Promise<void> {
    for (const vtid of vtids) {
      const existingTask = this.state.open_tasks.find(t => t.vtid === vtid);

      if (existingTask) {
        // Confirm existing task
        existingTask.last_confirmed_turn = this.current_turn;
        if (existingTask.status === 'mentioned') {
          existingTask.status = 'active';
        }
        await this.logTransition('confirmed', 'task', existingTask.id, `VTID ${vtid} reconfirmed`);
      } else {
        // Add new task reference
        const newTask: OpenTaskState = {
          id: randomUUID(),
          vtid,
          title: `Task ${vtid}`, // Will be enriched later
          status: 'mentioned',
          created_turn: this.current_turn,
          last_confirmed_turn: this.current_turn,
          expiry_condition: 'inactivity_threshold',
        };

        this.state.open_tasks.push(newTask);
        await this.logTransition('created', 'task', newTask.id, `VTID ${vtid} mentioned`);
      }
    }

    // Update focus VTID (most recently mentioned)
    if (vtids.length > 0) {
      this.state.focus_vtid = vtids[vtids.length - 1];
    }
  }

  /**
   * Process tool calls to update task states
   */
  private async processToolCalls(toolCalls: StateUpdateInput['tool_calls']): Promise<void> {
    if (!toolCalls) return;

    for (const call of toolCalls) {
      if (call.name === 'autopilot_create_task') {
        const result = call.result as { vtid?: string; title?: string } | undefined;
        if (result?.vtid) {
          // Add newly created task
          const newTask: OpenTaskState = {
            id: randomUUID(),
            vtid: result.vtid,
            title: result.title || `Task ${result.vtid}`,
            status: 'active',
            created_turn: this.current_turn,
            last_confirmed_turn: this.current_turn,
            expiry_condition: 'inactivity_threshold',
            pending_action: 'Awaiting planning',
          };

          this.state.open_tasks.push(newTask);
          this.state.focus_vtid = result.vtid;
          await this.logTransition('created', 'task', newTask.id, `Created ${result.vtid}`);
        }
      } else if (call.name === 'autopilot_get_status') {
        const vtid = (call.args as { vtid?: string })?.vtid;
        if (vtid) {
          const task = this.state.open_tasks.find(t => t.vtid === vtid);
          if (task) {
            task.last_confirmed_turn = this.current_turn;
            task.status = 'active';
          }
        }
      }
    }
  }

  // ===========================================================================
  // Correction Processing
  // ===========================================================================

  /**
   * Process user corrections
   */
  private async processCorrection(input: StateUpdateInput): Promise<void> {
    const correction: UserCorrection = {
      id: randomUUID(),
      correction_type: 'behavioral', // Default, could be detected more precisely
      original_statement: '', // Would need context from previous turn
      corrected_to: input.user_message,
      created_turn: this.current_turn,
      last_confirmed_turn: this.current_turn,
      expiry_condition: 'inactivity_threshold',
      status: 'active',
    };

    this.state.user_corrections.push(correction);
    await this.logTransition('created', 'correction', correction.id, 'User correction recorded');
  }

  // ===========================================================================
  // Derived State
  // ===========================================================================

  /**
   * Update derived state fields
   */
  private updateDerivedState(): void {
    // Calculate overall continuity confidence
    const intentConfidences = this.state.active_intents.map(i => i.confidence);
    const domainConfidence = this.state.active_domain?.confidence || 0.5;
    const avgIntentConfidence = intentConfidences.length > 0
      ? intentConfidences.reduce((a, b) => a + b, 0) / intentConfidences.length
      : 0.5;

    this.state.continuity_confidence = (avgIntentConfidence + domainConfidence) / 2;

    // Generate focus summary
    this.state.focus_summary = this.generateFocusSummary();
  }

  /**
   * Generate human-readable focus summary
   */
  private generateFocusSummary(): string {
    const parts: string[] = [];

    // Primary intent
    const primaryIntent = this.state.active_intents.find(i => i.is_primary && i.status === 'active');
    if (primaryIntent) {
      parts.push(primaryIntent.description);
    }

    // Focus VTID
    if (this.state.focus_vtid) {
      const task = this.state.open_tasks.find(t => t.vtid === this.state.focus_vtid);
      parts.push(`Focus: ${this.state.focus_vtid}${task ? ` (${task.title})` : ''}`);
    }

    // Domain
    if (this.state.active_domain) {
      parts.push(`Domain: ${this.state.active_domain.domain}`);
    }

    // Pending items
    if (this.state.pending_decisions.length > 0) {
      parts.push(`${this.state.pending_decisions.length} pending decision(s)`);
    }

    return parts.length > 0 ? parts.join(' | ') : 'No active focus';
  }

  // ===========================================================================
  // OASIS Event Emission (Traceability)
  // ===========================================================================

  /**
   * Log state transition
   */
  private async logTransition(
    type: StateTransitionEvent['transition_type'],
    itemType: StateTransitionEvent['state_item_type'],
    itemId: string,
    reason: string
  ): Promise<void> {
    const event: StateTransitionEvent = {
      id: randomUUID(),
      session_id: this.session_id,
      conversation_id: this.conversation_id,
      turn_number: this.current_turn,
      timestamp: new Date().toISOString(),
      transition_type: type,
      state_item_type: itemType,
      state_item_id: itemId,
      reason,
    };

    this.transition_log.push(event);

    // Keep transition log bounded
    if (this.transition_log.length > 100) {
      this.transition_log = this.transition_log.slice(-50);
    }
  }

  /**
   * Emit state snapshot to OASIS for traceability
   */
  private async emitStateSnapshot(previousState: CrossTurnStateSnapshot): Promise<void> {
    // Calculate what changed
    const changes = {
      intents_added: this.state.active_intents.length - previousState.active_intents.length,
      tasks_added: this.state.open_tasks.length - previousState.open_tasks.length,
      domain_changed: this.state.active_domain?.domain !== previousState.active_domain?.domain,
      continuity_change: this.state.continuity_confidence - previousState.continuity_confidence,
    };

    await emitOasisEvent({
      vtid: 'VTID-01118',
      type: 'orb.state.snapshot',
      source: 'cross-turn-state-engine',
      status: 'info',
      message: `Turn ${this.current_turn}: ${this.state.focus_summary}`,
      payload: {
        session_id: this.session_id,
        conversation_id: this.conversation_id,
        turn_number: this.current_turn,
        focus_vtid: this.state.focus_vtid,
        active_intents_count: this.state.active_intents.length,
        open_tasks_count: this.state.open_tasks.length,
        continuity_confidence: this.state.continuity_confidence,
        domain: this.state.active_domain?.domain || null,
        changes,
      },
    }).catch(err => console.warn('[VTID-01118] Failed to emit state snapshot:', err.message));
  }

  // ===========================================================================
  // Public API for External Integration
  // ===========================================================================

  /**
   * Mark a task as completed (explicit completion)
   */
  async completeTask(vtid: string): Promise<void> {
    const task = this.state.open_tasks.find(t => t.vtid === vtid);
    if (task) {
      task.status = 'completed';
      task.expiry_condition = 'explicit_completion';
      await this.logTransition('expired', 'task', task.id, 'Explicitly completed');

      // Clear focus if this was the focus task
      if (this.state.focus_vtid === vtid) {
        this.state.focus_vtid = null;
      }
    }
  }

  /**
   * Add a pending decision
   */
  async addPendingDecision(question: string, options: string[], context: string): Promise<string> {
    const decision: PendingDecision = {
      id: randomUUID(),
      question,
      options,
      context,
      created_turn: this.current_turn,
      last_confirmed_turn: this.current_turn,
      expiry_condition: 'inactivity_threshold',
      status: 'active',
    };

    this.state.pending_decisions.push(decision);
    await this.logTransition('created', 'decision', decision.id, 'Pending decision added');
    return decision.id;
  }

  /**
   * Resolve a pending decision
   */
  async resolveDecision(decisionId: string, selectedOption: string): Promise<void> {
    const decision = this.state.pending_decisions.find(d => d.id === decisionId);
    if (decision) {
      decision.selected_option = selectedOption;
      decision.status = 'completed';
      await this.logTransition('expired', 'decision', decision.id, `Resolved: ${selectedOption}`);
    }
  }

  /**
   * Force expire all state (e.g., on session end)
   */
  async expireAll(): Promise<void> {
    for (const intent of this.state.active_intents) {
      intent.status = 'expired';
      intent.expiry_condition = 'session_end';
      await this.logTransition('expired', 'intent', intent.id, 'Session ended');
    }

    if (this.state.active_domain) {
      this.state.active_domain.status = 'expired';
      await this.logTransition('expired', 'domain', this.state.active_domain.id, 'Session ended');
    }

    for (const task of this.state.open_tasks) {
      if (task.status !== 'completed') {
        await this.logTransition('expired', 'task', task.id, 'Session ended');
      }
    }

    // Clear state
    this.state = this.createEmptySnapshot();
    this.state.focus_summary = 'Session ended';
  }

  /**
   * Generate context string for system prompt injection
   */
  generateContextString(): string {
    if (this.state.active_intents.length === 0 && !this.state.focus_vtid) {
      return '';
    }

    const lines: string[] = ['<CROSS_TURN_CONTEXT>'];

    // Primary intent
    const primaryIntent = this.state.active_intents.find(i => i.is_primary && i.status === 'active');
    if (primaryIntent) {
      lines.push(`Current Focus: ${primaryIntent.description}`);
    }

    // Focus VTID
    if (this.state.focus_vtid) {
      const task = this.state.open_tasks.find(t => t.vtid === this.state.focus_vtid);
      lines.push(`Active Task: ${this.state.focus_vtid}${task?.pending_action ? ` (${task.pending_action})` : ''}`);
    }

    // Open tasks (other than focus)
    const otherTasks = this.state.open_tasks.filter(t => t.vtid !== this.state.focus_vtid && t.status === 'active');
    if (otherTasks.length > 0) {
      lines.push(`Other Active Tasks: ${otherTasks.map(t => t.vtid).join(', ')}`);
    }

    // Pending decisions
    if (this.state.pending_decisions.length > 0) {
      for (const decision of this.state.pending_decisions.slice(0, 2)) {
        lines.push(`Pending: ${decision.question}`);
      }
    }

    // User corrections (apply as constraints)
    const recentCorrections = this.state.user_corrections.filter(c => c.status === 'active').slice(0, 3);
    if (recentCorrections.length > 0) {
      lines.push('User Preferences:');
      for (const correction of recentCorrections) {
        lines.push(`  - ${correction.corrected_to}`);
      }
    }

    lines.push('</CROSS_TURN_CONTEXT>');

    return lines.join('\n');
  }
}

// =============================================================================
// Session State Store
// =============================================================================

/**
 * In-memory store for state engines (session-scoped)
 */
const stateEngines = new Map<string, CrossTurnStateEngine>();

/**
 * Get or create state engine for a conversation
 */
export function getStateEngine(session_id: string, conversation_id: string): CrossTurnStateEngine {
  const key = `${session_id}:${conversation_id}`;
  let engine = stateEngines.get(key);

  if (!engine) {
    engine = new CrossTurnStateEngine(session_id, conversation_id);
    stateEngines.set(key, engine);
    console.log(`[VTID-01118] Created state engine for ${key}`);
  }

  return engine;
}

/**
 * Remove state engine (on session end)
 */
export async function removeStateEngine(session_id: string, conversation_id: string): Promise<void> {
  const key = `${session_id}:${conversation_id}`;
  const engine = stateEngines.get(key);

  if (engine) {
    await engine.expireAll();
    stateEngines.delete(key);
    console.log(`[VTID-01118] Removed state engine for ${key}`);
  }
}

/**
 * Cleanup expired state engines
 */
export function cleanupExpiredStateEngines(maxAgeTurns: number = 50): void {
  const now = Date.now();
  for (const [key, engine] of stateEngines.entries()) {
    // Remove engines that haven't been updated in a while
    // (In production, this would check actual timestamps)
    if (engine.getTurnNumber() === 0) {
      stateEngines.delete(key);
      console.log(`[VTID-01118] Cleaned up inactive engine: ${key}`);
    }
  }
}

// Cleanup interval (every 10 minutes)
setInterval(() => cleanupExpiredStateEngines(), 10 * 60 * 1000);

// =============================================================================
// Intent Detection Helper
// =============================================================================

/**
 * Detect intent type from user message
 * This is a lightweight classifier - D21 would have more sophisticated detection
 */
export function detectIntentType(message: string, toolCalls?: Array<{ name: string }>): IntentType {
  const lowerMessage = message.toLowerCase().trim();

  // Check tool calls first (high confidence)
  if (toolCalls && toolCalls.length > 0) {
    const toolName = toolCalls[0].name;
    if (toolName === 'autopilot_create_task') return 'task_creation';
    if (toolName === 'autopilot_get_status') return 'task_status';
    if (toolName === 'autopilot_list_recent_tasks') return 'task_list';
    if (toolName === 'knowledge_search') return 'knowledge_query';
  }

  // Keyword-based detection
  if (lowerMessage.match(/\b(create|new|add)\s+(a\s+)?task\b/)) return 'task_creation';
  if (lowerMessage.match(/\bstatus\s+(of\s+)?vtid/i) || lowerMessage.match(/vtid-\d{4,5}/i)) return 'task_status';
  if (lowerMessage.match(/\b(list|show|recent)\s+task/)) return 'task_list';
  if (lowerMessage.match(/^(what|how|explain|why|tell me about)/i)) return 'knowledge_query';
  if (lowerMessage.match(/^(no|actually|i meant|correction|that's wrong)/i)) return 'correction';
  if (lowerMessage.match(/^(also|and|plus|additionally|what about)/i)) return 'continuation';
  if (lowerMessage.match(/^(can you clarify|what do you mean|explain that)/i)) return 'clarification';

  return 'conversation';
}

/**
 * Detect domain type from message and tools
 */
export function detectDomainType(message: string, toolCalls?: Array<{ name: string }>): DomainType {
  const lowerMessage = message.toLowerCase();

  // Check tool calls
  if (toolCalls && toolCalls.length > 0) {
    const toolName = toolCalls[0].name;
    if (toolName.startsWith('autopilot_')) return 'autopilot';
    if (toolName === 'knowledge_search') return 'knowledge';
  }

  // Keyword detection
  if (lowerMessage.match(/\b(health|medical|doctor|symptom)/)) return 'health';
  if (lowerMessage.match(/\b(longevity|lifespan|aging|vitality)/)) return 'longevity';
  if (lowerMessage.match(/\b(community|social|group|connect)/)) return 'community';
  if (lowerMessage.match(/\b(lifestyle|habit|routine|daily)/)) return 'lifestyle';
  if (lowerMessage.match(/\b(task|vtid|autopilot|plan|execute)/)) return 'autopilot';
  if (lowerMessage.match(/\b(remember|memory|diary|personal)/)) return 'memory';

  return 'general';
}

/**
 * Extract VTID mentions from message
 */
export function extractVtidMentions(message: string): string[] {
  const matches = message.match(/VTID-\d{4,5}/gi) || [];
  return [...new Set(matches.map(m => m.toUpperCase()))];
}

// =============================================================================
// Exports
// =============================================================================

export {
  EXPIRY_CONFIG,
  SENSITIVE_DOMAINS,
};
