/**
 * Community voice tools — Business Hub (A6, partial), Wave 4 of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Only create_service has real backing. The other 13 planned A6 tools
 * (list/update/archive services, packages, clients, business orders, KPIs,
 * earnings, opportunities, reseller payouts) have NO backend at all:
 * `services_catalog` has no owner/creator column (confirmed via
 * automation-handlers/business-marketplace.ts's own comment), and there is
 * no packages/clients/orders/reseller table anywhere in the schema. Per
 * the "no new backend features" rule, those 13 stay `status: planned`
 * rather than being faked against the wrong tables.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const SERVICE_TYPES = ['coaching', 'consulting', 'workshop', 'class', 'session', 'other'];

// ---------------------------------------------------------------------------
// create_service — POST /api/v1/catalog/services (RPC catalog_add_service)
// ---------------------------------------------------------------------------

export const create_service: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'create_service requires an authenticated user.' };
  if (!id.user_jwt) {
    return { ok: true, result: { reason: 'no_session' }, text: "I need your signed-in session to do that." };
  }
  const name = String(args.name ?? '').trim();
  const serviceType = String(args.service_type ?? '').trim();
  if (!name || !SERVICE_TYPES.includes(serviceType)) {
    return { ok: false, error: `create_service requires name and service_type (one of ${SERVICE_TYPES.join(', ')}).` };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, name, service_type: serviceType },
      text: `About to create a "${serviceType}" service listing: "${name}". Note: there's no way to list/edit/archive it by voice yet — you'll need the Business Hub screen for that. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/catalog/services', {
    method: 'POST',
    headers: { Authorization: `Bearer ${id.user_jwt}` },
    body: {
      name,
      service_type: serviceType,
      topic_keys: Array.isArray(args.topic_keys) ? args.topic_keys : [],
      provider_name: typeof args.provider_name === 'string' ? args.provider_name : undefined,
      metadata: typeof args.metadata === 'object' && args.metadata ? args.metadata : undefined,
    },
  });
  if (!ok) return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the service listing: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { created: true, detail: body }, text: `Service "${name}" created.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const BUSINESS_HUB_TOOL_HANDLERS: Record<string, Handler> = {
  create_service,
};

export const BUSINESS_HUB_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'create_service',
    description: 'Create a service listing in the Business Hub catalog. NOTE: there is no way to list, edit, or archive services by voice yet. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Required.' },
        service_type: { type: 'string', description: 'coaching, consulting, workshop, class, session, or other. Required.' },
        topic_keys: { type: 'array', items: { type: 'string' } },
        provider_name: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['name', 'service_type'],
    },
  },
];
