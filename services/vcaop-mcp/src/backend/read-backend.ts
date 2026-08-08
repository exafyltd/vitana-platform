/**
 * Read-only backend seam. Tools NEVER accept tenant/user ids as input —
 * tenancy and ownership come exclusively from the verified AuthContext,
 * threaded here as explicit parameters (tenant-isolation by construction).
 */

export interface Product {
  id: string;
  title: string;
  merchant: string;
  category?: string;
  price?: { amount: string; currency: string };
  rewards_enabled?: boolean;
  url?: string;
}

export interface Offer {
  product_id: string;
  merchant: string;
  price: { amount: string; currency: string };
  rewards_enabled: boolean;
  affiliate_network?: string;
}

export interface InventoryLevel {
  product_id: string;
  status: 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown';
  quantity?: number;
}

export interface CartItem {
  product_id: string;
  title: string;
  quantity: number;
  price?: { amount: string; currency: string };
}

export interface Cart {
  id: string;
  status: string;
  items: CartItem[];
  currency: string;
  total?: string;
}

export interface Order {
  id: string;
  status: string;
  merchant?: string;
  currency: string;
  total?: string;
  created_at?: string;
}

export interface Wallet {
  currency: string;
  pending: string;
  confirmed: string;
  redeemable: string;
}

export interface RewardEntry {
  id: string;
  amount: string;
  currency: string;
  state: string;
  created_at?: string;
}

export interface PartnerCapability {
  provider: string;
  category: string;
  connector_mode: string;
  capabilities: string[];
}

export interface Page<T> {
  total: number;
  items: T[];
}

/** All methods are tenant+user scoped reads. Implementations must never widen scope. */
export interface MeshReadBackend {
  searchProducts(
    tenantId: string,
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<Product>>;
  getProduct(tenantId: string, productId: string): Promise<Product | null>;
  compareOffers(tenantId: string, productId: string): Promise<Offer[]>;
  getInventory(tenantId: string, productId: string): Promise<InventoryLevel | null>;
  getCart(tenantId: string, userId: string): Promise<Cart | null>;
  getOrder(tenantId: string, userId: string, orderId: string): Promise<Order | null>;
  getOrderStatus(
    tenantId: string,
    userId: string,
    orderId: string,
  ): Promise<{ id: string; status: string } | null>;
  getWallet(tenantId: string, userId: string): Promise<Wallet>;
  getRewards(tenantId: string, userId: string, limit: number): Promise<Page<RewardEntry>>;
  getPartnerCapabilities(tenantId: string): Promise<PartnerCapability[]>;
}
