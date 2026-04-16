/**
 * VTID-02000: Reward-system event emission helpers
 *
 * The marketplace emits 6 `marketplace.commerce.*` OASIS events at every
 * reward-relevant moment. A parallel session is designing the reward system
 * (ready tomorrow); this module is the stable event contract it subscribes to.
 *
 * Rules:
 *   - Every event carries user_id, tenant_id, AND a full attribution chain
 *     (attribution_surface + attribution_recommendation_id).
 *   - Idempotent IDs: click_id joins clicks -> orders; order_id is stable
 *     per purchase so the reward system can safely replay events.
 *   - Fire-and-forget: a failed emission MUST NOT break the commerce path.
 *
 * DO NOT RENAME the event types (`marketplace.click.outbound`, etc.) without
 * coordinating with the parallel reward-system session — these are the
 * committed Phase-0 contract.
 */

import { emitOasisEvent } from './oasis-event-service';
import type { AttributionSurface } from '../types/catalog-ingest';

const VTID = 'VTID-02000';

export interface ClickOutboundPayload {
  user_id: string | null; // null for anonymous clicks
  tenant_id: string | null;
  product_id: string;
  merchant_id: string | null;
  click_id: string;
  attribution_surface: AttributionSurface;
  attribution_recommendation_id?: string | null;
  origin_country: string | null;
  ships_to_countries: string[] | null;
  target_url: string;
}

export async function emitClickOutbound(p: ClickOutboundPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.click.outbound',
      source: 'gateway',
      status: 'info',
      message: `Affiliate click-out for product ${p.product_id}`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        product_id: p.product_id,
        merchant_id: p.merchant_id,
        click_id: p.click_id,
        attribution_surface: p.attribution_surface,
        attribution_recommendation_id: p.attribution_recommendation_id ?? null,
        origin_country: p.origin_country,
        ships_to_countries: p.ships_to_countries,
        target_url: p.target_url,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] click.outbound emission failed (non-fatal):', e);
  }
}

export interface OrderConversionPayload {
  user_id: string;
  tenant_id: string;
  product_id: string | null;
  merchant_id: string | null;
  order_id: string;
  click_id: string | null;
  external_order_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  commission_cents: number | null;
  attribution_surface: AttributionSurface | null;
  attribution_recommendation_id?: string | null;
  condition_key?: string | null;
  purchased_at: string; // ISO
}

export async function emitOrderConversion(p: OrderConversionPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.order.conversion',
      source: 'gateway',
      status: 'info',
      message: `Order conversion ${p.order_id} for product ${p.product_id ?? '(unknown)'}`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        product_id: p.product_id,
        merchant_id: p.merchant_id,
        order_id: p.order_id,
        click_id: p.click_id,
        external_order_id: p.external_order_id,
        amount_cents: p.amount_cents,
        currency: p.currency,
        commission_cents: p.commission_cents,
        attribution_surface: p.attribution_surface,
        attribution_recommendation_id: p.attribution_recommendation_id ?? null,
        condition_key: p.condition_key ?? null,
        purchased_at: p.purchased_at,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] order.conversion emission failed (non-fatal):', e);
  }
}

export interface OutcomeReportedPayload {
  user_id: string;
  tenant_id: string;
  product_id: string;
  order_id?: string | null;
  condition_key?: string | null;
  outcome_type: string; // 'sleep'|'stress'|'movement'|...
  perceived_impact: 'better' | 'same' | 'worse';
  effect_category?: string | null;
  effect_magnitude?: number | null;
  reported_at: string;
}

export async function emitOutcomeReported(p: OutcomeReportedPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.outcome.reported',
      source: 'gateway',
      status: 'info',
      message: `Outcome reported for product ${p.product_id}: ${p.perceived_impact}`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        product_id: p.product_id,
        order_id: p.order_id ?? null,
        condition_key: p.condition_key ?? null,
        outcome_type: p.outcome_type,
        perceived_impact: p.perceived_impact,
        effect_category: p.effect_category ?? null,
        effect_magnitude: p.effect_magnitude ?? null,
        reported_at: p.reported_at,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] outcome.reported emission failed (non-fatal):', e);
  }
}

