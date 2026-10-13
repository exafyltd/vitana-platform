/**
 * VTID-05150: slugs no tenant may take. A tenant's path URL is
 * `<platform host>/<slug>` (program D5), so a slug must never equal a top-level
 * vitana-v1 route or public file, or a platform word.
 *
 * The list is the checked-in reserved-slugs.json, built from a vitana-v1
 * checkout by scripts/tenants/gen-reserved-slugs.mjs and kept in sync weekly by
 * TENANT-RESERVED-SLUGS-DRIFT.yml. The database holds the same list in
 * reserved_tenant_slugs (migration 20261014000400) and provision_tenant()
 * checks it too; this copy only gives the route a fast 400 before any RPC.
 */
import reserved from './reserved-slugs.json';

export interface ReservedSlugsDoc {
  source_commit: string;
  spa_routes: string[];
  public_files: string[];
  platform: string[];
}

const DOC = reserved as ReservedSlugsDoc;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...DOC.spa_routes,
  ...DOC.public_files,
  ...DOC.platform,
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(String(slug || '').trim().toLowerCase());
}
