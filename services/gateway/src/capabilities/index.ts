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
 * BOOTSTRAP-YT-MUSIC-ALIAS: connection-provider aliases per capability.
 *
 * A user who connects YouTube from Settings → Connected Apps gets a
 * `social_connections` row with `provider='youtube'` (VTID-01928 — a
 * dedicated narrow-scope provider that shares Google's OAuth client but
 * only requests `youtube.readonly` so users aren't forced to grant
 * Gmail + Calendar access just to play music).
 *
 * The `music.play` capability is declared only by the `google` connector,
 * which naively looks for `provider='google'` rows. Without this alias
 * the resolver would say "YouTube isn't connected" even though the user
 * clearly just connected YouTube — the exact bug this fix targets.
 *
 * Returns the ordered list of `social_connections.provider` values that
 * satisfy this connector for this capability. Order matters: the dispatcher
 * loads the first active row it finds.
 *
 * For `google` + `music.play`, the narrower `youtube`-scoped token is
 * preferred over the bundled `google` token — it's the scope that was
 * specifically granted for YouTube, and both tokens are equally capable
 * of calling the YouTube Data API v3 search endpoint used internally.
 */
export function storageProvidersFor(
  connectorId: string,
  capabilityId: string,
): string[] {
  if (connectorId === 'google' && capabilityId === 'music.play') {
    return ['youtube', 'google'];
  }
  return [connectorId];
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
  reason: 'explicit' | 'preference' | 'external_connected' | 'hub_fallback';
  /** Only set when reason='preference' — so the UI can show "your default". */
  preference_set_method?: 'explicit' | 'learned' | 'onboarding';
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
  const isAvailable = (cId: string, auth: string): boolean => {
    if (auth === 'none') return true;
    return storageProvidersFor(cId, capabilityId).some((p) => activeIds.has(p));
  };

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

  // ── Rule 2: stored preference for this capability ─────────────────────
  // VTID-01942 PR 2: user_capability_preferences row. Honoured only if
  // the preferred connector is still available.
  const { data: prefRow } = await supabase
    .from('user_capability_preferences')
    .select('preferred_connector_id, set_method')
    .eq('user_id', userId)
    .eq('capability_id', capabilityId)
    .maybeSingle();
  if (prefRow?.preferred_connector_id) {
    const pref = candidates.find((c) => c.id === prefRow.preferred_connector_id);
    if (pref && isAvailable(pref.id, pref.auth_type)) {
      return {
        connectorId: pref.id,
        reason: 'preference',
        preference_set_method: (prefRow.set_method as 'explicit' | 'learned' | 'onboarding') ?? 'explicit',
      };
    }
    // Preferred connector is no longer available — fall through. Future
    // enhancement: clear the stale row so we don't keep checking it.
  }

  // ── Rule 4: prefer any externally-connected connector ─────────────────
  const externalConnected = candidates.find(
    (c) => c.auth_type !== 'none' && isAvailable(c.id, c.auth_type),
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

  // VTID-01942 PR 2: log successful plays so we can suggest a default later.
  let suggestDefault = false;
  if (result.ok) {
    try {
      await ctx.supabase.from('capability_play_log').insert({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        capability_id: capabilityId,
        connector_id: resolved.connectorId,
        reason: resolved.reason,
        args: dispatchArgs,
        ok: true,
      });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[capabilities] play-log insert failed: ${m}`);
    }

    // Learned-preference prompt: after 3 successful plays through the same
    // non-hub, non-preference-backed connector and no existing pref, tell
    // the caller to suggest setting it as default. We never save the pref
    // silently — the user has to confirm through the /preferences API (or a
    // voice confirmation handled by the ORB).
    if (
      resolved.reason === 'external_connected' &&
      !explicitSource
    ) {
      const { count: existingPrefCount } = await ctx.supabase
        .from('user_capability_preferences')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId)
        .eq('capability_id', capabilityId);

      if ((existingPrefCount ?? 0) === 0) {
        const { data: recent } = await ctx.supabase
          .from('capability_play_log')
          .select('connector_id')
          .eq('user_id', ctx.userId)
          .eq('capability_id', capabilityId)
          .eq('ok', true)
          .order('created_at', { ascending: false })
          .limit(3);

        const lastThree = (recent ?? []).map((r: any) => r.connector_id);
        if (
          lastThree.length === 3 &&
          lastThree.every((id) => id === resolved.connectorId)
        ) {
          suggestDefault = true;
        }
      }
    }
  }

  return {
    ...result,
    routing_reason: resolved.reason,
    preference_set_method: resolved.preference_set_method,
    suggest_default: suggestDefault,
  } as DispatchResult & {
    routing_reason: string;
    preference_set_method?: string;
    suggest_default?: boolean;
  };
}
