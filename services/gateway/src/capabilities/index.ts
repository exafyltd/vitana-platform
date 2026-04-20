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

export interface ResolveOptions {
  /**
   * Explicit connector id extracted from the user's phrase (e.g. "on Spotify",
   * "from the Vitana hub"). If set, the resolver honours it or errors — it does
   * NOT silently fall back. The voice tool is responsible for mapping natural
   * language into one of the known connector ids.
   */
  explicitSource?: string;
}

export interface ResolveSuccess {
  connectorId: string;
  /** Which rule picked this connector — useful for telemetry and UX. */
  reason: 'explicit' | 'external_connected' | 'hub_fallback';
}

/**
 * VTID-01942: Priority ladder for picking a connector for a capability.
 *
 *   1. Explicit source in the phrase → honour or error.
 *   2. (PR 2) User's stored preference for this capability.
 *   3. (PR 2) Learned preference based on recent play counts.
 *   4. Any external (non-'none' auth) connector the user has active → use it.
 *   5. Fall back to an always-available 'none'-auth connector (Vitana Media Hub).
 *   6. Nothing available → error pointing to Connected Apps settings.
 *
 * Rules 2 and 3 land in the preferences PR; the existing shape of the return
 * value is compatible so callers don't need to change.
 */
export async function resolveConnectorFor(
  supabase: SupabaseClient,
  userId: string,
  capabilityId: string,
  options: ResolveOptions = {},
): Promise<ResolveSuccess | { error: string }> {
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
  const isAvailable = (cId: string, auth: string): boolean =>
    auth === 'none' || activeIds.has(cId);

  // ── Rule 1: explicit source from the user phrase ──────────────────────
  if (options.explicitSource) {
    const exact = candidates.find((c) => c.id === options.explicitSource);
    if (!exact) {
      return {
        error: `"${options.explicitSource}" doesn't provide ${capabilityId}. ` +
          `Available: ${candidates.map((c) => c.id).join(', ')}.`,
      };
    }
    if (!isAvailable(exact.id, exact.auth_type)) {
      return {
        error: `"${options.explicitSource}" isn't connected. ` +
          `Connect it in Settings → Connected Apps.`,
      };
    }
    return { connectorId: exact.id, reason: 'explicit' };
  }

  // ── Rule 4: prefer any externally-connected connector ─────────────────
  const externalConnected = candidates.find(
    (c) => c.auth_type !== 'none' && activeIds.has(c.id),
  );
  if (externalConnected) {
    return { connectorId: externalConnected.id, reason: 'external_connected' };
  }

  // ── Rule 5: always-available in-house fallback (Vitana Media Hub) ─────
  const hub = candidates.find((c) => c.auth_type === 'none');
  if (hub) return { connectorId: hub.id, reason: 'hub_fallback' };

  // ── Rule 6: nothing to route to ───────────────────────────────────────
  return {
    error:
      `${capabilityId} requires a connected provider ` +
      `(one of: ${candidates.map((c) => c.id).join(', ')}).`,
  };
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
  // VTID-01942: args.source, if present, becomes the explicit source hint.
  // The voice tool parses phrases like "on Spotify" into args.source='spotify'.
  const explicitSource = typeof args?.source === 'string' && args.source.trim()
    ? args.source.trim()
    : undefined;

  const resolved = await resolveConnectorFor(ctx.supabase, ctx.userId, capabilityId, {
    explicitSource,
  });
  if ('error' in resolved) {
    return { ok: false, capability: capabilityId, error: resolved.error };
  }
  if (!getConnector(resolved.connectorId)) {
    return { ok: false, capability: capabilityId, error: `Connector ${resolved.connectorId} not registered` };
  }

  // Strip internal-only "source" hint before dispatching to the connector —
  // performAction should only see capability-specific args.
  const dispatchArgs = { ...(args ?? {}) };
  delete (dispatchArgs as Record<string, unknown>).source;

  const result = await dispatchAction(ctx, {
    connectorId: resolved.connectorId,
    capability: capabilityId,
    args: dispatchArgs,
  });
  // Surface why this connector was chosen so the UI / voice layer can
  // shape the response ("Playing on YouTube Music — your default" vs
  // "I don't have that in the hub, want me to link your music account?").
  return { ...result, routing_reason: resolved.reason } as DispatchResult & { routing_reason: string };
}
