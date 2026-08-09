/**
 * In-memory backend with SYNTHETIC fixture data (runbook Sec. 0.3 item 8 —
 * tests never use real PII). Two tenants are seeded so tenant-isolation tests
 * can prove data never crosses.
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

interface TenantData {
  products: Product[];
  offers: Record<string, Offer[]>;
  inventory: Record<string, InventoryLevel>;
  carts: Record<string, Cart>; // by userId
  orders: Record<string, Order[]>; // by userId
  wallets: Record<string, Wallet>; // by userId
  rewards: Record<string, RewardEntry[]>; // by userId
  partners: PartnerCapability[];
}

function seedTenant(prefix: string): TenantData {
  const p1: Product = {
    id: `${prefix}-prod-1`,
    title: `${prefix} Longevity Omega-3`,
    merchant: `${prefix}-merchant-a`,
    category: 'supplements',
    price: { amount: '29.90', currency: 'EUR' },
    rewards_enabled: true,
  };
  const p2: Product = {
    id: `${prefix}-prod-2`,
    title: `${prefix} Sleep Tracker Band`,
    merchant: `${prefix}-merchant-b`,
    category: 'wearables',
    price: { amount: '89.00', currency: 'EUR' },
    rewards_enabled: false,
  };
  return {
    products: [p1, p2],
    offers: {
      [p1.id]: [
        {
          product_id: p1.id,
          merchant: `${prefix}-merchant-a`,
          price: { amount: '29.90', currency: 'EUR' },
          rewards_enabled: true,
          affiliate_network: 'admitad',
        },
        {
          product_id: p1.id,
          merchant: `${prefix}-merchant-c`,
          price: { amount: '27.50', currency: 'EUR' },
          rewards_enabled: false,
          affiliate_network: 'awin',
        },
      ],
    },
    inventory: {
      [p1.id]: { product_id: p1.id, status: 'in_stock', quantity: 120 },
      [p2.id]: { product_id: p2.id, status: 'low_stock', quantity: 3 },
    },
    carts: {
      [`${prefix}-user-1`]: {
        id: `${prefix}-cart-1`,
        status: 'open',
        currency: 'EUR',
        total: '29.90',
        items: [{ product_id: p1.id, title: p1.title, quantity: 1, price: p1.price }],
      },
    },
    orders: {
      [`${prefix}-user-1`]: [
        {
          id: `${prefix}-order-1`,
          status: 'confirmed',
          merchant: `${prefix}-merchant-a`,
          currency: 'EUR',
          total: '29.90',
          created_at: '2026-08-01T10:00:00Z',
        },
      ],
    },
    wallets: {
      [`${prefix}-user-1`]: {
        currency: 'EUR',
        pending: '1.20',
        confirmed: '4.50',
        redeemable: '4.50',
      },
    },
    rewards: {
      [`${prefix}-user-1`]: [
        {
          id: `${prefix}-rwd-1`,
          amount: '1.20',
          currency: 'EUR',
          state: 'pending',
          created_at: '2026-08-02T09:00:00Z',
        },
      ],
    },
    partners: [
      {
        provider: 'admitad',
        category: 'affiliate_network',
        connector_mode: 'api',
        capabilities: ['affiliate_link', 'postback'],
      },
    ],
  };
}

export class MemoryReadBackend implements MeshReadBackend {
  private tenants: Record<string, TenantData>;

  constructor(tenantIds: string[] = ['tenant-a', 'tenant-b']) {
    this.tenants = Object.fromEntries(tenantIds.map((t) => [t, seedTenant(t)]));
  }

  private t(tenantId: string): TenantData {
    const data = this.tenants[tenantId];
    if (!data) {
      // Unknown tenant behaves as empty, never as another tenant's data.
      return seedTenantEmpty();
    }
    return data;
  }

  async searchProducts(
    tenantId: string,
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<Product>> {
    const q = query.toLowerCase();
    const matches = this.t(tenantId).products.filter((p) =>
      `${p.title} ${p.category ?? ''} ${p.merchant}`.toLowerCase().includes(q),
    );
    return { total: matches.length, items: matches.slice(offset, offset + limit) };
  }

  async getProduct(tenantId: string, productId: string): Promise<Product | null> {
    return this.t(tenantId).products.find((p) => p.id === productId) ?? null;
  }

  async compareOffers(tenantId: string, productId: string): Promise<Offer[]> {
    return this.t(tenantId).offers[productId] ?? [];
  }

  async getInventory(
    tenantId: string,
    productId: string,
  ): Promise<InventoryLevel | null> {
    return this.t(tenantId).inventory[productId] ?? null;
  }

  async getCart(tenantId: string, userId: string): Promise<Cart | null> {
    return this.t(tenantId).carts[userId] ?? null;
  }

  async getOrder(
    tenantId: string,
    userId: string,
    orderId: string,
  ): Promise<Order | null> {
    return (
      this.t(tenantId).orders[userId]?.find((o) => o.id === orderId) ?? null
    );
  }

  async getOrderStatus(
    tenantId: string,
    userId: string,
    orderId: string,
  ): Promise<{ id: string; status: string } | null> {
    const order = await this.getOrder(tenantId, userId, orderId);
    return order ? { id: order.id, status: order.status } : null;
  }

  async getWallet(tenantId: string, userId: string): Promise<Wallet> {
    return (
      this.t(tenantId).wallets[userId] ?? {
        currency: 'EUR',
        pending: '0.00',
        confirmed: '0.00',
        redeemable: '0.00',
      }
    );
  }

  async getRewards(
    tenantId: string,
    userId: string,
    limit: number,
  ): Promise<Page<RewardEntry>> {
    const all = this.t(tenantId).rewards[userId] ?? [];
    return { total: all.length, items: all.slice(0, limit) };
  }

  async getPartnerCapabilities(tenantId: string): Promise<PartnerCapability[]> {
    return this.t(tenantId).partners;
  }
}

function seedTenantEmpty(): TenantData {
  return {
    products: [],
    offers: {},
    inventory: {},
    carts: {},
    orders: {},
    wallets: {},
    rewards: {},
    partners: [],
  };
}
