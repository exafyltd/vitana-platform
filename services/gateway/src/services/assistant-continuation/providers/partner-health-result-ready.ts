/**
 * VTID-03885 — Partner Health Test Integration: partner-health-result-ready
 * continuation provider.
 *
 * The differentiating moment the whole feature exists for: when a partner
 * health-test result (DoctorBox first) lands, ORB's NEXT wake opens with
 * "your result is in" instead of a generic greeting, per the spec's explicit
 * requirement. Built on unread-messages-announce.ts's verified template —
 * grounded DB read -> short factual userFacingLine -> deterministic
 * `cta.type==='navigate'` -> dedupeKey -> evidence[].
 *
 * Priority 94.5 — between new-day-return (94) and first-time-welcome /
 * guided-topic-narration (95-96), same tier as unread-messages-announce
 * (93.5): a one-shot event fact, not an ongoing urgency-banded signal.
 *
 * Content is deliberately short/factual with no quoted exemplar dialogue —
 * the same lesson every guided-topic/day-close content-filter incident in
 * this codebase's history has already taught (nova-instruction-sanitizer.ts,
 * VTID-03674): short factual leads don't trip Nova's content filter, quoted
 * persona-voiced speech does.
 *
 * Dedupe: `partner_health_test_orders.surfaced_at` is set the moment this
 * provider hands a candidate to the ranker (not only once actually spoken —
 * there is no "this candidate won and was spoken" callback available to an
 * individual provider today, the same coarse-grained tradeoff every sibling
 * provider's dedupeKey-only approach already accepts). The user is never
 * left uninformed either way: ingestPartnerResult() already sent a real
 * push/in-app notification for the same event, independent of this ORB line.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
  AssistantContinuation,
} from '../types';

export const PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY = 'partner_health_result_ready' as const;
export const PARTNER_HEALTH_RESULT_READY_EXTRA_KEY = 'partnerHealthResultReady' as const;

/** Between new-day-return (94) and first-time-welcome/guided-topic (95-96) — see file header. */
export const PARTNER_HEALTH_RESULT_READY_PRIORITY = 94.5;

export interface PartnerHealthResultReadyInputs {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  lang: string;
}

export interface PartnerHealthResultReadyProviderOptions {
  now?: () => number;
  priority?: number;
}

function readInputs(ctx: ContinuationDecisionContext): PartnerHealthResultReadyInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[PARTNER_HEALTH_RESULT_READY_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.userId !== 'string' || o.userId.length === 0) return null;
  if (typeof o.tenantId !== 'string' || o.tenantId.length === 0) return null;
  if (!o.supabase) return null;
  return {
    supabase: o.supabase as SupabaseClient,
    userId: o.userId,
    tenantId: o.tenantId,
    lang: typeof o.lang === 'string' && o.lang.length > 0 ? o.lang : 'en',
  };
}

/** Pure render — exported for tests. */
export function renderPartnerHealthResultReadyLine(args: { lang: string; testName: string; partnerName: string | null }): string {
  const de = args.lang.toLowerCase().startsWith('de');
  const partnerSuffix = args.partnerName ? (de ? ` von ${args.partnerName}` : ` from ${args.partnerName}`) : '';
  if (de) {
    return `Deine ${args.testName}-Ergebnisse${partnerSuffix} sind da — ich kann sie mit dir durchgehen.`;
  }
  return `Your ${args.testName} results${partnerSuffix} are in — I can walk you through them.`;
}

export function makePartnerHealthResultReadyProvider(
  opts: PartnerHealthResultReadyProviderOptions = {},
): ContinuationProvider {
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? PARTNER_HEALTH_RESULT_READY_PRIORITY;

  return {
    key: PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_partner_health_inputs',
        };
      }

      let order: { id: string; test_name: string; partner_registry: { display_name: string } | { display_name: string }[] | null } | null;
      try {
        const { data, error } = await inputs.supabase
          .from('partner_health_test_orders')
          .select('id, test_name, partner_registry(display_name)')
          .eq('user_id', inputs.userId)
          .eq('tenant_id', inputs.tenantId)
          .in('status', ['result_ready', 'delivered'])
          .is('surfaced_at', null)
          .order('status_updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        order = data as typeof order;
      } catch (err) {
        return {
          providerKey: PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (!order) {
        return {
          providerKey: PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_unsurfaced_result',
        };
      }

      const partnerName = Array.isArray(order.partner_registry)
        ? order.partner_registry[0]?.display_name ?? null
        : order.partner_registry?.display_name ?? null;

      // Mark surfaced BEFORE returning — see file header for why this is a
      // deliberate, accepted coarse-grained tradeoff, not an oversight.
      await inputs.supabase
        .from('partner_health_test_orders')
        .update({ surfaced_at: new Date().toISOString() })
        .eq('id', order.id);

      const line = renderPartnerHealthResultReadyLine({ lang: inputs.lang, testName: order.test_name, partnerName });

      const candidate: AssistantContinuation = {
        id: `partner-health-result-ready-${order.id}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: line,
        cta: {
          type: 'navigate',
          route: '/health',
          payload: { screen_id: 'HEALTH.LAB_RESULTS', order_id: order.id },
        },
        evidence: [{ kind: 'partner_health_result_ready', detail: `order_id=${order.id}` }],
        dedupeKey: `partner-health-result-ready:${order.id}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: PARTNER_HEALTH_RESULT_READY_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}
