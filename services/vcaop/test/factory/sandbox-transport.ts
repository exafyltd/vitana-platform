/**
 * In-memory sandbox partner implementing the sandbox-supplier OpenAPI fixture.
 * Synthetic data only. Records calls; supports idempotency dedup and failure
 * injection so contract tests exercise auth failure / transient errors.
 */
import { GeneratedTransport } from '../../src/factory/factory';
import { ManifestAction } from '../../src/factory/manifest';

export class SandboxSupplierTransport implements GeneratedTransport {
  public calls: Array<{ action: string; idempotencyKey?: string }> = [];
  public failAuth = false;
  public transientFailuresRemaining = 0;
  private orders = new Map<string, { id: string; status: string; total_amount: number; currency: string; created_at: string }>();
  private orderSeq = 0;
  private products = [
    { id: 'sb-prod-1', title: 'Sandbox Omega-3', price_amount: 19.9, price_currency: 'EUR', stock_qty: 42 },
    { id: 'sb-prod-2', title: 'Sandbox Sleep Band', price_amount: 79, price_currency: 'EUR', stock_qty: 3 },
  ];

  async request(req: {
    action: ManifestAction;
    input: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<{ status: number; body: unknown }> {
    this.calls.push({ action: req.action.key, idempotencyKey: req.idempotencyKey });
    if (this.failAuth) return { status: 401, body: { message: 'invalid api key' } };
    if (this.transientFailuresRemaining > 0) {
      this.transientFailuresRemaining -= 1;
      return { status: 503, body: { message: 'try later' } };
    }

    switch (req.action.key) {
      case 'listProducts':
        return { status: 200, body: { items: this.products } };
      case 'getProduct':
        return { status: 200, body: this.products[0] };
      case 'createOrder': {
        const key = req.idempotencyKey ?? `no-key-${this.orderSeq}`;
        const existing = this.orders.get(key);
        if (existing) return { status: 201, body: existing };
        this.orderSeq += 1;
        const order = {
          id: `sb-order-${this.orderSeq}`,
          status: 'confirmed',
          total_amount: 19.9,
          currency: 'EUR',
          created_at: '2026-08-08T00:00:00Z',
        };
        this.orders.set(key, order);
        return { status: 201, body: order };
      }
      case 'cancelOrder':
        return { status: 200, body: { id: String(req.input.id ?? 'sb-order-1'), status: 'cancelled' } };
      default:
        return { status: 404, body: { message: `unknown action ${req.action.key}` } };
    }
  }
}
