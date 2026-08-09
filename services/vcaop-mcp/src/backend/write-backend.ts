/**
 * Write backend seam (Phase 6). Same tenancy discipline as reads: tenant and
 * user come ONLY from the verified token. Every mutating method takes the
 * caller's idempotency key; the in-memory implementation dedups on it —
 * effectively-once from the tool surface down.
 *
 * The deterministic boundary (ADR-005): settle_vtna and request_refund
 * methods CREATE INSTRUCTIONS for deterministic services; amounts are
 * computed server-side, and client-supplied amounts are rejected on
 * mismatch — never trusted, never "corrected".
 */
import { Cart } from './read-backend';

export interface CheckoutSession {
  id: string;
  cart_id: string;
  status: 'pending_confirmation' | 'confirmed' | 'cancelled';
  total: string;
  currency: string;
}

export interface OrderResult {
  order_id: string;
  status: string;
}

export interface RefundRequest {
  id: string;
  order_id: string;
  status: 'requested';
  note: string;
}

export interface DataGrant {
  id: string;
  grantee: string;
  purpose: string;
  status: 'requested' | 'approved' | 'revoked';
}

export interface SettlementInstructionResult {
  instruction_id: string;
  status: 'accepted';
  computed_amount: string;
  note: string;
}

export interface MeshWriteBackend {
  createCart(tenantId: string, userId: string, idempotencyKey: string): Promise<Cart>;
  addCartItem(
    tenantId: string,
    userId: string,
    cartId: string,
    productId: string,
    quantity: number,
    idempotencyKey: string,
  ): Promise<Cart>;
  createCheckoutSession(
    tenantId: string,
    userId: string,
    cartId: string,
    idempotencyKey: string,
  ): Promise<CheckoutSession>;
  confirmOrder(
    tenantId: string,
    userId: string,
    checkoutSessionId: string,
    idempotencyKey: string,
  ): Promise<OrderResult>;
  cancelOrder(tenantId: string, userId: string, orderId: string, idempotencyKey: string): Promise<OrderResult>;
  requestRefund(
    tenantId: string,
    userId: string,
    orderId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<RefundRequest>;
  createBusinessConnection(
    tenantId: string,
    userId: string,
    name: string,
    idempotencyKey: string,
  ): Promise<{ connection_id: string; state: string }>;
  activateBusinessConnection(
    tenantId: string,
    userId: string,
    connectionId: string,
    idempotencyKey: string,
  ): Promise<{ connection_id: string; state: string }>;
  requestDataGrant(
    tenantId: string,
    userId: string,
    grantee: string,
    purpose: string,
    idempotencyKey: string,
  ): Promise<DataGrant>;
  approveDataGrant(tenantId: string, userId: string, grantId: string, idempotencyKey: string): Promise<DataGrant>;
  revokeDataGrant(tenantId: string, userId: string, grantId: string, idempotencyKey: string): Promise<DataGrant>;
  /** Creates a settlement INSTRUCTION; the deterministic ledger computes/validates amounts. */
  settleVtna(
    tenantId: string,
    userId: string,
    instructionType: string,
    reference: string,
    idempotencyKey: string,
  ): Promise<SettlementInstructionResult>;
}
