/**
 * VTID-03260 — Propose-then-approve shopping agent (Phase 1) gateway slice.
 *
 * Endpoint (mounted at /api/v1/shopping-agent):
 *   POST /propose — Fill the caller's ONE active universal cart with
 *                   AGENT-PROPOSED items, each carrying a rationale + soft
 *                   safety flags + confidence. The user later reviews and taps
 *                   the existing Approve & Pay (universal-cart POST /checkout).
 *
 * THIS ENDPOINT MUST NEVER CHECK OUT and never charges anything. It only reads
 * products (through the limitations-filtered search path) and writes proposal
 * rows into universal_cart_items. No Stripe, no wallet, no product_orders.
 *
 * Conventions mirrored from universal-cart.ts:
 *   - Community-role-only via the cart's `authorizeCommunityCaller` (same 403
 *     `cart_unavailable_for_role` shape on non-community sessions).
 *   - createUserSupabaseClient(token) for RLS-evaluated cart writes.
 *   - emitCartEvent() service-role audit emission (best-effort).
 *   - { ok, error?, ... } response envelopes; zod request validation.
 *
 * Safety invariant (by construction): the agent selects candidates ONLY through
 * agent-core's searchCandidates(), which runs applyUserLimitations() — the same
 * hard-filter substrate discover-search uses. A hard-blocked product (allergen /
 * contraindicated condition / medication interaction / excluded region) is
 * removed before the agent ever sees it, so it can NEVER be proposed.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { getSupabase } from '../lib/supabase';
import { authorizeCommunityCaller, emitCartEvent } from './universal-cart';
import { getUserHealthContext } from '../services/user-health-context';
import { runPropose, type AnnotatedPick, type InsertPickFn } from '../services/shopping-agent/agent-core';
import { getMonthlySpend } from '../services/budget/spend-service';
import { buildReorderPicks } from '../services/shopping-agent/reorder-core';

/** Default currency fallback (matches the rest of the gateway's commerce code). */
const DEFAULT_CURRENCY = 'EUR';

export const VTID = 'VTID-03260';

const router = Router();

// =============================================================================
// Request schema (frozen contract)
// =============================================================================

const ProposeBody = z.object({
  prompt: z.string().min(1).max(500),
  max_items: z.number().int().optional(),
});

/** Clamp max_items to 1..6, default 4. */
function clampMaxItems(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 4;
  return Math.max(1, Math.min(6, Math.floor(raw)));
}

const ReorderBody = z.object({
  max_items: z.number().int().optional(),
});

/** Clamp reorder max_items to 1..10, default 6. */
function clampReorderMaxItems(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 6;
  return Math.max(1, Math.min(10, Math.floor(raw)));
}

function isNoRowsError(error: any): boolean {
  return error?.code === 'PGRST116';
}
function isUniqueViolation(error: any): boolean {
  return error?.code === '23505';
}

// =============================================================================
// Routes
// =============================================================================

/** GET /health — sanity check; no auth needed (mirrors universal-cart). */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, vtid: VTID, scope: 'shopping_agent_propose_phase_1' });
});

/**
 * POST /propose — plan → select (limitations-filtered) → annotate → write into
 * the active cart. NEVER checks out.
 */
