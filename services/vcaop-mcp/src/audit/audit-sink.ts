/**
 * Structured audit for every tool call (brief Sec. 6/14). OASIS-shaped rows;
 * payloads carry identifiers and outcomes only — never tool inputs/outputs,
 * secrets, or PII (inputs may contain user free text; outputs may contain
 * commercial data — neither belongs in the audit stream).
 */

export interface AuditEvent {
  service: 'vcaop-mcp';
  topic: string; // e.g. mcp.tool.get_wallet
  status: 'success' | 'error' | 'denied';
  message: string;
  payload: {
    tool: string;
    tenant_id: string;
    user_id: string;
    client_id: string;
    outcome: string;
    duration_ms: number;
  };
  createdAt: string;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditSink implements AuditSink {
  public events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Console sink for dev; single-line JSON, greppable, no payload beyond the audit shape. */
export class ConsoleAuditSink implements AuditSink {
  async emit(event: AuditEvent): Promise<void> {
    console.log(`[AUDIT] ${JSON.stringify(event)}`);
  }
}

const FORBIDDEN_KEY_PATTERN = /(secret|password|credential|token|_ref$|api_key)/i;

/**
 * Defense-in-depth assertion used by tests and the emit path: an audit event
 * must never carry a forbidden key or an email-shaped value.
 */
export function assertAuditSafe(event: AuditEvent): void {
  const walk = (obj: unknown, path: string): void => {
    if (obj === null || typeof obj !== 'object') {
      if (typeof obj === 'string' && /\S+@\S+\.\S+/.test(obj)) {
        throw new Error(`Audit event contains email-like PII at ${path}`);
      }
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_PATTERN.test(k)) {
        throw new Error(`Audit event contains forbidden key '${k}' at ${path}`);
      }
      walk(v, `${path}.${k}`);
    }
  };
  walk(event, 'event');
}
