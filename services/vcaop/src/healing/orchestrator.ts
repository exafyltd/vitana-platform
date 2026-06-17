/**
 * Self-healing orchestrator (runbook self-healing plan — SELF-HEALING-PLAN.md).
 *
 * detect → diagnose(category) → bounded escalating remediation ladder → verify
 * (re-probe) → restore known-good, OR escalate to a human when the ladder is
 * exhausted. Mirrors the voice↔voice Vertex/LiveKit auto-recovery: bring a
 * previously-working component back to its working state without a human; page a
 * human only as the last resort.
 *
 * Hard invariants (never overridden):
 *  - a `guardrail` failure is NEVER auto-healed → immediate escalate + freeze
 *  - the orchestrator only calls REGISTERED, safe primitives (no prod/destructive
 *    action lives in the ladder); a primitive may throw NeedsEscalation to bail out
 *  - bounded attempts + backoff (no thrashing); every step emits an OASIS event
 *  - self-improvement may only reorder/learn safe remedies, never invent unsafe ones
 */
import { OasisSink } from '../api/oasis-sink';
import { EmitHumanTask } from '../guardrails/human-gate';

export type FailureCategory = 'transient' | 'service' | 'schema' | 'config' | 'dependency' | 'guardrail';

export interface FailedCheck {
  name: string;
  category: FailureCategory;
  detail?: string;
}

export interface ProbeResult {
  ok: boolean;
  failed: FailedCheck[];
}

/** A health probe: returns current health. Injected so it's testable + swappable. */
export type Probe = () => Promise<ProbeResult>;

/** Raised by a remediation primitive that cannot safely proceed (→ escalate). */
export class NeedsEscalation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsEscalation';
  }
}

export interface RemediationStep {
  name: string;
  /** The safe recovery action. Undefined ⇒ primitive unavailable (skip → escalate). */
  action?: () => Promise<void>;
}

export type RemediationLadder = Record<FailureCategory, RemediationStep[]>;

/** Recovery primitives (mock in dev/tests; real impls — rollback/reseed/etc. — drop in later). */
export interface HealPrimitives {
  rollbackToLastGoodRevision?: () => Promise<void>;
  runDownMigration?: () => Promise<void>;
  reseedPolicies?: () => Promise<void>;
  degradeConnector?: () => Promise<void>;
  retry?: () => Promise<void>;
}

export interface OrchestratorOptions {
  oasis: OasisSink;
  emitHumanTask: EmitHumanTask;
  /** Called on escalation (e.g. open a vcaop-health issue / page on-call). */
  onEscalate?: (incident: Incident) => Promise<void> | void;
  /** Max attempts per ladder step (default 1; transient may set higher). */
  maxAttemptsPerStep?: number;
  /** Backoff between attempts (ms; 0 in tests). */
  backoffMs?: number;
  /** Build the ladder from primitives; defaults to `defaultLadder`. */
  ladder?: RemediationLadder;
}

export interface Incident {
  signature: string;
  category: FailureCategory;
  failed: FailedCheck[];
  attempts: number;
}

export type HealOutcome =
  | { status: 'healthy' }
  | { status: 'recovered'; remediator: string; attempts: number; frozen: false }
  | { status: 'escalated'; reason: 'guardrail' | 'exhausted' | 'no_primitive'; attempts: number; frozen: true };

/** Default remediation ladder per SELF-HEALING-PLAN.md §4. guardrail = empty (never auto-heal). */
export function defaultLadder(p: HealPrimitives): RemediationLadder {
  return {
    transient: [{ name: 'retry', action: p.retry ?? (async () => {}) }],
    service: [{ name: 'rollback-last-good-revision', action: p.rollbackToLastGoodRevision }],
    schema: [{ name: 'down-migration', action: p.runDownMigration }],
    config: [{ name: 'reseed-policies', action: p.reseedPolicies }],
    dependency: [{ name: 'degrade-connector', action: p.degradeConnector }],
    guardrail: [],
  };
}