router.post('/propose', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  // impact-allow-no-oasis: each proposed item emits an item.added cart event to
  // universal_cart_events via emitCartEvent (the end-user commerce sink), not
  // oasis_events. oasis_events is the VTID lifecycle/governance log (CLAUDE.md
  // §6), not a commerce ledger — identical to the universal-cart slice's
  // handlers (see universal-cart.ts checkout). No state transition here belongs
  // in OASIS; this endpoint only fills a cart and never charges.

  const parsed = ProposeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_request',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const maxItems = clampMaxItems(parsed.data.max_items);

  // Brain: allergies / dietary / conditions / medications / goals / budget / geo.
  const ctx = await getUserHealthContext(id.user_id);

  // Read-only product search uses the service-role client (same as discover-search).
  const searchClient = getSupabase();

  // Phase 2: standing month-to-date CONVERTED spend (per the user's currency) so
  // the near/over monthly-cap advisory reflects total projected spend. READ-ONLY;
  // advisory only — never blocks the proposal.
  const proposeCurrency = ctx.currency ?? DEFAULT_CURRENCY;
  const monthlySpendCents = await getMonthlySpend(searchClient, id.user_id, proposeCurrency);

  // Cart writes use the RLS-scoped user client (owner isolation enforced by RLS).
  const userClient = createUserSupabaseClient(id.token);

  // Resolve-or-create the caller's active cart up front so every proposed item
  // lands in the same cart. Mirrors universal-cart POST /items cart resolution.
  const cartResolution = await resolveActiveCartId(userClient, id.user_id, id.tenant_id);
  if (!cartResolution.ok) {
    return res.status(500).json({ ok: false, error: cartResolution.error });
  }
  const cartId = cartResolution.cartId;

  const runId = randomUUID();

  // The insert path the agent calls per pick: write one universal_cart_items
  // row with the agent metadata blob, price lock, source_surface 'autopilot'.
  const insertPick: InsertPickFn = async (pick: AnnotatedPick, rid: string, proposedAt: string) => {
    const insertPayload: Record<string, unknown> = {
      cart_id: cartId,
      item_type: pick.item_type,
      product_id: pick.product_id,
      quantity: 1,
      status: 'active',
      source_surface: 'autopilot',
      metadata: {
        origin: 'agent',
        rationale: pick.rationale,
        safety_flags: pick.safety_flags,
        confidence: pick.confidence,
        run_id: rid,
        proposed_at: proposedAt,
      },
    };
    // Price lock: snapshot unit price + currency at proposal time.
    if (pick.unit_price_cents_snapshot !== null) insertPayload.unit_price_cents_snapshot = pick.unit_price_cents_snapshot;
    if (pick.currency_snapshot !== null) insertPayload.currency_snapshot = pick.currency_snapshot;

    const inserted = await userClient
      .from('universal_cart_items')
      .insert(insertPayload)
      .select('id')
      .single();

    if (inserted.error || !inserted.data) {
      return { ok: false, error: inserted.error?.message ?? 'item_insert_failed' };
    }

    const itemId = inserted.data.id as string;

    // Audit: same item.added event the cart emits on a manual add.
    await emitCartEvent({
      cart_id: cartId,
      user_id: id.user_id,
      event_type: 'item.added',
      event_payload: {
        cart_item_id: itemId,
        product_id: pick.product_id,
        quantity_before: 0,
        quantity_after: 1,
        source_surface: 'autopilot',
      },
    });

    return { ok: true, item_id: itemId };
  };

  const result = await runPropose({
    prompt: parsed.data.prompt,
    maxItems,
    ctx,
    supabase: searchClient,
    insertPick,
    runId,
    monthly_spend_cents: monthlySpendCents,
  });

  // Fail loud when no LLM provider is configured/reachable. NEVER fabricate picks.
  if (!result.ok) {
    if (result.error === 'llm_unavailable') {
      return res.status(502).json({ ok: false, error: 'llm_unavailable' });
    }
    return res.status(500).json({ ok: false, error: result.error ?? 'propose_failed' });
  }

  return res.status(200).json({
    ok: true,
    run_id: result.run_id,
    proposed: result.proposed ?? [],
    advisory: result.advisory ?? [],
  });
});

/**
 * POST /reorder — build reorder picks from the caller's past purchases and write
 * them into the active cart via the SAME insertPick path /propose uses, tagged
 * metadata.origin='reorder'. NEVER checks out, never charges. Out-of-stock /
 * inactive SKUs are dropped (buildReorderPicks), and CURRENT price/currency is
 * re-snapshotted at proposal time.
 */
