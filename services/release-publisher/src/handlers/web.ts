/**
 * Web (vitanaland.com) edge cache invalidation handler (R16).
 *
 * STUB — Phase 5 scaffold. Production implementation needs:
 *
 *   - CLOUDFLARE_PURGE_TOKEN  (scoped API token with Cache Purge permission)
 *   - CLOUDFLARE_ZONE_ID      (the zone id for vitanaland.com)
 *
 * Implementation outline:
 *   POST https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache
 *   Authorization: Bearer ${CLOUDFLARE_PURGE_TOKEN}
 *   Body: { files: [
 *     'https://vitanaland.com/changelog',
 *     'https://api.vitanaland.com/api/v1/releases/changelog/public'
 *   ] }
 *
 * Reference: https://developers.cloudflare.com/api/operations/zone-purge
 */

interface ReleasePromotedPayload {
  component_slug: string;
  component_id: string;
  version: string;
  release_id: string;
}

export async function handleWeb(payload: ReleasePromotedPayload): Promise<void> {
  const token = process.env.CLOUDFLARE_PURGE_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!token || !zoneId) {
    throw new Error(
      'NOT_IMPLEMENTED: Cloudflare credentials missing. Provision CLOUDFLARE_PURGE_TOKEN and CLOUDFLARE_ZONE_ID before enabling web cache invalidation.'
    );
  }

  // The Cloudflare purge call IS implementable now — it's straightforward
  // and doesn't need complex auth. Wired here as a real call so R16 is
  // production-ready as soon as the secrets are provisioned.
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        files: [
          'https://vitanaland.com/changelog',
          'https://api.vitanaland.com/api/v1/releases/changelog/public',
        ],
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Cloudflare purge failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  console.log('[release-publisher.web] cache purged for', payload.version);
}
