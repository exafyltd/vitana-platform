/**
 * VTID-03885 — Partner Health Test Integration: ORB voice tools.
 *
 * Sibling to, not a rewrite of, health-depth-tools.ts. Reads ONLY the
 * canonical partner_health_test_orders.status column — never a raw
 * partner status string — per the framework's own hard rule that AI/ORB
 * must never reason from partner-specific terminology.
 *
 * tool_get_health_test_result deliberately reuses biomarker_results (via
 * partner_health_results.biomarker_result_ids), the same table
 * tool_get_lab_results (health-depth-tools.ts) already reads — a
 * DoctorBox result shows up there automatically, no ORB code change
 * needed on that side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

const STATUS_PHRASE: Record<string, string> = {
  ordered: 'ordered and waiting on the partner to ship a sample kit',
  sample_kit_shipped: 'on its way to you — the sample kit has shipped',
  sample_received: 'received by the lab',
  processing: 'being processed at the lab',
  result_ready: 'ready — I can walk you through the results',
  delivered: 'complete — you already have the results',
  cancelled: 'cancelled',
  failed: 'stuck — something went wrong on the partner side',
  quarantined: 'being checked by our team before it can be shown to you',
};

// ---------------------------------------------------------------------------
// 1. get_health_test_status
// ---------------------------------------------------------------------------

export async function tool_get_health_test_status(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient
): Promise<OrbToolResult> {
  const gate = authGate('get_health_test_status', id);
  if (gate) return gate;

  try {
    let query = sb
      .from('partner_health_test_orders')
      .select('id, test_name, status, status_updated_at, expected_result_at, partner_id, partner_registry(display_name)')
      .eq('user_id', id.user_id)
      .order('ordered_at', { ascending: false });

    const testNameFilter = typeof args.test_name === 'string' ? args.test_name.trim() : '';
    if (testNameFilter) query = query.ilike('test_name', `%${testNameFilter}%`);

    const { data, error } = await query.limit(5);
    if (error) return { ok: false, error: error.message };

    const rows = (data as Array<{
      id: string;
      test_name: string;
      status: string;
      status_updated_at: string;
      partner_registry: { display_name: string } | { display_name: string }[] | null;
    }> | null) ?? [];

    if (rows.length === 0) {
      return {
        ok: true,
        result: { orders: [] },
        text: testNameFilter
          ? `You don't have a "${testNameFilter}" test on file with any of our partners.`
          : "You don't have any partner health tests on file right now.",
      };
    }

    const latest = rows[0];
    const partnerName = Array.isArray(latest.partner_registry)
      ? latest.partner_registry[0]?.display_name
      : latest.partner_registry?.display_name;
    const phrase = STATUS_PHRASE[latest.status] ?? latest.status;

    return {
      ok: true,
      result: {
        orders: rows.map((r) => ({ id: r.id, test_name: r.test_name, status: r.status, status_updated_at: r.status_updated_at })),
      },
      text: `Your ${latest.test_name}${partnerName ? ` from ${partnerName}` : ''} is ${phrase}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_health_test_status failed' };
  }
}

// ---------------------------------------------------------------------------
// 2. get_health_test_result
// ---------------------------------------------------------------------------

export async function tool_get_health_test_result(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient
): Promise<OrbToolResult> {
  const gate = authGate('get_health_test_result', id);
  if (gate) return gate;

  try {
    let query = sb
      .from('partner_health_test_orders')
      .select('id, test_name, status')
      .eq('user_id', id.user_id)
      .in('status', ['result_ready', 'delivered'])
      .order('status_updated_at', { ascending: false });

    const testNameFilter = typeof args.test_name === 'string' ? args.test_name.trim() : '';
    if (testNameFilter) query = query.ilike('test_name', `%${testNameFilter}%`);

    const { data: orders, error: orderErr } = await query.limit(1);
    if (orderErr) return { ok: false, error: orderErr.message };
    const order = (orders as Array<{ id: string; test_name: string; status: string }> | null)?.[0];

    if (!order) {
      return {
        ok: true,
        result: null,
        text: "I don't have a completed partner health test result for you yet — I'll let you know as soon as one comes in.",
      };
    }

    const { data: result, error: resultErr } = await sb
      .from('partner_health_results')
      .select('biomarker_result_ids')
      .eq('order_id', order.id)
      .eq('validation_status', 'valid')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (resultErr) return { ok: false, error: resultErr.message };

    const biomarkerIds = (result as { biomarker_result_ids: string[] } | null)?.biomarker_result_ids ?? [];
    if (biomarkerIds.length === 0) {
      return {
        ok: true,
        result: { order_id: order.id, biomarkers: [] },
        text: `Your ${order.test_name} is marked ready, but I can't find the individual values yet — ask again in a moment.`,
      };
    }

    const { data: biomarkers, error: bmErr } = await sb
      .from('biomarker_results')
      .select('name, value, unit, ref_range_low, ref_range_high, status')
      .in('id', biomarkerIds);
    if (bmErr) return { ok: false, error: bmErr.message };

    const rows = (biomarkers as Array<{ name: string; value: number; unit: string | null; status: string | null }> | null) ?? [];
    const summary = rows
      .map((b) => `${b.name}: ${b.value}${b.unit ? ` ${b.unit}` : ''}${b.status ? ` (${b.status})` : ''}`)
      .join('; ');

    return {
      ok: true,
      result: { order_id: order.id, test_name: order.test_name, biomarkers: rows },
      text: `Here's your ${order.test_name}: ${summary}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_health_test_result failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const PARTNER_HEALTH_TEST_TOOL_HANDLERS: Record<string, Handler> = {
  get_health_test_status: tool_get_health_test_status,
  get_health_test_result: tool_get_health_test_result,
};

export const PARTNER_HEALTH_TEST_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'get_health_test_status',
    description: [
      'Get the status of the user\'s partner health test(s) (e.g. a DoctorBox',
      'blood test ordered through Discover). Reads a canonical status —',
      'never a raw partner status string.',
      'CALL WHEN the user asks: "what\'s the status of my blood test?",',
      '"has my DoctorBox test shipped?", "wo ist mein Bluttest?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { test_name: { type: 'string', description: 'Optional test name to filter by, e.g. "cholesterol".' } },
      required: [],
    },
  },
  {
    name: 'get_health_test_result',
    description: [
      'Get the actual biomarker values from a completed partner health test',
      '(status result_ready or delivered) so the model can discuss them.',
      'CALL WHEN the user asks: "what were my blood test results?", "tell me',
      'about my DoctorBox results", "was hat mein Bluttest ergeben?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { test_name: { type: 'string', description: 'Optional test name to filter by.' } },
      required: [],
    },
  },
];
