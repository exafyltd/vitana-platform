/**
 * Declarative tool registry — the 10 Phase 1 READ tools (brief Sec. 7).
 *
 * Contract per tool: zod input schema, required scopes, risk level,
 * read-only/destructive flags, confirmation + idempotency requirements,
 * audit event type, and applied policy checks. Authorization is enforced
 * centrally in the server layer (scope-filtered discovery + a second check
 * at call time); tenancy/ownership come ONLY from the verified token.
 *
 * There is intentionally NO generic tool that proxies arbitrary APIs
 * (ADR-005) — every capability is individually declared here.
 */
import { z, ZodRawShape } from 'zod';
import { AuthContext, ToolDeclaration, ToolError } from '../types';
import { SCOPES } from '../auth/scopes';
import { MeshReadBackend } from '../backend/read-backend';

export interface ReadTool {
  decl: ToolDeclaration;
  inputShape: ZodRawShape;
  handler: (
    backend: MeshReadBackend,
    ctx: AuthContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

const readDecl = (
  partial: Pick<ToolDeclaration, 'name' | 'title' | 'description' | 'requiredScopes'> &
    Partial<ToolDeclaration>,
): ToolDeclaration => ({
  riskLevel: 'low',
  readOnly: true,
  destructive: false,
  confirmationRequired: false,
  idempotency: 'none',
  auditEventType: `mcp.tool.${partial.name}`,
  policyChecks: ['scope', 'tenant_context', 'rate_limit'],
  ...partial,
});

const productId = z
  .string()
  .min(1)
  .max(128)
  .describe('Vitanaland product id (as returned by search_products)');

export const READ_TOOLS: ReadTool[] = [
  {
    decl: readDecl({
      name: 'search_products',
      title: 'Search Vitanaland Products',
      description:
        'Search the Vitanaland catalog by free-text query (title, category, merchant). ' +
        'Read-only. Returns a paginated list of products with ids usable in get_product, ' +
        'compare_offers, and get_inventory. Prices are authoritative merchant data, not estimates.',
      requiredScopes: [SCOPES.CATALOG_READ],
    }),
    inputShape: {
      query: z.string().min(1).max(200).describe('Free-text search query'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    handler: async (backend, ctx, args) => {
      const { query, limit, offset } = args as {
        query: string;
        limit: number;
        offset: number;
      };
      const page = await backend.searchProducts(ctx.tenantId, query, limit, offset);
      return {
        total: page.total,
        count: page.items.length,
        offset,
        has_more: page.total > offset + page.items.length,
        products: page.items,
      };
    },
  },
  {
    decl: readDecl({
      name: 'get_product',
      title: 'Get Product Details',
      description:
        'Fetch one product by id, including merchant, price, and rewards eligibility. Read-only.',
      requiredScopes: [SCOPES.CATALOG_READ],
    }),
    inputShape: { product_id: productId },
    handler: async (backend, ctx, args) => {
      const product = await backend.getProduct(ctx.tenantId, String(args.product_id));
      if (!product) {
        throw new ToolError('not_found', `No product with id '${args.product_id}'. Use search_products first.`);
      }
      return { product };
    },
  },
  {
    decl: readDecl({
      name: 'compare_offers',
      title: 'Compare Offers for a Product',
      description:
        'List all merchant offers for a product (price, rewards eligibility, network). Read-only.',
      requiredScopes: [SCOPES.CATALOG_READ],
    }),
    inputShape: { product_id: productId },
    handler: async (backend, ctx, args) => {
      const offers = await backend.compareOffers(ctx.tenantId, String(args.product_id));
      return { count: offers.length, offers };
    },
  },
  {
    decl: readDecl({
      name: 'get_inventory',
      title: 'Get Product Inventory Status',
      description:
        'Read inventory availability for a product. Read-only — never changes stock (inventory ' +
        'mutation is a deterministic VCAOP operation, never an AI tool).',
      requiredScopes: [SCOPES.CATALOG_READ],
    }),
    inputShape: { product_id: productId },
    handler: async (backend, ctx, args) => {
      const inv = await backend.getInventory(ctx.tenantId, String(args.product_id));
      if (!inv) {
        throw new ToolError('not_found', `No inventory record for product '${args.product_id}'.`);
      }
      return { inventory: inv };
    },
  },
  {
    decl: readDecl({
      name: 'get_cart',
      title: 'Get Current Cart',
      description:
        "Read the authenticated user's current cart (items, quantities, totals). Own-user only; " +
        'the user is identified by the OAuth token, never by a parameter.',
      requiredScopes: [SCOPES.CART_READ],
    }),
    inputShape: {},
    handler: async (backend, ctx) => {
      const cart = await backend.getCart(ctx.tenantId, ctx.userId);
      return { cart };
    },
  },
  {
    decl: readDecl({
      name: 'get_order',
      title: 'Get Order Details',
      description:
        "Read one of the authenticated user's orders by id. Own-user only; returns not_found for " +
        "orders that do not belong to the caller (existence of other users' orders is never revealed).",
      requiredScopes: [SCOPES.ORDERS_READ],
    }),
    inputShape: {
      order_id: z.string().min(1).max(128).describe('Order id'),
    },
    handler: async (backend, ctx, args) => {
      const order = await backend.getOrder(ctx.tenantId, ctx.userId, String(args.order_id));
      if (!order) {
        throw new ToolError('not_found', `No order '${args.order_id}' for this account.`);
      }
      return { order };
    },
  },
  {
    decl: readDecl({
      name: 'get_order_status',
      title: 'Get Order Status',
      description:
        "Read only the status of one of the authenticated user's orders. Cheaper than get_order " +
        'when only the state is needed.',
      requiredScopes: [SCOPES.ORDERS_READ],
    }),
    inputShape: {
      order_id: z.string().min(1).max(128).describe('Order id'),
    },
    handler: async (backend, ctx, args) => {
      const status = await backend.getOrderStatus(ctx.tenantId, ctx.userId, String(args.order_id));
      if (!status) {
        throw new ToolError('not_found', `No order '${args.order_id}' for this account.`);
      }
      return status;
    },
  },
  {
    decl: readDecl({
      name: 'get_wallet',
      title: 'Get Rewards Wallet Balance',
      description:
        "Read the authenticated user's Vitanaland rewards wallet (pending / confirmed / redeemable). " +
        'Balances are projections of the deterministic rewards ledger — read-only here.',
      requiredScopes: [SCOPES.WALLET_READ],
    }),
    inputShape: {},
    handler: async (backend, ctx) => {
      const wallet = await backend.getWallet(ctx.tenantId, ctx.userId);
      return { wallet };
    },
  },
  {
    decl: readDecl({
      name: 'get_rewards',
      title: 'List Reward Entries',
      description:
        "List the authenticated user's reward ledger entries (amount, currency, state). Own-user only.",
      requiredScopes: [SCOPES.REWARDS_READ],
    }),
    inputShape: {
      limit: z.number().int().min(1).max(100).default(20).describe('Max entries'),
    },
    handler: async (backend, ctx, args) => {
      const page = await backend.getRewards(ctx.tenantId, ctx.userId, Number(args.limit ?? 20));
      return { total: page.total, count: page.items.length, rewards: page.items };
    },
  },
  {
    decl: readDecl({
      name: 'get_partner_capabilities',
      title: 'List Partner Capabilities',
      description:
        'List connected partner systems and their declared capabilities for this tenant ' +
        '(provider, category, connector mode). Read-only; never exposes credentials or connector internals.',
      requiredScopes: [SCOPES.PARTNERS_READ],
    }),
    inputShape: {},
    handler: async (backend, ctx) => {
      const partners = await backend.getPartnerCapabilities(ctx.tenantId);
      return { count: partners.length, partners };
    },
  },
];

export function findTool(name: string): ReadTool | undefined {
  return READ_TOOLS.find((t) => t.decl.name === name);
}
