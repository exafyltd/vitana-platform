/**
 * VTID-03842 — HTTP client for the private erp-bridge (VTID-03840).
 *
 * The gateway is the ONLY caller of the bridge; the browser never sees it.
 * Configuration: ERP_BRIDGE_URL (e.g. http://erp-bridge.vitana.internal:8080)
 * and ERP_BRIDGE_TOKEN (shared secret, Secrets Manager). When either is unset
 * every call fails closed with `bridge_not_configured` — the routes turn that
 * into 503, never into a silent no-op.
 */
export interface BridgeConfirmation {
  granted: boolean;
  approval_id?: string;
  approved_by?: string;
  requested_by?: string;
}

export interface BridgeExecuteRequest {
  tenant_id: string;
  action: string;
  params: Record<string, unknown>;
  idempotency_key: string;
  actor: { user_id: string; channel: 'web' | 'chat' | 'voice' | 'system' };
  confirmation?: BridgeConfirmation;
}

export interface BridgeReceipt {
  status: 'executed' | 'failed';
  replayed: boolean;
  idempotency_key: string;
  action: string;
  command?: string;
  tier?: string;
  rc?: number;
  duration_ms?: number;
  result?: unknown;
  stderr_tail?: string;
  argv?: string[];
  [k: string]: unknown;
}

export type BridgeResult =
  | { ok: true; status: number; receipt: BridgeReceipt }
  | { ok: false; status: number; error: string; detail?: unknown };

export interface ErpBridgeClient {
  execute(req: BridgeExecuteRequest): Promise<BridgeResult>;
}

class HttpErpBridgeClient implements ErpBridgeClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly timeoutMs: number) {}

  async execute(req: BridgeExecuteRequest): Promise<BridgeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-Bridge-Token': this.token },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      const body: any = await response.json().catch(() => null);
      if (response.ok && body && body.receipt) {
        return { ok: true, status: response.status, receipt: body.receipt as BridgeReceipt };
      }
      const detail = body?.detail ?? body;
      const error = typeof detail === 'object' && detail && typeof detail.error === 'string' ? detail.error : `bridge_http_${response.status}`;
      return { ok: false, status: response.status, error, detail };
    } catch (err: any) {
      return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'bridge_timeout' : 'bridge_unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
}

let override: ErpBridgeClient | null = null;

/** Tests inject a fake; production resolves from env on every call so a task-def change needs no restart. */
export function getErpBridgeClient(): ErpBridgeClient | null {
  if (override) return override;
  const url = (process.env.ERP_BRIDGE_URL || '').replace(/\/+$/, '');
  const token = process.env.ERP_BRIDGE_TOKEN || '';
  if (!url || !token) return null;
  const timeoutMs = Number(process.env.ERP_BRIDGE_TIMEOUT_MS || 90_000);
  return new HttpErpBridgeClient(url, token, timeoutMs);
}

export function __setErpBridgeClientForTests(client: ErpBridgeClient | null): void {
  override = client;
}
