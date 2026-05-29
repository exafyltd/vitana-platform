/**
 * Community cache worker (staging) — Phase 1 W1 (VTID-03180 CACHE).
 *
 * Sits in front of gateway-staging and serves cacheable GET responses from
 * Cloudflare KV with stale-while-revalidate semantics.
 *
 * Cache decision:
 *   1. Method must be GET.
 *   2. Path must be in CACHEABLE_PATHS or match CATALOG_PATTERNS.
 *   3. Request must not carry user-specific headers that would taint the
 *      cached object (Authorization, Cookie, X-Tenant-Override, etc.).
 *
 * Cache key:  `${pathname}?${sortedSearchString}` — query-order normalized.
 * Cache TTL:  per-route family (env vars SWR_DEFAULT_S / SWR_CATALOG_S).
 * Cache miss: fetch from gateway, store the response if eligible, return it.
 * Cache hit:  return cached body immediately; if stale, schedule a
 *             background refresh via ctx.waitUntil.
 *
 * Personalized mutation purge: the worker watches POST/PUT/PATCH/DELETE
 * requests and purges any cached object whose path-prefix matches the
 * mutated resource's path. This is intentionally aggressive — better to
 * over-purge than serve stale personalized data.
 */

const CACHEABLE_PATHS = new Set([
  '/api/v1/autopilot/recommendations',
  '/api/v1/vitana-index/detail',
  '/api/v1/vitana-index/overview',
  '/api/v1/intents/board',
  '/api/v1/community/feed',
  '/api/v1/community/discover',
  '/api/v1/marketplace/feed',
  '/api/v1/marketplace/categories',
  '/api/v1/knowledge/topics',
  '/api/v1/diary/templates',
]);

const CATALOG_PATTERNS = [
  /^\/api\/v1\/catalog\//,
  /^\/api\/v1\/marketplace\/products\//,
];

const PURGE_TRIGGERS = [
  '/api/v1/memory',
  '/api/v1/intents',
  '/api/v1/calendar',
  '/api/v1/autopilot/intent',
];

const PERSONAL_HEADERS = ['authorization', 'cookie', 'x-tenant-override', 'x-user-override'];

function isCacheableGet(request, url) {
  if (request.method !== 'GET') return false;
  if (CACHEABLE_PATHS.has(url.pathname)) return true;
  return CATALOG_PATTERNS.some((re) => re.test(url.pathname));
}

function isCatalogPath(pathname) {
  if (CATALOG_PATTERNS.some((re) => re.test(pathname))) return true;
  return pathname === '/api/v1/knowledge/topics' || pathname === '/api/v1/diary/templates';
}

function hasPersonalHeaders(request) {
  return PERSONAL_HEADERS.some((h) => request.headers.has(h));
}

function normalizeKey(url) {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return qs ? `${url.pathname}?${qs}` : url.pathname;
}

async function fromKv(env, key) {
  const raw = await env.COMMUNITY_CACHE_KV.getWithMetadata(key, { type: 'json' });
  if (!raw || !raw.value) return null;
  return { value: raw.value, metadata: raw.metadata || {} };
}

async function toKv(env, key, body, init, ttlSeconds) {
  try {
    await env.COMMUNITY_CACHE_KV.put(
      key,
      JSON.stringify({ body, init }),
      {
        expirationTtl: Math.max(60, ttlSeconds * 4), // hold past SWR window so background refresh works
        metadata: { stored_at: Date.now(), ttl_s: ttlSeconds },
      },
    );
  } catch (err) {
    console.error('[community-cache] KV put failed:', err);
  }
}

async function purgePrefix(env, prefix) {
  // Soft purge — KV has no batch delete by prefix on free tier; track in a
  // small marker so subsequent reads treat anything from before this
  // timestamp as instantly stale.
  try {
    await env.COMMUNITY_CACHE_KV.put(`__purge_marker__:${prefix}`, String(Date.now()), {
      expirationTtl: 60 * 60 * 24,
    });
  } catch (err) {
    console.error('[community-cache] purge marker failed:', err);
  }
}

async function getPurgeMarker(env, pathname) {
  for (const prefix of PURGE_TRIGGERS) {
    if (pathname.startsWith(prefix)) {
      const raw = await env.COMMUNITY_CACHE_KV.get(`__purge_marker__:${prefix}`);
      if (raw) return Number(raw);
    }
  }
  return 0;
}

function buildResponse(body, init) {
  const headers = new Headers(init.headers || {});
  headers.set('x-cache-source', 'community-cache');
  return new Response(body, { status: init.status, statusText: init.statusText, headers });
}

async function fetchAndCache(request, env, url, key, ttlSeconds, source) {
  const upstreamUrl = new URL(url.pathname + url.search, env.GATEWAY_ORIGIN);
  const upstreamReq = new Request(upstreamUrl.toString(), {
    method: 'GET',
    headers: filterHeaders(request.headers),
  });
  const upstream = await fetch(upstreamReq);
  if (!upstream.ok) return upstream;
  const body = await upstream.text();
  const maxBytes = Number(env.MAX_CACHEABLE_BYTES || 65536);
  if (body.length <= maxBytes) {
    const init = {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: Object.fromEntries([...upstream.headers.entries()]),
    };
    init.headers['x-cache-status'] = source;
    await toKv(env, key, body, init, ttlSeconds);
    return buildResponse(body, init);
  }
  // Too large to cache; pass through.
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

function filterHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === 'host') continue;
    out.set(k, v);
  }
  out.set('x-forwarded-by', 'community-cache');
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Mutations: forward + schedule a purge marker.
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      ctx.waitUntil((async () => {
        for (const prefix of PURGE_TRIGGERS) {
          if (url.pathname.startsWith(prefix)) {
            await purgePrefix(env, prefix);
            break;
          }
        }
      })());
      const upstreamUrl = new URL(url.pathname + url.search, env.GATEWAY_ORIGIN);
      return fetch(new Request(upstreamUrl.toString(), {
        method: request.method,
        headers: filterHeaders(request.headers),
        body: request.body,
      }));
    }

    if (!isCacheableGet(request, url) || hasPersonalHeaders(request)) {
      const upstreamUrl = new URL(url.pathname + url.search, env.GATEWAY_ORIGIN);
      const upstream = await fetch(new Request(upstreamUrl.toString(), {
        method: 'GET',
        headers: filterHeaders(request.headers),
      }));
      const headers = new Headers(upstream.headers);
      headers.set('x-cache-source', 'community-cache');
      headers.set('x-cache-status', 'BYPASS');
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    }

    const ttlSeconds = isCatalogPath(url.pathname)
      ? Number(env.SWR_CATALOG_S || 300)
      : Number(env.SWR_DEFAULT_S || 30);
    const key = normalizeKey(url);
    const purgeAfter = await getPurgeMarker(env, url.pathname);
    const cached = await fromKv(env, key);

    if (cached) {
      const storedAt = Number(cached.metadata.stored_at || 0);
      const age = (Date.now() - storedAt) / 1000;
      const stale = age > ttlSeconds || storedAt < purgeAfter;
      cached.value.init.headers['x-cache-status'] = stale ? 'STALE' : 'HIT';
      cached.value.init.headers['age'] = String(Math.floor(age));

      if (stale) {
        ctx.waitUntil(fetchAndCache(request, env, url, key, ttlSeconds, 'REVALIDATE'));
      }
      return buildResponse(cached.value.body, cached.value.init);
    }

    return fetchAndCache(request, env, url, key, ttlSeconds, 'MISS');
  },
};