router.post('/reorder', async (req: Request, res: Response) => {
  const id = await authorizeCommunityCaller(req, res);
  if (!id) return;

  // impact-allow-no-oasis: each reordered item emits an item.added cart event to
  // universal_cart_events via emitCartEvent (the end-user commerce sink), not
  // oasis_events. oasis_events is the VTID lifecycle/governance log (CLAUDE.md
  // §6), not a commerce ledger — identical to the /propose slice's handler. No
  // state transition here belongs in OASIS; this endpoint only fills a cart and
  // never charges.

  const parsed = ReorderBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_request',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const maxItems = clampReorderMaxItems(parsed.data.max_items);

  // Brain: carries past_purchases (converted product_orders, newest-first).
  const ctx = await getUserHealthContext(id.user_id);

  // Read-only product hydrate uses the service-role client (same as /propose).
  const searchClient = getSupabase();

  // Cart writes use the RLS-scoped user client (owner isolation enforced by RLS).
  const userClient = createUserSupabaseClient(id.token);

  const cartResolution = await resolveActiveCartId(userClient, id.user_id, id.tenant_id);
  if (!cartResolution.ok) {
    return res.status(500).json({ ok: false, error: cartResolution.error });
  }
  const cartId = cartResolution.cartId;

  const runId = randomUUID();
  const proposedAt = new Date().toISOString();

  // Build reorder picks (dedupe → hydrate → drop non-in-stock/inactive → re-snapshot).
  const picks = await buildReorderPicks(searchClient, ctx, maxItems);

  if (picks.length === 0) {
    return res.status(200).json({
      ok: true,
      run_id: runId,
      proposed: [],
      advisory: ['no_reorderable_items'],
    });
  }

  // SAME insert path as /propose: one universal_cart_items row per pick, with the
  // agent metadata blob (origin='reorder') + price lock + source_surface 'autopilot'.
  const proposed: Array<{
    item_id: string;
    product_id: string;
    title: string;
    rationale: string;
    safety_flags: string[];
    confidence: number;
  }> = [];

  for (const pick of picks) {
    const insertPayload: Record<string, unknown> = {
      cart_id: cartId,
      item_type: pick.item_type,
      product_id: pick.product_id,
      quantity: 1,
      status: 'active',
      source_surface: 'autopilot',
      metadata: {
        origin: 'reorder',
        rationale: pick.rationale,
        safety_flags: pick.safety_flags,
        confidence: pick.confidence,
        run_id: runId,
        proposed_at: proposedAt,
        previously_purchased_at: pick.previously_purchased_at,
      },
    };
    // Price lock: snapshot CURRENT unit price + currency at proposal time.
    if (pick.unit_price_cents_snapshot !== null) insertPayload.unit_price_cents_snapshot = pick.unit_price_cents_snapshot;
    if (pick.currency_snapshot !== null) insertPayload.currency_snapshot = pick.currency_snapshot;

    const inserted = await userClient
      .from('universal_cart_items')
      .insert(insertPayload)
      .select('id')
      .single();

    if (inserted.error || !inserted.data) {
      console.error(`[${VTID}] reorder insert failed for product ${pick.product_id}: ${inserted.error?.message}`);
      continue; // best-effort: a single failed insert must not sink the whole run
    }

    const itemId = inserted.data.id as string;

    // Audit: same item.added event the cart emits on a manual add.
    await emitCartEvent({
      cart_id: cartId,
      user_id: id.user_id,
      event_type: 'item.added',
      event_payload: {
        cart_item_id: itemId,
        product_id: pick.product_id,
        quantity_before: 0,
        quantity_after: 1,
        source_surface: 'autopilot',
      },
    });

    proposed.push({
      item_id: itemId,
      product_id: pick.product_id,
      title: pick.title,
      rationale: pick.rationale,
      safety_flags: pick.safety_flags,
      confidence: pick.confidence,
    });
  }

  return res.status(200).json({
    ok: true,
    run_id: runId,
    proposed,
    advisory: [],
  });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get-or-create the caller's ONE active universal cart and return its id.
 * Mirrors the resolution block in universal-cart POST /items, including the
 * partial-unique-index race recovery.
 */
async function resolveActiveCartId(
  userClient: ReturnType<typeof createUserSupabaseClient>,
  userId: string,
  tenantId: string | null
): Promise<{ ok: true; cartId: string } | { ok: false; error: string }> {
  const cartLookup = await userClient
    .from('universal_carts')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (cartLookup.error && !isNoRowsError(cartLookup.error)) {
    return { ok: false, error: 'cart_lookup_failed' };
  }
  if (cartLookup.data?.id) {
    return { ok: true, cartId: cartLookup.data.id as string };
  }

  const newCart = await userClient
    .from('universal_carts')
    .insert({ user_id: userId, tenant_id: tenantId, status: 'active', metadata: {} })
    .select('id')
    .single();

  if (newCart.error && isUniqueViolation(newCart.error)) {
    const racedCart = await userClient
      .from('universal_carts')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    if (racedCart.data?.id) return { ok: true, cartId: racedCart.data.id as string };
    return { ok: false, error: 'cart_create_failed' };
  }
  if (newCart.error || !newCart.data?.id) {
    return { ok: false, error: 'cart_create_failed' };
  }

  // Emit cart.created for the freshly created cart (mirrors the cart route).
  await emitCartEvent({
    cart_id: newCart.data.id as string,
    user_id: userId,
    event_type: 'cart.created',
    event_payload: {},
  });

  return { ok: true, cartId: newCart.data.id as string };
}

export default router;

// Deploy marker: governed redeploy for VTID-03260 (universal cart agent phases 0-2).
