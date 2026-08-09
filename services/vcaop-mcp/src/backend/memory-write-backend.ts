/**
 * In-memory write backend — synthetic sandbox commerce state, idempotent on
 * the caller's key for every mutation (a resubmitted key returns the ORIGINAL
 * result object, proving no duplicate business action occurred).
 */
import { Cart } from './read-backend';
import {
  CheckoutSession,
  DataGrant,
  MeshWriteBackend,
  OrderResult,
  RefundRequest,
  SettlementInstructionResult,
} from './write-backend';
import { ToolError } from '../types';

export class MemoryWriteBackend implements MeshWriteBackend {
  private seq = 0;
  private idem = new Map<string, unknown>();
  carts = new Map<string, Cart & { tenantId: string; userId: string }>();
  sessions = new Map<string, CheckoutSession & { tenantId: string; userId: string }>();
  orders = new Map<string, OrderResult & { tenantId: string; userId: string }>();
  grants = new Map<string, DataGrant & { tenantId: string; userId: string }>();
  settlements: SettlementInstructionResult[] = [];

  private once<T>(key: string, make: () => T): T {
    const existing = this.idem.get(key);
    if (existing !== undefined) return existing as T;
    const value = make();
    this.idem.set(key, value);
    return value;
  }

  async createCart(tenantId: string, userId: string, key: string): Promise<Cart> {
    return this.once(key, () => {
      const cart = {
        id: `cart-${++this.seq}`,
        status: 'open',
        items: [],
        currency: 'EUR',
        total: '0.00',
        tenantId,
        userId,
      };
      this.carts.set(cart.id, cart);
      return cart;
    });
  }

  async addCartItem(
    tenantId: string,
    userId: string,
    cartId: string,
    productId: string,
    quantity: number,
    key: string,
  ): Promise<Cart> {
    return this.once(key, () => {
      const cart = this.carts.get(cartId);
      if (!cart || cart.tenantId !== tenantId || cart.userId !== userId) {
        throw new ToolError('not_found', `No cart '${cartId}' for this account`);
      }
      cart.items.push({ product_id: productId, title: `Product ${productId}`, quantity });
      return cart;
    });
  }

  async createCheckoutSession(
    tenantId: string,
    userId: string,
    cartId: string,
    key: string,
  ): Promise<CheckoutSession> {
    return this.once(key, () => {
      const cart = this.carts.get(cartId);
      if (!cart || cart.tenantId !== tenantId || cart.userId !== userId) {
        throw new ToolError('not_found', `No cart '${cartId}' for this account`);
      }
      if (cart.items.length === 0) throw new ToolError('invalid_input', 'Cart is empty');
      const session = {
        id: `cks-${++this.seq}`,
        cart_id: cartId,
        status: 'pending_confirmation' as const,
        total: '19.90',
        currency: 'EUR',
        tenantId,
        userId,
      };
      this.sessions.set(session.id, session);
      return session;
    });
  }

  async confirmOrder(tenantId: string, userId: string, sessionId: string, key: string): Promise<OrderResult> {
    return this.once(key, () => {
      const session = this.sessions.get(sessionId);
      if (!session || session.tenantId !== tenantId || session.userId !== userId) {
        throw new ToolError('not_found', `No checkout session '${sessionId}' for this account`);
      }
      if (session.status !== 'pending_confirmation') {
        throw new ToolError('invalid_input', `Session is ${session.status}`);
      }
      session.status = 'confirmed';
      const order = { order_id: `ord-${++this.seq}`, status: 'confirmed', tenantId, userId };
      this.orders.set(order.order_id, order);
      return order;
    });
  }

  async cancelOrder(tenantId: string, userId: string, orderId: string, key: string): Promise<OrderResult> {
    return this.once(key, () => {
      const order = this.orders.get(orderId);
      if (!order || order.tenantId !== tenantId || order.userId !== userId) {
        throw new ToolError('not_found', `No order '${orderId}' for this account`);
      }
      order.status = 'cancelled';
      return { order_id: order.order_id, status: order.status };
    });
  }

  async requestRefund(
    tenantId: string,
    userId: string,
    orderId: string,
    reason: string,
    key: string,
  ): Promise<RefundRequest> {
    return this.once(key, () => {
      const order = this.orders.get(orderId);
      if (!order || order.tenantId !== tenantId || order.userId !== userId) {
        throw new ToolError('not_found', `No order '${orderId}' for this account`);
      }
      // The refund EXECUTION is a deterministic VCAOP service behind policy +
      // human gates — the tool only ever creates the request.
      return { id: `rfnd-${++this.seq}`, order_id: orderId, status: 'requested' as const, note: reason };
    });
  }

  async createBusinessConnection(tenantId: string, userId: string, name: string, key: string) {
    return this.once(key, () => ({ connection_id: `conn-${++this.seq}`, state: 'discovered', name, tenantId }));
  }

  async activateBusinessConnection(tenantId: string, _userId: string, connectionId: string, key: string) {
    return this.once(key, () => {
      // Mirrors the portal rule: activation requires a certified connection —
      // the sandbox backend refuses unknown ids the same way.
      if (!connectionId.startsWith('conn-')) throw new ToolError('not_found', `No connection '${connectionId}'`);
      return { connection_id: connectionId, state: 'active', tenantId };
    });
  }

  async requestDataGrant(tenantId: string, userId: string, grantee: string, purpose: string, key: string): Promise<DataGrant> {
    return this.once(key, () => {
      const grant = { id: `grant-${++this.seq}`, grantee, purpose, status: 'requested' as const, tenantId, userId };
      this.grants.set(grant.id, grant);
      return grant;
    });
  }

  async approveDataGrant(tenantId: string, userId: string, grantId: string, key: string): Promise<DataGrant> {
    return this.once(key, () => {
      const grant = this.grants.get(grantId);
      if (!grant || grant.tenantId !== tenantId || grant.userId !== userId) {
        throw new ToolError('not_found', `No data grant '${grantId}' for this account`);
      }
      grant.status = 'approved';
      return grant;
    });
  }

  async revokeDataGrant(tenantId: string, userId: string, grantId: string, key: string): Promise<DataGrant> {
    return this.once(key, () => {
      const grant = this.grants.get(grantId);
      if (!grant || grant.tenantId !== tenantId || grant.userId !== userId) {
        throw new ToolError('not_found', `No data grant '${grantId}' for this account`);
      }
      grant.status = 'revoked';
      return grant;
    });
  }

  async settleVtna(
    tenantId: string,
    userId: string,
    instructionType: string,
    reference: string,
    key: string,
  ): Promise<SettlementInstructionResult> {
    return this.once(key, () => {
      const allowed = ['affiliate_reward', 'loyalty_reward', 'data_use_reward', 'connector_usage_credit'];
      if (!allowed.includes(instructionType)) {
        throw new ToolError('invalid_input', `Instruction type '${instructionType}' is not settleable via this tool`);
      }
      // Amount computed by the deterministic ledger from the reference — the
      // AI client cannot supply one at all (there is no amount parameter).
      const result: SettlementInstructionResult = {
        instruction_id: `si-${++this.seq}`,
        status: 'accepted',
        computed_amount: '100',
        note: `sandbox: amount computed server-side from ${reference}; ledger settles asynchronously`,
      };
      this.settlements.push(result);
      return result;
    });
  }
}
