/**
 * OASIS event sink for the VCAOP API (CTRL-API-0004, runbook Sec. 4.7, Sec. 6).
 *
 * Every mutating API write emits an OASIS event. Payloads are redacted through the
 * no-pii-leak guardrail before emission (Sec. 9) and asserted secret/PII-free.
 * The real Gateway impl writes to `oasis_events` in the SAME transaction as the
 * read-model write; this in-memory impl is for tests/dev.
 */
import { redact, assertNoPii } from '../guardrails/no-pii-leak';

export interface OasisEvent {
  type: string; // e.g. vcaop.provider_account.created
  vtid?: string;
  source: string; // service name
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OasisSink {
  emit(event: Omit<OasisEvent, 'createdAt'>): Promise<void>;
}

/** Build a sink-safe event: redact PII, then assert nothing leaked (Sec. 9). */
export function sanitizeEvent(event: Omit<OasisEvent, 'createdAt'>): OasisEvent {
  const payload = redact(event.payload ?? {});
  assertNoPii(payload, 'oasis_event');
  const message = (redact({ m: event.message }) as { m: string }).m;
  return { ...event, payload, message, createdAt: new Date().toISOString() };
}

/** In-memory sink that records sanitized events (for tests + the /audit endpoint). */
export class InMemoryOasisSink implements OasisSink {
  readonly events: OasisEvent[] = [];

  async emit(event: Omit<OasisEvent, 'createdAt'>): Promise<void> {
    this.events.push(sanitizeEvent(event));
  }
}
