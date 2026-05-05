/**
 * release-publisher entrypoint (R13).
 *
 * Subscribes to OASIS events of type `release.promoted` and dispatches each
 * to the surface-specific handler (R14 iOS, R15 Android, R16 web).
 *
 * Phase 5 scaffold: subscription, dispatch, retry/dead-letter wiring complete.
 * Handlers are stubs (see ./handlers/*) until external API credentials are
 * provisioned per services/release-publisher/README.md.
 */

import { handleIos } from './handlers/ios';
import { handleAndroid } from './handlers/android';
import { handleWeb } from './handlers/web';

interface ReleasePromotedPayload {
  component_slug: string;
  component_id: string;
  from_channel: 'internal' | 'beta' | 'stable';
  to_channel: 'internal' | 'beta' | 'stable';
  version: string;
  release_id: string;
}

interface OasisEvent {
  id: string;
  type: string;
  payload: ReleasePromotedPayload;
  created_at: string;
}

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 2_000;

async function fetchSurface(componentId: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const resp = await fetch(
    `${url}/rest/v1/release_components?id=eq.${componentId}&select=surface`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as Array<{ surface: string }>;
  return data[0]?.surface ?? null;
}

async function emitOasis(
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/oasis_events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      type,
      source: 'release-publisher',
      topic: 'release',
      service: 'release-publisher',
      payload,
      created_at: new Date().toISOString(),
    }),
  }).catch((err) => console.warn('[release-publisher] OASIS emit failed:', err));
}

async function dispatch(event: OasisEvent): Promise<void> {
  // Only stable promotions trigger external propagation
  if (event.payload.to_channel !== 'stable') {
    console.log('[release-publisher] skipping non-stable promotion:', event.payload);
    return;
  }

  const surface = await fetchSurface(event.payload.component_id);
  if (!surface) {
    console.warn('[release-publisher] could not resolve surface for component:', event.payload.component_id);
    return;
  }

  await emitOasis('release.publish.attempted', {
    ...event.payload,
    surface,
    source_event_id: event.id,
  });

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      switch (surface) {
        case 'ios':
          await handleIos(event.payload);
          break;
        case 'android':
          await handleAndroid(event.payload);
          break;
        case 'web':
          await handleWeb(event.payload);
          break;
        default:
          console.log('[release-publisher] surface not handled:', surface);
          return;
      }
      console.log(`[release-publisher] success: ${surface} ${event.payload.version}`);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[release-publisher] attempt ${attempt}/${MAX_RETRIES} failed for ${surface}:`,
        lastErr.message
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }

  // Exhausted retries — dead-letter
  await emitOasis('release.publish.failed', {
    ...event.payload,
    surface,
    source_event_id: event.id,
    error: lastErr?.message ?? 'unknown',
  });
}

async function pollLoop(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    console.error('[release-publisher] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE — exiting');
    process.exit(1);
  }

  let cursor = new Date(Date.now() - 60_000).toISOString();

  // Phase 5 scaffold: simple polling. Production should use Supabase Realtime.
  console.log('[release-publisher] starting poll loop, cursor =', cursor);
  while (true) {
    try {
      const resp = await fetch(
        `${url}/rest/v1/oasis_events?type=eq.release.promoted&created_at=gt.${encodeURIComponent(cursor)}&select=id,type,payload,created_at&order=created_at.asc&limit=50`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (!resp.ok) {
        console.warn('[release-publisher] poll fetch failed:', resp.status);
      } else {
        const events = (await resp.json()) as OasisEvent[];
        for (const event of events) {
          await dispatch(event);
          cursor = event.created_at;
        }
      }
    } catch (err) {
      console.warn('[release-publisher] poll loop error:', err);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

pollLoop().catch((err) => {
  console.error('[release-publisher] fatal:', err);
  process.exit(1);
});
