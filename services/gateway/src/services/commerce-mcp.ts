/**
 * VTID-04847 — the Vitanaland Commerce MCP server (owner decisions 2026-10-02).
 *
 * A supplier copies the Vitanaland MCP address into their AI assistant
 * (Claude, ChatGPT, …), signs in with their Vitanaland account, and tells it
 * which business to onboard. The assistant then sets the business up through
 * these tools. They call the same Commerce service functions as the portal
 * (partner-onboarding-service.ts, partner-setup.ts): the same validation,
 * lifecycle guards, org_admin checks and OASIS events. MCP never writes to
 * the database itself.
 *
 * Protocol: MCP over Streamable HTTP, stateless, JSON responses
 * (spec 2025-06-18; 2025-03-26 and 2024-11-05 accepted). Each POST carries
 * one JSON-RPC message or a batch. No sessions, no server-sent events.
 *
 * Auth: OAuth 2.1 via Supabase Auth (the protected-resource metadata points
 * at it). The bearer is a Supabase access token for the user, verified like
 * every other gateway request (verifyAndExtractIdentity).
 *
 * Sensitive actions need the supplier's explicit confirmation, passed by the
 * assistant as `confirmed: true` after asking:
 *   - submit_for_verification;
 *   - a company change that voids a verification that already passed.
 * Accepting the partner terms is never a tool: it is a tap on Vitanaland with
 * the terms text in front of the supplier.
 */
import { emitOasisEvent } from './oasis-event-service';
import { PARTNER_TYPES, parseCompanyFacts } from './partner-lifecycle';
import {
  changeVoidsVerification,
  getOnboardingStatus,
  listCatalogue,
  listMyOrgs,
  setMissingPartnerType,
  startOnboarding,
  submitForVerification,
  updateCompany,
  updateProduct,
  type Caller,
  type ServiceResult,
} from './partner-onboarding-service';
import { createOrgProduct, findOrgMerchant, upsertOrgMerchant } from './partner-setup';
import { BUSINESS_CATEGORIES, catalogueVerticalForCategory, isBusinessCategory } from './commerce-ai-setup';
import { loadOrg, type Supa } from '../routes/partner-onboarding';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_INFO = { name: 'vitanaland-commerce', title: 'Vitanaland Commerce', version: '1.0.0' };

export function isCommerceMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMMERCE_MCP_ENABLED === 'true';
}

const INSTRUCTIONS = [
  'You help a supplier put their business on Vitanaland, a health and longevity community marketplace.',
  'Start with get_onboarding_status. Create the business with create_business, fill the company details with update_business,',
  'add their products or services with add_product (everything is saved as a hidden draft until the business is reviewed),',
  'and when every step is done, ask the supplier to confirm and call submit_for_verification with confirmed=true.',
  'Infer what you can from what the supplier tells you or from their website; ask only for what you cannot determine.',
  'The partner terms are accepted by the supplier on Vitanaland itself: give them the link from the status.',
].join(' ');

// ==================== Tool catalogue ====================

const ORG_ID = { type: 'string', description: 'The business id from get_onboarding_status or create_business.' };
const BUSINESS_TYPE = {
  type: 'string',
  enum: [...PARTNER_TYPES],
  description:
    'lab = diagnostic lab; practitioner_clinic = doctor, therapist or clinic; supplier_shop = sells products; service_provider = sells services; affiliate_brand = a brand selling through affiliate links.',
};
const CONFIRMED = {
  type: 'boolean',
  description: 'true only after the supplier explicitly agreed to this action in the conversation.',
};

