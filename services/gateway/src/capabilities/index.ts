/**
 * VTID-01939: Capability catalogue and resolver.
 *
 * A **capability** is a voice-intent-level verb (music.play, email.read,
 * calendar.create). Multiple connectors can advertise the same capability
 * (e.g. music.play might eventually be served by google, spotify, apple).
 * The resolver picks the best connector that (a) declares the capability
 * and (b) has an active connection for the calling user.
 *
 * Adding a new capability = add one entry to CAPABILITIES below and have
 * at least one connector declare it in its `capabilities` array.
 *
 * The voice agent queries listCapabilities() at session start to know
 * which tools to expose to Gemini Live.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { listConnectors, getConnector } from '../connectors';
import { dispatchAction, type DispatchContext, type DispatchResult } from '../connectors/runtime/dispatcher';

export interface CapabilityDefinition {
  /** Dot-separated id, e.g. 'music.play'. */
  id: string;
  /** Short description, shown in voice-agent tool registration. */
  description: string;
  /** JSON Schema of required args. */
  args_schema: Record<string, unknown>;
  /** Declares the shape of a successful result — useful for voice response shaping. */
  result_shape: 'open_url' | 'structured_list' | 'ack' | 'text';
}

export const CAPABILITIES: CapabilityDefinition[] = [
  {
    id: 'music.play',
    description: 'Play a song, album or playlist. Returns a URL that opens the music provider app or web player.',
    args_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Track / artist / album search query (e.g. "Beat It by Michael Jackson")' },
      },
    },
    result_shape: 'open_url',
  },
  {
    id: 'email.read',
    description: 'Return the N most recent unread emails as a structured list.',
    args_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
        from: { type: 'string', description: 'Optional sender filter' },
      },
    },
    result_shape: 'structured_list',
  },
  {
    id: 'email.send',
    description: 'Send an email from the connected account.',
    args_schema: {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
    },
    result_shape: 'ack',
  },
  {
    id: 'calendar.list',
    description: 'Return upcoming events from the user\'s primary calendar.',
    args_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'integer', default: 7, minimum: 1, maximum: 60 },
      },
    },
    result_shape: 'structured_list',
  },
  {
    id: 'calendar.create',
    description: 'Add an event to the user\'s primary calendar.',
    args_schema: {
      type: 'object',
      required: ['title', 'start'],
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'RFC3339 start time' },
        end:   { type: 'string', description: 'RFC3339 end time (default: start + 1h)' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string', format: 'email' } },
      },
    },
    result_shape: 'ack',
  },
  {
    id: 'contacts.read',
    description: 'List the user\'s contacts (name + email).',
    args_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring to filter on' },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
      },
    },
    result_shape: 'structured_list',
  },
  {
    id: 'contacts.import',
    description: 'Import the user\'s provider contacts into Vitana user_contacts (for sharing, invitations).',
    args_schema: { type: 'object' },
    result_shape: 'ack',
  },
];

export function listCapabilities(): CapabilityDefinition[] {
  return CAPABILITIES;
}

export function getCapability(id: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/**
 * Find the best connector for a given capability, given which connectors the
 * user currently has active. Today picks the first match; future version will
 * honour user-per-capability preferences (e.g. music.play via Spotify not
 * YouTube Music) stored in a user_capability_preferences table.
 */
export async function resolveConnectorFor(
  supabase: SupabaseClient,
  userId: string,
  capabilityId: string,
): Promise<{ connectorId: string } | { error: string }> {
  const cap = getCapability(capabilityId);
  if (!cap) return { error: `Unknown capability ${capabilityId}` };

  const candidates = listConnectors().filter((c) => c.capabilities.includes(capabilityId));
  if (candidates.length === 0) {
    return { error: `No connector declares capability ${capabilityId}` };
  }

  const { data: active } = await supabase
    .from('social_connections')
    .select('provider')
    .eq('user_id', userId)
    .eq('is_active', true);

  const activeIds = new Set((active ?? []).map((r) => r.provider));
  const hit = candidates.find((c) => activeIds.has(c.id));
  if (!hit) {
    return {
      error: `Capability ${capabilityId} requires a connected provider (one of: ${candidates.map((c) => c.id).join(', ')})`,
    };
  }
  return { connectorId: hit.id };
}

/**
 * High-level entry point: resolve the best connector for a capability, then
 * dispatch. This is what voice tool handlers and the capabilities HTTP route
 * call into.
 */
export async function executeCapability(
  ctx: DispatchContext,
  capabilityId: string,
  args?: Record<string, unknown>,
): Promise<DispatchResult | { ok: false; capability: string; error: string; connector?: string }> {
  const resolved = await resolveConnectorFor(ctx.supabase, ctx.userId, capabilityId);
  if ('error' in resolved) {
    return { ok: false, capability: capabilityId, error: resolved.error };
  }
  // Double-check that connector is still loaded.
  if (!getConnector(resolved.connectorId)) {
    return { ok: false, capability: capabilityId, error: `Connector ${resolved.connectorId} not registered` };
  }
  return dispatchAction(ctx, {
    connectorId: resolved.connectorId,
    capability: capabilityId,
    args,
  });
}
