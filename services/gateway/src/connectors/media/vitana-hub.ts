/**
 * VTID-01942: Vitana Media Hub connector — in-house, no-auth.
 *
 * Declares the playback capabilities served by the app's own Media Hub:
 *   - music.play   (media_uploads where media_type='music')
 *   - podcast.play (media_uploads where media_type='podcast')
 *   - shorts.play  (media_videos)
 *
 * Every authenticated user is implicitly "connected" to the hub (no OAuth,
 * auth_type=none). Used as the safe default when the user has no external
 * provider connected, and as the only option for content types external
 * providers don't offer (podcasts + shorts today).
 *
 * Playback model: returns the Supabase Storage file_url directly. The orb
 * widget opens it via the existing `open_url` directive — plays as raw
 * audio/video in a new tab. Follow-up VTID will add an `play_internal`
 * directive so the app's built-in <audio>/<video> player picks it up
 * instead (smoother UX, keeps the user inside the app).
 */
import type {
  ActionRequest,
  ActionResult,
  Connector,
  ConnectorContext,
  TokenPair,
} from '../types';

const INTERNAL_HUB_BASE = process.env.GATEWAY_INTERNAL_URL
  || process.env.GATEWAY_PUBLIC_URL
  || 'https://gateway-q74ibpv6ia-uc.a.run.app';

type HubHit = {
  id: string;
  type: 'music' | 'podcast' | 'shorts';
  title: string;
  description?: string;
  thumbnail_url?: string;
  file_url: string;
  artist?: string;
  host?: string;
  series?: string;
  duration_sec?: number;
};

async function searchHub(query: string, type: 'music' | 'podcast' | 'shorts' | 'all'): Promise<HubHit[]> {
  const u = new URL(`${INTERNAL_HUB_BASE}/api/v1/media-hub/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('type', type);
  u.searchParams.set('limit', '5');
  const r = await fetch(u.toString());
  if (!r.ok) return [];
  const json = await r.json().catch(() => null) as { hits?: HubHit[] } | null;
  return json?.hits ?? [];
}

const vitanaHubConnector: Connector = {
  id: 'vitana_hub',
  category: 'social',
  display_name: 'Vitana Media Hub',
  auth_type: 'none',
  capabilities: [
    'music.play',
    'podcast.play',
    'shorts.play',
  ],

  async initialize(): Promise<void> {
    console.log('[vitana_hub] connector ready (no-auth, in-house)');
  },

  async performAction(
    _ctx: ConnectorContext,
    _tokens: TokenPair,
    action: ActionRequest,
  ): Promise<ActionResult> {
    const query = String(action.args?.query ?? '').trim();
    const cap = action.capability;
    const typeFilter: 'music' | 'podcast' | 'shorts' =
      cap === 'music.play' ? 'music'
        : cap === 'podcast.play' ? 'podcast'
          : cap === 'shorts.play' ? 'shorts'
            : 'music';

    if (!query && cap !== 'shorts.play' && cap !== 'podcast.play') {
      return { ok: false, error: `${cap}: "query" arg is required` };
    }

    const hits = await searchHub(query || typeFilter, typeFilter);
    if (hits.length === 0) {
      return { ok: false, error: `No ${typeFilter} found in the Vitana Media Hub for "${query}"` };
    }
    const hit = hits[0];

    return {
      ok: true,
      external_id: hit.id,
      url: hit.file_url,
      raw: {
        action: 'open_url',
        url: hit.file_url,
        title: hit.title,
        channel: hit.artist || hit.host || hit.series || '',
        thumbnail: hit.thumbnail_url,
        source: 'vitana_hub',
        media_type: hit.type,
        query,
        // Hint to the frontend — once an internal-player directive exists,
        // it can use this to render in-app instead of opening a new tab.
        hub_id: hit.id,
      },
    };
  },
};

export default vitanaHubConnector;
