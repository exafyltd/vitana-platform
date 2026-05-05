/**
 * Release Backlog & Versioning API (R2 from Phase 2 ticket plan)
 *
 * Read-only matrix endpoint that powers Command Hub /dev/releases and the
 * tenant admin /admin/releases Overview tab. Role-aware: developer and
 * Exafy super-admin see all tenants; tenant_admin sees only their own.
 *
 * See specs/release-backlog-overview.md § 4 for the full API contract and
 * specs/release-backlog-spec-decisions.md for the design decisions (P1-P5).
 *
 * Endpoints (Phase 2):
 *   GET /api/v1/releases/overview — single payload for the matrix view
 *
 * Future endpoints (Phase 4 — tracked in R9):
 *   GET    /api/v1/releases/components            — list with filters
 *   GET    /api/v1/releases/components/:id        — detail incl. last 10 history rows
 *   POST   /api/v1/releases/components            — register new component
 *   PATCH  /api/v1/releases/components/:id        — update fields (NOT current_channel)
 *   POST   /api/v1/releases/components/:id/promote — channel promotion (P3)
 *   GET    /api/v1/releases/history               — filterable list
 *   POST   /api/v1/releases/history               — record a release
 *   GET    /api/v1/releases/backlog               — list with role-aware visibility
 *   POST/PATCH/DELETE /api/v1/releases/backlog/:id — CRUD
 *   GET    /api/v1/releases/changelog/public      — public, no-auth changelog
 */

import { Router, Request, Response } from 'express';

export const releasesRouter = Router();

const LOG_PREFIX = '[releases]';

// =============================================================================
// Supabase helper (matches the routines.ts pattern)
// =============================================================================

async function supabaseRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const text = await response.text();
    const data = (text ? JSON.parse(text) : null) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Types — match the wire format in spec § 4
// =============================================================================

type ReleaseChannel = 'internal' | 'beta' | 'stable';
type Compatibility = 'ok' | 'behind' | 'breaking';
type Surface = 'command_hub' | 'web' | 'api' | 'sdk' | 'desktop' | 'ios' | 'android';

interface ReleaseComponentRow {
  id: string;
  slug: string;
  display_name: string;
  owner: 'platform' | 'tenant';
  tenant_id: string | null;
  surface: Surface;
  current_version: string | null;
  current_channel: ReleaseChannel | null;
  current_released_at: string | null;
  min_platform_version: string | null;
  target_platform_version: string | null;
  public_changelog: boolean;
  enabled: boolean;
}

interface PlatformComponentOut {
  slug: string;
  display_name: string;
  current_version: string | null;
  current_channel: ReleaseChannel | null;
  current_released_at: string | null;
  pending_count: number;
}

interface TenantSurfaceOut {
  slug: string;
  surface: Surface;
  current_version: string | null;
  current_channel: ReleaseChannel | null;
  min_platform_version: string | null;
  compatibility: Compatibility;
  pending_count: number;
}

interface TenantRowOut {
  tenant_id: string;
  name: string;
  surfaces: TenantSurfaceOut[];
}

interface ReleasesOverviewOut {
  platform: PlatformComponentOut[];
  tenants: TenantRowOut[];
}

// =============================================================================
// Compatibility computation (P2: pin against platform.sdk only)
// =============================================================================

