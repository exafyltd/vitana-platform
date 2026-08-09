/**
 * Dev wiring against the live gateway's verified VCAOP endpoints
 * (`/api/v1/vcaop/*`). HONESTY NOTE (brief Sec. 20): only the subset with a
 * real, verified gateway endpoint today is implemented — wallet, rewards
 * (commissions), partner capabilities (providers/affiliate-programs). The
 * catalog/cart/order reads await the Phase 2 canonical read-model API and
 * throw `backend_unavailable` with an actionable message instead of
 * fabricating shapes. CI never calls this backend (mock-first, runbook
 * Sec. 0.5); it exists for dev smoke tests with a real bearer token.
 */
import {
  Cart,
  InventoryLevel,
  MeshReadBackend,
  Offer,
  Order,
  Page,
  PartnerCapability,
  Product,
  RewardEntry,
  Wallet,
} from './read-backend';
import { ToolError } from '../types';

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GatewayBackendOptions {
  /** e.g. https://gateway.vitanaland.com (dev/staging URL in practice) */
  baseUrl: string;
  /** Returns the upstream service token for the given tenant/user context. */
  getUpstreamToken: (tenantId: string, userId: string) => Promise<string>;
  fetchImpl?: FetchLike;
}

export class GatewayReadBackend implements MeshReadBackend {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: GatewayBackendOptions) {
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private async get(path: string, tenantId: string, userId: string): Promise<unknown> {
    const token = await this.opts.getUpstreamToken(tenantId, userId);
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new ToolError(
        'backend_unavailable',
        `Gateway responded ${res.status} for ${path}`,
      );
    }
    return res.json();
  }

  private unimplemented(what: string): never {
    throw new ToolError(
      'backend_unavailable',
      `${what} is not yet served by the gateway read-model API (Commerce Mesh Phase 2). ` +
        'Use the memory backend for tests, or wait for the canonical read-model endpoints.',
    );
  }

  async searchProducts(): Promise<Page<Product>> {
    return this.unimplemented('Product search');
  }
  async getProduct(): Promise<Product | null> {
    return this.unimplemented('Product lookup');
  }
  async compareOffers(): Promise<Offer[]> {
    return this.unimplemented('Offer comparison');
  }
  async getInventory(): Promise<InventoryLevel | null> {
    return this.unimplemented('Inventory lookup');
  }
  async getCart(): Promise<Cart | null> {
    return this.unimplemented('Cart read');
  }
  async getOrder(): Promise<Order | null> {
    return this.unimplemented('Order read');
  }
  async getOrderStatus(): Promise<{ id: string; status: string } | null> {
    return this.unimplemented('Order status read');
  }

  async getWallet(tenantId: string, userId: string): Promise<Wallet> {
    const data = (await this.get('/api/v1/vcaop/wallet', tenantId, userId)) as {
      wallet?: { currency?: string; pending?: string; confirmed?: string; redeemable?: string };
    };
    const w = data.wallet ?? {};
    return {
      currency: w.currency ?? 'EUR',
      pending: w.pending ?? '0.00',
      confirmed: w.confirmed ?? '0.00',
      redeemable: w.redeemable ?? '0.00',
    };
  }

  async getRewards(
    tenantId: string,
    userId: string,
    limit: number,
  ): Promise<Page<RewardEntry>> {
    const data = (await this.get(
      '/api/v1/vcaop/commissions',
      tenantId,
      userId,
    )) as { commissions?: Array<Record<string, unknown>> };
    const items = (data.commissions ?? []).slice(0, limit).map((c) => ({
      id: String(c.id ?? ''),
      amount: String(c.gross_commission ?? c.amount ?? '0.00'),
      currency: String(c.currency ?? 'EUR'),
      state: String(c.status ?? 'pending'),
      created_at: typeof c.created_at === 'string' ? c.created_at : undefined,
    }));
    return { total: items.length, items };
  }

  async getPartnerCapabilities(tenantId: string): Promise<PartnerCapability[]> {
    const data = (await this.get('/api/v1/vcaop/providers', tenantId, 'system')) as {
      providers?: Array<Record<string, unknown>>;
    };
    return (data.providers ?? []).map((p) => ({
      provider: String(p.name ?? p.id ?? 'unknown'),
      category: String(p.category ?? 'unknown'),
      connector_mode: String(p.connector_mode ?? p.connectorMode ?? 'unknown'),
      capabilities: [],
    }));
  }
}