export interface ShareInitiatedPayload {
  user_id: string;
  tenant_id: string;
  product_id: string;
  share_channel: string; // 'instagram', 'whatsapp', 'email', 'copy_link', ...
  share_id: string;
}

export async function emitShareInitiated(p: ShareInitiatedPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.share.initiated',
      source: 'gateway',
      status: 'info',
      message: `User ${p.user_id} shared product ${p.product_id} via ${p.share_channel}`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        product_id: p.product_id,
        share_channel: p.share_channel,
        share_id: p.share_id,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] share.initiated emission failed (non-fatal):', e);
  }
}

export interface RecommendationAcceptedPayload {
  user_id: string;
  tenant_id: string;
  recommendation_id: string;
  product_id: string | null;
  accepted_at: string;
}

export async function emitRecommendationAccepted(p: RecommendationAcceptedPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.recommendation.accepted',
      source: 'gateway',
      status: 'info',
      message: `Recommendation ${p.recommendation_id} accepted${p.product_id ? ' (product ' + p.product_id + ')' : ''}`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        recommendation_id: p.recommendation_id,
        product_id: p.product_id,
        accepted_at: p.accepted_at,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] recommendation.accepted emission failed (non-fatal):', e);
  }
}

export interface PreferencesUpdatedPayload {
  user_id: string;
  tenant_id: string;
  fields_changed: string[];
  source: 'onboarding' | 'preferences_page' | 'conversation_extracted' | 'admin';
}

export async function emitPreferencesUpdated(p: PreferencesUpdatedPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.preferences.updated',
      source: 'gateway',
      status: 'info',
      message: `User ${p.user_id} updated preferences: ${p.fields_changed.join(', ')}`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        fields_changed: p.fields_changed,
        source: p.source,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] preferences.updated emission failed (non-fatal):', e);
  }
}

// ==================== Safety events (adjacent to reward events) ====================

export interface GeoMismatchPayload {
  user_id: string | null;
  tenant_id: string | null;
  product_id: string;
  user_country: string | null;
  product_origin_country: string | null;
  product_ships_to_regions: string[] | null;
}

export async function emitGeoMismatch(p: GeoMismatchPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.offer.geo_mismatch',
      source: 'gateway',
      status: 'warning',
      message: `Geo mismatch: user in ${p.user_country ?? '?'} clicked product ${p.product_id} not shipping there`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        product_id: p.product_id,
        user_country: p.user_country,
        product_origin_country: p.product_origin_country,
        product_ships_to_regions: p.product_ships_to_regions,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] geo_mismatch emission failed (non-fatal):', e);
  }
}

export interface LimitationViolationPayload {
  user_id: string;
  tenant_id: string;
  product_id: string;
  violated_field: string; // 'allergies' | 'contraindications' | ...
  violated_values: string[];
  surface: string;
}

export async function emitLimitationViolation(p: LimitationViolationPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.limitation.violation',
      source: 'gateway',
      status: 'error', // P1 severity — trust + safety incident
      message: `LIMITATION VIOLATION: user ${p.user_id} saw product ${p.product_id} that violated ${p.violated_field}`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        product_id: p.product_id,
        violated_field: p.violated_field,
        violated_values: p.violated_values,
        surface: p.surface,
        severity: 'P1',
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] limitation.violation emission failed:', e);
  }
}

export interface LimitationBypassPayload {
  user_id: string;
  tenant_id: string;
  bypassed_field: string;
  query_context: Record<string, unknown>;
  source: string;
}

export async function emitLimitationBypass(p: LimitationBypassPayload): Promise<void> {
  try {
    await emitOasisEvent({
      vtid: VTID,
      type: 'marketplace.limitation.bypass',
      source: 'gateway',
      status: 'info',
      message: `User ${p.user_id} bypassed ${p.bypassed_field} for single query`,
      payload: {
        user_id: p.user_id,
        tenant_id: p.tenant_id,
        bypassed_field: p.bypassed_field,
        query_context: p.query_context,
        source: p.source,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[reward-events] limitation.bypass emission failed (non-fatal):', e);
  }
}