function parseSemver(s: string): [number, number, number] {
  // Strip operator prefix (e.g. ">=2.3.0" → "2.3.0") and trim spaces
  const cleaned = s.replace(/^[><=~^]+\s*/, '').trim();
  const parts = cleaned.split('.').map((n) => parseInt(n, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function computeCompatibility(
  currentSdkVersion: string | null,
  minPlatformVersion: string | null,
  targetPlatformVersion: string | null
): Compatibility {
  if (!currentSdkVersion || !minPlatformVersion) return 'ok';
  // If platform SDK is BELOW the tenant's min — tenant code expects features the platform doesn't have yet.
  if (compareSemver(currentSdkVersion, minPlatformVersion) < 0) return 'breaking';
  // If tenant's target is BELOW the live SDK by a major version — tenant is behind.
  if (targetPlatformVersion) {
    const liveMajor = parseSemver(currentSdkVersion)[0];
    const targetMajor = parseSemver(targetPlatformVersion)[0];
    if (liveMajor > targetMajor) return 'behind';
  }
  return 'ok';
}

// =============================================================================
// Pending-count helper
// =============================================================================

async function fetchPendingCounts(componentIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (componentIds.length === 0) return counts;

  // Pending = not done and not dropped
  const idsParam = componentIds.map((id) => `"${id}"`).join(',');
  const result = await supabaseRequest<
    { component_id: string; status: string }[]
  >(
    `/rest/v1/release_backlog_items?component_id=in.(${idsParam})` +
      '&status=in.(proposed,planned,in_progress,blocked)' +
      '&select=component_id,status'
  );

  if (!result.ok || !result.data) return counts;
  for (const row of result.data) {
    counts.set(row.component_id, (counts.get(row.component_id) ?? 0) + 1);
  }
  return counts;
}

// =============================================================================
// Auth helpers
// =============================================================================
// The gateway populates req.user via its existing JWT middleware. We read
// role + tenant_id + isExafyAdmin defensively (the exact shape may differ
// from this stub — refine in code review against the actual middleware).
// =============================================================================

interface CallerContext {
  role: string | null;
  tenant_id: string | null;
  is_exafy_admin: boolean;
  authenticated: boolean;
}

function extractCaller(req: Request): CallerContext {
  const user = (req as { user?: Record<string, unknown> }).user ?? null;
  if (!user) {
    return { role: null, tenant_id: null, is_exafy_admin: false, authenticated: false };
  }
  return {
    role: (user.role as string | undefined) ?? null,
    tenant_id: (user.tenant_id as string | undefined) ?? null,
    is_exafy_admin: Boolean(user.is_exafy_admin),
    authenticated: true,
  };
}

function canSeeAllTenants(caller: CallerContext): boolean {
  return caller.is_exafy_admin || caller.role === 'developer';
}

function canSeeOwnTenant(caller: CallerContext): boolean {
  return canSeeAllTenants(caller) || caller.role === 'admin';
}

// =============================================================================
// GET /api/v1/releases/overview
// =============================================================================

releasesRouter.get('/api/v1/releases/overview', async (req: Request, res: Response) => {
  try {
    const caller = extractCaller(req);
    if (!caller.authenticated) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    if (!canSeeOwnTenant(caller)) {
      return res.status(403).json({ ok: false, error: 'Insufficient role for release overview' });
    }

    // Load all enabled components in one query.
    const componentsResult = await supabaseRequest<ReleaseComponentRow[]>(
      '/rest/v1/release_components?enabled=eq.true&select=*&order=owner.asc,surface.asc'
    );
    if (!componentsResult.ok || !componentsResult.data) {
      return res.status(500).json({
        ok: false,
        error: componentsResult.error || 'Failed to load components',
      });
    }

    const allComponents = componentsResult.data;

    // Compute SDK version for compatibility checks.
    const sdkRow = allComponents.find((c) => c.slug === 'platform.sdk');
    const currentSdkVersion = sdkRow?.current_version ?? null;

    // Apply role-based tenant scoping.
    const visibleComponents = canSeeAllTenants(caller)
      ? allComponents
      : allComponents.filter(
          (c) => c.owner === 'platform' || c.tenant_id === caller.tenant_id
        );

    // Fetch pending backlog counts per component.
    const pendingCounts = await fetchPendingCounts(visibleComponents.map((c) => c.id));

    // Build the platform section.
    const platform: PlatformComponentOut[] = visibleComponents
      .filter((c) => c.owner === 'platform')
      .map((c) => ({
        slug: c.slug,
        display_name: c.display_name,
        current_version: c.current_version,
        current_channel: c.current_channel,
        current_released_at: c.current_released_at,
        pending_count: pendingCounts.get(c.id) ?? 0,
      }));

    // Group tenant components by tenant_id.
    const tenantsMap = new Map<string, ReleaseComponentRow[]>();
    for (const c of visibleComponents) {
      if (c.owner !== 'tenant' || !c.tenant_id) continue;
      const list = tenantsMap.get(c.tenant_id) ?? [];
      list.push(c);
      tenantsMap.set(c.tenant_id, list);
    }

    // Resolve tenant display names. Single best-effort lookup; falls back to
    // tenant_id substring if the tenants table can't be reached.
    const tenantNames = new Map<string, string>();
    if (tenantsMap.size > 0) {
      const ids = Array.from(tenantsMap.keys()).map((id) => `"${id}"`).join(',');
      const tenantsResult = await supabaseRequest<
        { id: string; name: string | null; slug: string | null }[]
      >(`/rest/v1/tenants?id=in.(${ids})&select=id,name,slug`);
      if (tenantsResult.ok && tenantsResult.data) {
        for (const t of tenantsResult.data) {
          tenantNames.set(t.id, t.name ?? t.slug ?? t.id.slice(0, 8));
        }
      }
    }

    const tenants: TenantRowOut[] = Array.from(tenantsMap.entries()).map(
      ([tenant_id, surfaces]) => ({
        tenant_id,
        name: tenantNames.get(tenant_id) ?? tenant_id.slice(0, 8),
        surfaces: surfaces.map((c) => ({
          slug: c.slug,
          surface: c.surface,
          current_version: c.current_version,
          current_channel: c.current_channel,
          min_platform_version: c.min_platform_version,
          compatibility: computeCompatibility(
            currentSdkVersion,
            c.min_platform_version,
            c.target_platform_version
          ),
          pending_count: pendingCounts.get(c.id) ?? 0,
        })),
      })
    );

    const payload: ReleasesOverviewOut = { platform, tenants };
    return res.status(200).json({ ok: true, ...payload, timestamp: new Date().toISOString() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} overview error:`, error);
    return res.status(500).json({ ok: false, error: message });
  }
});