function signatureOf(failed: FailedCheck[]): string {
  return failed.map((f) => f.name).sort().join('|');
}

export class SelfHealingOrchestrator {
  private readonly memory = new Map<string, string>(); // signature -> remediator name that worked
  private frozen = false;

  constructor(private readonly probe: Probe, private readonly opts: OrchestratorOptions) {}

  isFrozen(): boolean {
    return this.frozen;
  }

  /** Run one detect→heal cycle. Idempotent and safe to call on a schedule. */
  async runCycle(): Promise<HealOutcome> {
    const first = await this.probe();
    if (first.ok) return { status: 'healthy' };

    const category = first.failed[0].category;
    const signature = signatureOf(first.failed);
    const incident: Incident = { signature, category, failed: first.failed, attempts: 0 };

    await this.emit('vcaop.heal.detected', 'warning', `health failure (${category})`, { signature, category, checks: first.failed.map((f) => f.name) });

    // Guardrail failures are NEVER auto-healed.
    if (first.failed.some((f) => f.category === 'guardrail')) {
      return this.escalate(incident, 'guardrail');
    }

    let ladder = this.opts.ladder ?? defaultLadder({});
    let steps = [...(ladder[category] ?? [])];

    // Self-improvement: if we've seen this signature, try the remedy that worked first.
    const known = this.memory.get(signature);
    if (known) steps.sort((a, b) => (a.name === known ? -1 : b.name === known ? 1 : 0));

    const maxAttempts = this.opts.maxAttemptsPerStep ?? 1;
    let attempts = 0;

    for (const step of steps) {
      if (!step.action) continue; // primitive unavailable → can't perform this tier
      for (let a = 0; a < maxAttempts; a++) {
        attempts++;
        await this.emit('vcaop.heal.remediating', 'info', `remediation: ${step.name}`, { signature, step: step.name, attempt: a + 1 });
        try {
          await step.action();
        } catch (e) {
          if (e instanceof NeedsEscalation) {
            incident.attempts = attempts;
            return this.escalate(incident, 'exhausted');
          }
          continue; // action failed; re-probe will still run / next attempt
        }
        if (this.opts.backoffMs) await new Promise((r) => setTimeout(r, this.opts.backoffMs));
        const re = await this.probe();
        if (re.ok) {
          this.memory.set(signature, step.name); // learn
          await this.emit('vcaop.heal.recovered', 'success', `recovered via ${step.name}`, { signature, remediator: step.name, attempts });
          return { status: 'recovered', remediator: step.name, attempts, frozen: false };
        }
      }
    }

    incident.attempts = attempts;
    return this.escalate(incident, attempts === 0 ? 'no_primitive' : 'exhausted');
  }

  /** Known-good remedy for a signature (self-improvement introspection / tests). */
  knownRemedy(failed: FailedCheck[]): string | undefined {
    return this.memory.get(signatureOf(failed));
  }

  private async escalate(incident: Incident, reason: 'guardrail' | 'exhausted' | 'no_primitive'): Promise<HealOutcome> {
    this.frozen = true; // freeze further automated writes for the affected component
    this.opts.emitHumanTask({
      type: 'PRIVILEGE_ESCALATION',
      payload: { reason, signature: incident.signature, category: incident.category, attempts: incident.attempts, checks: incident.failed.map((f) => f.name) },
    });
    await this.emit('vcaop.heal.escalated', 'error', `escalated to human (${reason})`, { signature: incident.signature, reason, attempts: incident.attempts });
    if (this.opts.onEscalate) await this.opts.onEscalate(incident);
    return { status: 'escalated', reason, attempts: incident.attempts, frozen: true };
  }

  private async emit(type: string, status: 'info' | 'success' | 'warning' | 'error', message: string, payload: Record<string, unknown>) {
    await this.opts.oasis.emit({ type, source: 'self-healing', status, message, payload });
  }
}
