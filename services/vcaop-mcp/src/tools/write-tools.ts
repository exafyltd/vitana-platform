/**
 * Phase 6 WRITE tools (brief Sec. 7). Contract additions over reads:
 *  - every tool requires an `idempotency_key` (effectively-once from the
 *    tool surface down — resubmission returns the original result);
 *  - consequential tools declare `confirmationRequired` and refuse to run
 *    unless the AI client attests explicit user confirmation
 *    (`user_confirmation: true`) — enforced centrally in the server layer;
 *  - settle_vtna and request_refund create INSTRUCTIONS for deterministic
 *    services. settle_vtna has NO amount parameter at all — the ledger
 *    computes amounts from the reference; an LLM never supplies one
 *    (ADR-005).
 * Still no generic passthrough tool, and never a health-data tool here
 * (Phase 7 is library-only until BLK-009 clears).
 */
import { z, ZodRawShape } from 'zod';
import { AuthContext, ToolDeclaration } from '../types';
import { SCOPES } from '../auth/scopes';
import { MeshWriteBackend } from '../backend/write-backend';

export interface WriteTool {
  decl: ToolDeclaration;
  inputShape: ZodRawShape;
  handler: (
    backend: MeshWriteBackend,
    ctx: AuthContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

const writeDecl = (
  partial: Pick<ToolDeclaration, 'name' | 'title' | 'description' | 'requiredScopes'> &
    Partial<ToolDeclaration>,
): ToolDeclaration => ({
  riskLevel: 'medium',
  readOnly: false,
  destructive: false,
  confirmationRequired: false,
  idempotency: 'idempotency_key',
  auditEventType: `mcp.tool.${partial.name}`,
  policyChecks: ['scope', 'tenant_context', 'rate_limit', 'idempotency', 'confirmation'],
  ...partial,
});

const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe('Caller-chosen unique key; resubmitting with the same key returns the original result (no duplicate effect)');

const confirmation = z
  .boolean()
  .optional()
  .describe('Must be true, and only after the user explicitly confirmed this exact action in the conversation');

export const WRITE_TOOLS: WriteTool[] = [
  {
    decl: writeDecl({
      name: 'create_cart',
      title: 'Create Cart',
      description: 'Create a new empty cart for the authenticated user. Reversible; no payment occurs.',
      requiredScopes: [SCOPES.CART_WRITE],
      riskLevel: 'low',
    }),
    inputShape: { idempotency_key: idempotencyKey },
    handler: (b, ctx, a) => b.createCart(ctx.tenantId, ctx.userId, String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'add_cart_item',
      title: 'Add Cart Item',
      description: 'Add a product to the user’s cart. Reversible; no payment occurs.',
      requiredScopes: [SCOPES.CART_WRITE],
      riskLevel: 'low',
    }),
    inputShape: {
      cart_id: z.string().min(1),
      product_id: z.string().min(1),
      quantity: z.number().int().min(1).max(99).default(1),
      idempotency_key: idempotencyKey,
    },
    handler: (b, ctx, a) =>
      b.addCartItem(ctx.tenantId, ctx.userId, String(a.cart_id), String(a.product_id), Number(a.quantity ?? 1), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'create_checkout_session',
      title: 'Create Checkout Session',
      description:
        'Turn a cart into a checkout session with an authoritative total. Nothing is charged until confirm_order.',
      requiredScopes: [SCOPES.CART_WRITE],
    }),
    inputShape: { cart_id: z.string().min(1), idempotency_key: idempotencyKey },
    handler: (b, ctx, a) => b.createCheckoutSession(ctx.tenantId, ctx.userId, String(a.cart_id), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'confirm_order',
      title: 'Confirm Order',
      description:
        'Confirm a pending checkout session and place the order. IRREVERSIBLE without a refund flow — requires explicit user confirmation of the exact total first.',
      requiredScopes: [SCOPES.ORDERS_WRITE],
      riskLevel: 'high',
      confirmationRequired: true,
    }),
    inputShape: { checkout_session_id: z.string().min(1), user_confirmation: confirmation, idempotency_key: idempotencyKey },
    handler: (b, ctx, a) => b.confirmOrder(ctx.tenantId, ctx.userId, String(a.checkout_session_id), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'cancel_order',
      title: 'Cancel Order',
      description: 'Cancel one of the user’s orders. Destructive to the order — requires explicit user confirmation.',
      requiredScopes: [SCOPES.ORDERS_WRITE],
      riskLevel: 'high',
      destructive: true,
      confirmationRequired: true,
    }),
    inputShape: { order_id: z.string().min(1), user_confirmation: confirmation, idempotency_key: idempotencyKey },
    handler: (b, ctx, a) => b.cancelOrder(ctx.tenantId, ctx.userId, String(a.order_id), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'request_refund',
      title: 'Request Refund',
      description:
        'File a refund REQUEST for an order. Refund execution is a deterministic platform service behind policy and human gates — this tool never moves money.',
      requiredScopes: [SCOPES.ORDERS_WRITE],
      riskLevel: 'high',
      confirmationRequired: true,
    }),
    inputShape: {
      order_id: z.string().min(1),
      reason: z.string().min(3).max(500),
      user_confirmation: confirmation,
      idempotency_key: idempotencyKey,
    },
    handler: (b, ctx, a) =>
      b.requestRefund(ctx.tenantId, ctx.userId, String(a.order_id), String(a.reason), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'create_business_connection',
      title: 'Create Business Connection',
      description: 'Start connecting a business system (Partner Portal wizard entry). Reversible.',
      requiredScopes: [SCOPES.CONNECTIONS_WRITE],
    }),
    inputShape: { name: z.string().min(2).max(120), idempotency_key: idempotencyKey },
    handler: (b, ctx, a) => b.createBusinessConnection(ctx.tenantId, ctx.userId, String(a.name), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'activate_business_connection',
      title: 'Activate Business Connection',
      description:
        'THE one activation approval for a certified business connection. Requires explicit user confirmation; refused for uncertified connections.',
      requiredScopes: [SCOPES.CONNECTIONS_WRITE],
      riskLevel: 'high',
      confirmationRequired: true,
    }),
    inputShape: { connection_id: z.string().min(1), user_confirmation: confirmation, idempotency_key: idempotencyKey },
    handler: (b, ctx, a) =>
      b.activateBusinessConnection(ctx.tenantId, ctx.userId, String(a.connection_id), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'request_data_grant',
      title: 'Request Data Grant',
      description: 'Create a purpose-bound data-grant REQUEST for the user to review. Grants nothing by itself.',
      requiredScopes: [SCOPES.GRANTS_WRITE],
    }),
    inputShape: {
      grantee: z.string().min(2).max(120).describe('Who would receive the data'),
      purpose: z.string().min(3).max(300).describe('The specific purpose the grant is limited to'),
      idempotency_key: idempotencyKey,
    },
    handler: (b, ctx, a) =>
      b.requestDataGrant(ctx.tenantId, ctx.userId, String(a.grantee), String(a.purpose), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'approve_data_grant',
      title: 'Approve Data Grant',
      description:
        'Approve a pending data grant. Consent is the user’s decision — requires explicit user confirmation; an AI must never approve on inference.',
      requiredScopes: [SCOPES.GRANTS_WRITE],
      riskLevel: 'high',
      confirmationRequired: true,
    }),
    inputShape: { grant_id: z.string().min(1), user_confirmation: confirmation, idempotency_key: idempotencyKey },
    handler: (b, ctx, a) => b.approveDataGrant(ctx.tenantId, ctx.userId, String(a.grant_id), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'revoke_data_grant',
      title: 'Revoke Data Grant',
      description: 'Revoke a data grant immediately. Deliberately friction-free — revocation never needs a confirmation dance.',
      requiredScopes: [SCOPES.GRANTS_WRITE],
    }),
    inputShape: { grant_id: z.string().min(1), idempotency_key: idempotencyKey },
    handler: (b, ctx, a) => b.revokeDataGrant(ctx.tenantId, ctx.userId, String(a.grant_id), String(a.idempotency_key)),
  },
  {
    decl: writeDecl({
      name: 'settle_vtna',
      title: 'Create VTNA Settlement Instruction',
      description:
        'Create a VTNA settlement INSTRUCTION for an earned reward/credit reference. There is deliberately no amount parameter: the deterministic ledger computes and validates amounts from the reference. Sandbox instruments only.',
      requiredScopes: [SCOPES.SETTLEMENT_WRITE],
      riskLevel: 'high',
      confirmationRequired: true,
    }),
    inputShape: {
      instruction_type: z.enum(['affiliate_reward', 'loyalty_reward', 'data_use_reward', 'connector_usage_credit']),
      reference: z.string().min(3).max(200).describe('The commission/reward/usage record this settles'),
      user_confirmation: confirmation,
      idempotency_key: idempotencyKey,
    },
    handler: (b, ctx, a) =>
      b.settleVtna(ctx.tenantId, ctx.userId, String(a.instruction_type), String(a.reference), String(a.idempotency_key)),
  },
];