export const COMMERCE_MCP_TOOLS = [
  {
    name: 'get_onboarding_status',
    title: 'Onboarding status',
    description:
      "Lists the supplier's businesses on Vitanaland, or, with organization_id, one business's setup state: each step, what is missing, the next step and links for the steps done on Vitanaland itself.",
    inputSchema: { type: 'object', properties: { organization_id: ORG_ID }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_business',
    title: 'Create business',
    description:
      'Starts onboarding: creates the business as a draft with the signed-in user as its admin. Calling it again for the same draft business returns it instead of creating a second one.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The business name as customers know it.' },
        business_type: BUSINESS_TYPE,
      },
      required: ['name', 'business_type'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'update_business',
    title: 'Update company details',
    description:
      'Sets the company details: legal name, country (ISO 3166-1 alpha-2), website and, for EU countries, the VAT ID. Only while the business is being set up. Changing website, country or VAT ID after verification passed means verification runs again: ask the supplier first and pass confirmed=true. business_type only when the status lists it as missing; once set it cannot be changed here.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: ORG_ID,
        legal_name: { type: 'string' },
        country: { type: 'string', description: 'Two letters, e.g. DE.' },
        website: { type: 'string', description: 'https://…' },
        vat_id: { type: 'string' },
        business_type: BUSINESS_TYPE,
        confirmed: CONFIRMED,
      },
      required: ['organization_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'add_product',
    title: 'Add product or service',
    description:
      "Adds one product or service as a hidden draft (never visible to members until review). Origin and shipping default to the business's country, the link to the business website. Set the company country first.",
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: ORG_ID,
        title: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number', description: 'Price in major units, e.g. 24.90.' },
        currency: { type: 'string', description: 'ISO 4217, e.g. EUR. Defaults to EUR.' },
        url: { type: 'string', description: 'The product page; defaults to the business website.' },
        image_url: { type: 'string' },
        kind: { type: 'string', enum: ['product', 'service'] },
        ships_to_countries: { type: 'array', items: { type: 'string' }, description: 'Defaults to the business country.' },
        business_category: {
          type: 'string',
          enum: [...BUSINESS_CATEGORIES],
          description: 'Needed once for shops and brands, to file the catalogue in the right section.',
        },
        idempotency_key: { type: 'string', description: 'Optional; repeating a call with the same key never creates a duplicate.' },
      },
      required: ['organization_id', 'title', 'price'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'list_products',
    title: 'List products',
    description: "Lists the business's products and services with their ids, prices and whether they are live.",
    inputSchema: { type: 'object', properties: { organization_id: ORG_ID }, required: ['organization_id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'update_product',
    title: 'Update product',
    description: 'Changes fields of one product or service (title, description, price, currency, link, image, shipping, availability). It stays a draft until review.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: ORG_ID,
        product_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number' },
        currency: { type: 'string' },
        url: { type: 'string' },
        image_url: { type: 'string' },
        ships_to_countries: { type: 'array', items: { type: 'string' } },
        availability: { type: 'string', enum: ['in_stock', 'out_of_stock', 'preorder', 'discontinued', 'unknown'] },
      },
      required: ['organization_id', 'product_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'submit_for_verification',
    title: 'Submit for verification',
    description:
      'Submits the business. The checks then decide: live once every required step is done, otherwise it comes back with the open steps. Ask the supplier first and pass confirmed=true.',
    inputSchema: {
      type: 'object',
      properties: { organization_id: ORG_ID, confirmed: CONFIRMED },
      required: ['organization_id', 'confirmed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
] as const;

export type CommerceToolName = (typeof COMMERCE_MCP_TOOLS)[number]['name'];

// ==================== Tool results ====================

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/** Structured error codes an assistant can act on. */
export type ToolErrorCode =
  | 'invalid_input'
  | 'confirmation_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'prerequisites_missing'
  | 'rate_limited'
  | 'unavailable'
  | 'internal';

export function toolError(code: ToolErrorCode, message: string, details?: Record<string, unknown>): ToolCallResult {
  const body = { error: { code, message, ...(details ? { details } : {}) } };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

export function toolOk(data: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
}

/** A service result → a tool result, with the service's error code kept. */
export function fromService(r: ServiceResult, shape: (body: Record<string, any>) => Record<string, unknown> = (b) => b): ToolCallResult {
  if (r.status < 400) return toolOk(shape(r.body as Record<string, any>));
  const err = String((r.body as any).error ?? 'error');
  const code: ToolErrorCode =
    r.status === 400 ? 'invalid_input'
      : r.status === 401 || r.status === 403 ? 'forbidden'
        : r.status === 404 ? 'not_found'
          : r.status === 409 ? (err === 'SUBMIT_PREREQUISITES_MISSING' ? 'prerequisites_missing' : 'conflict')
            : r.status === 503 ? 'unavailable'
              : 'internal';
  const { ok: _ok, error: _e, checklist: _c, ...rest } = r.body as Record<string, unknown>;
  return toolError(code, err, Object.keys(rest).length ? rest : undefined);
}

// ==================== Shaping (what the assistant reads) ====================

/** Steps the supplier does on Vitanaland itself, never through the assistant. */
const ON_SCREEN_STEPS = new Set(['terms', 'verification', 'dpa', 'billing_mandate', 'results_channel', 'mapping', 'tracking_test']);

export function shapeStatus(body: Record<string, any>, portalUrl: string): Record<string, unknown> {
  const org = body.organization ?? {};
  const checklist = body.checklist ?? null;
  const steps = Array.isArray(checklist?.steps) ? checklist.steps : [];
  // VTID-04890: a business without a type has no checklist; say what is missing.
  const typeless = !checklist && org.partner_type == null;
  return {
    organization_id: org.id,
    name: org.display_name,
    business_type: org.partner_type,
    state: org.lifecycle_state,
    company: { legal_name: org.legal_name ?? null, country: org.country ?? null, website: org.website ?? null, vat_id: org.vat_id ?? null },
    next_step: typeless ? 'business_type' : checklist?.next_step ?? null,
    ready_to_submit: checklist?.submit_ready ?? false,
    missing_to_submit: typeless ? ['business_type'] : checklist?.submit_missing ?? [],
    steps: steps.map((st: any) => ({
      step: st.key,
      required: st.required,
      status: st.status,
      ...(st.missing?.length ? { missing: st.missing } : {}),
      // VTID-04933: what the Vitanaland reviewer asked the supplier to change.
      ...(typeof st.detail?.review_note?.reason === 'string' ? { review_note: st.detail.review_note.reason } : {}),
      ...(st.detail?.method === 'admin_approval' ? { approved_by_vitanaland: true } : {}),
      ...(ON_SCREEN_STEPS.has(st.key) ? { done_on_vitanaland: true, link: `${portalUrl}/commerce?org=${org.id}` } : {}),
    })),
    portal_link: `${portalUrl}/commerce?org=${org.id}`,
    ...(typeless
      ? {
          hint: 'This business has no type yet. Ask the supplier what kind of business it is, then call update_business with business_type. Do not call create_business: that would create a second business.',
          business_types: [...PARTNER_TYPES],
        }
      : {}),
    ...(body.created !== undefined ? { created: body.created } : {}),
    ...(body.transitions ? { transitions: body.transitions, open_steps: body.open_steps ?? [] } : {}),
  };
}

const shapeProduct = (p: Record<string, any>) => ({
  product_id: p.id,
  title: p.title,
  price: typeof p.price_cents === 'number' ? p.price_cents / 100 : null,
  currency: p.currency,
  url: p.affiliate_url,
  image_url: Array.isArray(p.images) ? p.images[0] ?? null : null,
  availability: p.availability,
  kind: p.attributes?.kind ?? null,
  live: p.is_active === true,
});

// ==================== Dispatch ====================

export interface McpCallContext {
  supabase: Supa;
  caller: Caller;
  /** OAuth client the token was issued to (audit only). */
  clientId: string | null;
  /** The Vitanaland app origin for links (https://vitanaland.com or the staging app). */
  portalUrl: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const toCents = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : undefined;

async function addProduct(ctx: McpCallContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  const orgId = str(args.organization_id);
  if (!orgId) return toolError('invalid_input', 'organization_id is required');
  const status = await getOnboardingStatus(ctx.supabase, ctx.caller, orgId);
  if (status.status >= 400) return fromService(status);
  const org = (status.body as any).organization;
  if (!org.country) {
    return toolError('prerequisites_missing', 'Set the company country first (update_business): it is the default origin and shipping country.');
  }
  const priceCents = toCents(args.price);
  if (priceCents === undefined) return toolError('invalid_input', 'price must be a number ≥ 0 in major units');
  const url = str(args.url) ?? org.website;
  if (!url) return toolError('invalid_input', 'Give the product page url, or set the business website first.');

  // The org's catalogue merchant, created on first use (the portal's own rule).
  const { org: orgRow } = await loadOrg(ctx.supabase, orgId);
  if (!orgRow) return toolError('not_found', 'ORG_NOT_FOUND');
  let merchant = (await findOrgMerchant(ctx.supabase, orgId)).merchant;
  if (!merchant) {
    const category = isBusinessCategory(args.business_category) ? args.business_category : null;
    const merchantBody = category ? { vertical_key: catalogueVerticalForCategory(category) } : {};
    const up = await upsertOrgMerchant(ctx.supabase, orgRow, ctx.caller.userId, merchantBody);
    if (!up.ok) {
      const err = String((up.body as any).error ?? '');
      if (up.status === 400 && !category) {
        return toolError('invalid_input', 'Tell me the business_category once, so the catalogue is filed in the right section.', {
          business_category: [...BUSINESS_CATEGORIES],
        });
      }
      return fromService({ status: up.status, body: up.body });
    }
    merchant = up.data.merchant;
  }

  const ships = Array.isArray(args.ships_to_countries) && args.ships_to_countries.length
    ? (args.ships_to_countries as unknown[]).filter((c): c is string => typeof c === 'string')
    : [org.country];
  const body: Record<string, unknown> = {
    title: str(args.title),
    ...(str(args.description) ? { description: str(args.description) } : {}),
    price_cents: priceCents,
    currency: str(args.currency) ?? 'EUR',
    images: str(args.image_url) ? [str(args.image_url)] : [],
    affiliate_url: url,
    origin_country: org.country,
    ships_to_countries: ships,
    attributes: { kind: args.kind === 'service' ? 'service' : 'product', source: 'mcp' },
  };
  const key = str(args.idempotency_key);
  const created = await createOrgProduct(ctx.supabase, orgId, merchant!.id, ctx.caller.userId, body, {
    productKey: key && /^[A-Za-z0-9._:-]{8,128}$/.test(key) ? `mcp:${key}` : null,
  });
  if (!created.ok) return fromService({ status: created.status, body: created.body });
  return toolOk({ product: shapeProduct(created.data.product as any), replayed: created.data.replayed, live: false });
}

const PRODUCT_PATCH_KEYS: Record<string, (v: unknown) => [string, unknown] | null> = {
  title: (v) => (str(v) ? ['title', str(v)] : null),
  description: (v) => (typeof v === 'string' ? ['description', v] : null),
  price: (v) => (toCents(v) !== undefined ? ['price_cents', toCents(v)] : null),
  currency: (v) => (str(v) ? ['currency', str(v)] : null),
  url: (v) => (str(v) ? ['affiliate_url', str(v)] : null),
  image_url: (v) => (str(v) ? ['images', [str(v)]] : null),
  ships_to_countries: (v) => (Array.isArray(v) ? ['ships_to_countries', v] : null),
  availability: (v) => (str(v) ? ['availability', str(v)] : null),
};

export async function callCommerceTool(ctx: McpCallContext, name: string, rawArgs: unknown): Promise<ToolCallResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const s = ctx.supabase;
  switch (name) {
    case 'get_onboarding_status': {
      const orgId = str(args.organization_id);
      if (!orgId) {
        const r = await listMyOrgs(s, ctx.caller);
        return fromService(r, (b) => ({
          businesses: (b.organizations ?? []).map((o: any) => ({
            organization_id: o.id,
            name: o.display_name,
            business_type: o.partner_type,
            state: o.lifecycle_state,
            role: o.role,
          })),
          ...(Array.isArray(b.organizations) && b.organizations.length === 0
            ? { hint: 'No business yet: ask what business to onboard, then call create_business.' }
            : {}),
        }));
      }
      return fromService(await getOnboardingStatus(s, ctx.caller, orgId), (b) => shapeStatus(b, ctx.portalUrl));
    }
    case 'create_business':
      return fromService(
        await startOnboarding(s, ctx.caller, { display_name: args.name, partner_type: args.business_type }, { source: 'commerce-mcp' }),
        (b) => shapeStatus(b, ctx.portalUrl),
      );
    case 'update_business': {
      const orgId = str(args.organization_id);
      if (!orgId) return toolError('invalid_input', 'organization_id is required');
      const facts: Record<string, unknown> = {};
      for (const k of ['legal_name', 'country', 'website', 'vat_id']) if (args[k] !== undefined) facts[k] = args[k];
      const hasFacts = Object.keys(facts).length > 0;
      // VTID-04890: everything that can refuse runs before anything is written.
      if (hasFacts) {
        const parsed = parseCompanyFacts(facts);
        if (!parsed.ok) return toolError('invalid_input', parsed.error);
      }
      if (args.business_type !== undefined && !hasFacts) {
        return fromService(
          await setMissingPartnerType(s, ctx.caller, orgId, args.business_type, { source: 'commerce-mcp' }),
          (b) => shapeStatus(b, ctx.portalUrl),
        );
      }
      if (args.confirmed !== true) {
        const status = await getOnboardingStatus(s, ctx.caller, orgId);
        if (status.status >= 400) return fromService(status);
        if (changeVoidsVerification((status.body as any).checklist, Object.keys(facts))) {
          return toolError(
            'confirmation_required',
            'Verification already passed: changing website, country or VAT ID means it runs again. Ask the supplier, then call again with confirmed=true.',
          );
        }
      }
      if (args.business_type !== undefined) {
        const typed = await setMissingPartnerType(s, ctx.caller, orgId, args.business_type, { source: 'commerce-mcp' });
        if (typed.status >= 400) return fromService(typed);
      }
      return fromService(await updateCompany(s, ctx.caller, orgId, facts, { source: 'commerce-mcp' }), (b) => shapeStatus(b, ctx.portalUrl));
    }
    case 'add_product':
      return addProduct(ctx, args);
    case 'list_products': {
      const orgId = str(args.organization_id);
      if (!orgId) return toolError('invalid_input', 'organization_id is required');
      return fromService(await listCatalogue(s, ctx.caller, orgId), (b) => ({
        products: (b.products ?? []).map(shapeProduct),
      }));
    }
    case 'update_product': {
      const orgId = str(args.organization_id);
      const productId = str(args.product_id);
      if (!orgId || !productId) return toolError('invalid_input', 'organization_id and product_id are required');
      const patch: Record<string, unknown> = {};
      for (const [k, map] of Object.entries(PRODUCT_PATCH_KEYS)) {
        if (args[k] === undefined) continue;
        const m = map(args[k]);
        if (!m) return toolError('invalid_input', `${k} is not valid`);
        patch[m[0]] = m[1];
      }
      return fromService(await updateProduct(s, ctx.caller, orgId, productId, patch), (b) => ({ product: shapeProduct(b.product ?? {}) }));
    }
    case 'submit_for_verification': {
      const orgId = str(args.organization_id);
      if (!orgId) return toolError('invalid_input', 'organization_id is required');
      if (args.confirmed !== true) {
        return toolError('confirmation_required', 'Ask the supplier to confirm the submission, then call again with confirmed=true.');
      }
      return fromService(await submitForVerification(s, ctx.caller, orgId, { source: 'commerce-mcp' }), (b) => shapeStatus(b, ctx.portalUrl));
    }
    default:
      return toolError('not_found', `Unknown tool: ${name}`);
  }
}

/** One audit event per tool call: who, which client, which tool, outcome. Never the values. */
export async function auditToolCall(ctx: McpCallContext, name: string, args: Record<string, unknown>, result: ToolCallResult): Promise<void> {
  const errorCode = result.isError ? String((result.structuredContent as any)?.error?.code ?? 'error') : null;
  await emitOasisEvent({
    vtid: 'VTID-04847',
    type: 'commerce.mcp.tool_called',
    source: 'commerce-mcp',
    status: result.isError ? (errorCode === 'internal' ? 'error' : 'warning') : 'success',
    message: `Commerce MCP ${name}: ${result.isError ? errorCode : 'ok'}.`,
    payload: {
      tool: name,
      organization_id: typeof args.organization_id === 'string' ? args.organization_id : null,
      client_id: ctx.clientId,
      outcome: result.isError ? 'error' : 'ok',
      error_code: errorCode,
      // Field names only, never the values.
      fields: Object.keys(args).filter((k) => k !== 'organization_id'),
    },
    actor_id: ctx.caller.userId,
    actor_role: 'agent',
    surface: 'api',
  }).catch(() => undefined);
}

// ==================== JSON-RPC ====================

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0];
}

/** Handles one message. Returns null for notifications (no response). */
export async function handleJsonRpc(msg: JsonRpcRequest, ctx: McpCallContext): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;
  const err = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isNotification ? null : err(-32600, 'Invalid Request');

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateVersion(msg.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: COMMERCE_MCP_TOOLS } };
    case 'tools/call': {
      const name = msg.params?.name;
      if (typeof name !== 'string') return err(-32602, 'Invalid params: name is required');
      if (!COMMERCE_MCP_TOOLS.some((t) => t.name === name)) return err(-32602, `Unknown tool: ${name}`);
      const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>;
      let result: ToolCallResult;
      try {
        result = await callCommerceTool(ctx, name, args);
      } catch (e) {
        result = toolError('internal', 'The tool failed unexpectedly; nothing more was changed.', {
          reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
        });
      }
      await auditToolCall(ctx, name, args, result);
      return { jsonrpc: '2.0', id, result };
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return isNotification ? null : err(-32601, `Method not found: ${msg.method}`);
  }
}

