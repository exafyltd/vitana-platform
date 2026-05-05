/**
 * Release Backlog & Versioning API
 *
 * Implements the gateway side of the release-backlog system. See:
 *   - specs/release-backlog-overview.md (canonical spec)
 *   - specs/release-backlog-spec-decisions.md (P1–P5 + F1 decisions)
 *
 * Endpoints (Phase 2 + Phase 4 + Phase 5):
 *   GET    /api/v1/releases/overview                     — role-aware matrix (Phase 2)
 *   GET    /api/v1/releases/components                   — list with filters
 *   GET    /api/v1/releases/components/:id               — detail + last 10 history rows
 *   POST   /api/v1/releases/components                   — register new component
 *   PATCH  /api/v1/releases/components/:id               — update fields except current_channel
 *   POST   /api/v1/releases/components/:id/promote       — channel promotion (P3)
 *   GET    /api/v1/releases/history                      — filterable list
 *   POST   /api/v1/releases/history                      — record a release (atomic)
 *   GET    /api/v1/releases/backlog                      — list with role-aware visibility
 *   POST   /api/v1/releases/backlog                      — create item
 *   PATCH  /api/v1/releases/backlog/:id                  — update; rejects status writes for VTID-linked (P1, R12)
 *   DELETE /api/v1/releases/backlog/:id                  — drop item
 *   GET    /api/v1/releases/changelog/public             — public stable-channel changelog (no auth)
 *
 * Auth model:
 *   - developer / isExafyAdmin    — full read/write across all tenants
 *   - admin (tenant_admin)         — read all platform components + own tenant only;
 *                                    write own tenant rows + own tenant backlog only
 *   - other roles                  — 401/403
 *   - /changelog/public            — anonymous (no auth)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const releasesRouter = Router();

const LOG_PREFIX = '[releases]';

// =============================================================================
// Supabase helper (matches routines.ts pattern)
// =============================================================================

async function supabaseRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; data?: T; error?: string; status?: number }> {
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
      return { ok: false, error: `${response.status}: ${errorText}`, status: response.status };
    }

    const text = await response.text();
    const data = (text ? JSON.parse(text) : null) as T;
    return { ok: true, data, status: response.status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Types
// =============================================================================

type ReleaseChannel = 'internal' | 'beta' | 'stable';
type Compatibility = 'ok' | 'behind' | 'breaking';
type Surface = 'command_hub' | 'web' | 'api' | 'sdk' | 'desktop' | 'ios' | 'android';
type BacklogStatus = 'proposed' | 'planned' | 'in_progress' | 'blocked' | 'done' | 'dropped';

interface ReleaseComponentRow {
  id: string;
  slug: string;
  display_name: string;
  owner: 'platform' | 'tenant';
  tenant_id: string | null;
  surface: Surface;
  repo: string | null;
  current_version: string | null;
  current_channel: ReleaseChannel | null;
  current_released_at: string | null;
  current_release_id: string | null;
  min_platform_version: string | null;
  target_platform_version: string | null;
  public_changelog: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface ReleaseHistoryRow {
  id: string;
  component_id: string;
  version: string;
  channel: ReleaseChannel;
  released_at: string;
  released_by: string | null;
  changelog: string | null;
  internal_notes: string | null;
  artifact_url: string | null;
  commit_sha: string | null;
  rollback_of: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface BacklogItemRow {
  id: string;
  component_id: string;
  title: string;
  summary: string | null;
  vtid: string | null;
  status: BacklogStatus;
  target_version: string | null;
  target_channel: ReleaseChannel | null;
  visibility: 'internal' | 'tenant' | 'public';
  priority: number;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// Auth helpers
// =============================================================================

interface CallerContext {
  role: string | null;
  tenant_id: string | null;
  user_id: string | null;
  is_exafy_admin: boolean;
  authenticated: boolean;
}

function extractCaller(req: Request): CallerContext {
  const user = (req as { user?: Record<string, unknown> }).user ?? null;
  if (!user) {
    return {
      role: null,
      tenant_id: null,
      user_id: null,
      is_exafy_admin: false,
      authenticated: false,
    };
  }
  return {
    role: (user.role as string | undefined) ?? null,
    tenant_id: (user.tenant_id as string | undefined) ?? null,
    user_id: (user.id as string | undefined) ?? (user.user_id as string | undefined) ?? null,
    is_exafy_admin: Boolean(user.is_exafy_admin),
    authenticated: true,
  };
}

function canSeeAllTenants(c: CallerContext): boolean {
  return c.is_exafy_admin || c.role === 'developer';
}

function canEditAnyTenant(c: CallerContext): boolean {
  return c.is_exafy_admin || c.role === 'developer';
}

function canEditOwnTenant(c: CallerContext, tenantId: string | null): boolean {
  if (canEditAnyTenant(c)) return true;
  return c.role === 'admin' && tenantId !== null && tenantId === c.tenant_id;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const caller = extractCaller(req);
  if (!caller.authenticated) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return;
  }
  next();
}

// =============================================================================
// Compatibility computation (P2: pin against platform.sdk only)
// =============================================================================

function parseSemver(s: string): [number, number, number] {
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
  if (compareSemver(currentSdkVersion, minPlatformVersion) < 0) return 'breaking';
  if (targetPlatformVersion) {
    const liveMajor = parseSemver(currentSdkVersion)[0];
    const targetMajor = parseSemver(targetPlatformVersion)[0];
    if (liveMajor > targetMajor) return 'behind';
  }
  return 'ok';
}

// =============================================================================
// OASIS event emitter (best-effort, non-blocking)
// =============================================================================

async function emitOasisEvent(
  eventType: string,
  payload: Record<string, unknown>,
  actorId: string | null = null
): Promise<void> {
  try {
    await supabaseRequest('/rest/v1/oasis_events', {
      method: 'POST',
      body: {
        type: eventType,
        source: 'gateway/releases',
        topic: 'release',
        service: 'gateway',
        status: 'ok',
        message: eventType,
        payload,
        metadata: { actor_id: actorId, emitted_at: new Date().toISOString() },
      },
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} oasis emit failed (non-fatal):`, eventType, err);
  }
}

// =============================================================================
// Pending-count helper
// =============================================================================

async function fetchPendingCounts(componentIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (componentIds.length === 0) return counts;

  const idsParam = componentIds.map((id) => `"${id}"`).join(',');
  const result = await supabaseRequest<{ component_id: string }[]>(
    `/rest/v1/release_backlog_items?component_id=in.(${idsParam})` +
      '&status=in.(proposed,planned,in_progress,blocked)' +
      '&select=component_id'
  );

  if (!result.ok || !result.data) return counts;
  for (const row of result.data) {
    counts.set(row.component_id, (counts.get(row.component_id) ?? 0) + 1);
  }
  return counts;
}

// =============================================================================
// GET /api/v1/releases/overview
// =============================================================================

releasesRouter.get('/api/v1/releases/overview', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    if (!canSeeAllTenants(caller) && caller.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Insufficient role for release overview' });
    }

    const componentsResult = await supabaseRequest<ReleaseComponentRow[]>(
      '/rest/v1/release_components?enabled=eq.true&select=*&order=owner.asc,surface.asc'
    );
    if (!componentsResult.ok || !componentsResult.data) {
      return res.status(500).json({ ok: false, error: componentsResult.error || 'Load failed' });
    }

    const allComponents = componentsResult.data;
    const sdkRow = allComponents.find((c) => c.slug === 'platform.sdk');
    const currentSdkVersion = sdkRow?.current_version ?? null;

    const visible = canSeeAllTenants(caller)
      ? allComponents
      : allComponents.filter((c) => c.owner === 'platform' || c.tenant_id === caller.tenant_id);

    const pending = await fetchPendingCounts(visible.map((c) => c.id));

    const platform = visible
      .filter((c) => c.owner === 'platform')
      .map((c) => ({
        slug: c.slug,
        display_name: c.display_name,
        current_version: c.current_version,
        current_channel: c.current_channel,
        current_released_at: c.current_released_at,
        pending_count: pending.get(c.id) ?? 0,
      }));

    const tenantsMap = new Map<string, ReleaseComponentRow[]>();
    for (const c of visible) {
      if (c.owner !== 'tenant' || !c.tenant_id) continue;
      const list = tenantsMap.get(c.tenant_id) ?? [];
      list.push(c);
      tenantsMap.set(c.tenant_id, list);
    }

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

    const tenants = Array.from(tenantsMap.entries()).map(([tenant_id, surfaces]) => ({
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
        pending_count: pending.get(c.id) ?? 0,
      })),
    }));

    return res.status(200).json({
      ok: true,
      platform,
      tenants,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} overview error:`, error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// GET /api/v1/releases/components
// =============================================================================

releasesRouter.get('/api/v1/releases/components', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const params: string[] = ['enabled=eq.true', 'select=*', 'order=owner.asc,surface.asc'];

    const ownerFilter = req.query.owner as string | undefined;
    if (ownerFilter && ['platform', 'tenant'].includes(ownerFilter)) {
      params.push(`owner=eq.${ownerFilter}`);
    }
    const tenantFilter = req.query.tenant_id as string | undefined;
    if (tenantFilter) {
      if (!canSeeAllTenants(caller) && tenantFilter !== caller.tenant_id) {
        return res.status(403).json({ ok: false, error: 'Cannot query other tenants' });
      }
      params.push(`tenant_id=eq.${encodeURIComponent(tenantFilter)}`);
    } else if (!canSeeAllTenants(caller)) {
      // tenant_admin sees platform components + own tenant
      params.push(
        `or=(owner.eq.platform,tenant_id.eq.${encodeURIComponent(caller.tenant_id ?? '')})`
      );
    }
    const surfaceFilter = req.query.surface as string | undefined;
    if (surfaceFilter) params.push(`surface=eq.${encodeURIComponent(surfaceFilter)}`);

    const result = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?${params.join('&')}`
    );
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    return res.status(200).json({ ok: true, components: result.data ?? [] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// GET /api/v1/releases/components/:id  (incl. last 10 history rows)
// =============================================================================

releasesRouter.get('/api/v1/releases/components/:id', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const id = req.params.id;

    const compResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(id)}&select=*`
    );
    if (!compResult.ok || !compResult.data || compResult.data.length === 0) {
      return res.status(404).json({ ok: false, error: 'Component not found' });
    }
    const comp = compResult.data[0];

    if (
      !canSeeAllTenants(caller) &&
      comp.owner === 'tenant' &&
      comp.tenant_id !== caller.tenant_id
    ) {
      return res.status(403).json({ ok: false, error: 'Cannot read other tenants' });
    }

    const historyResult = await supabaseRequest<ReleaseHistoryRow[]>(
      `/rest/v1/release_history?component_id=eq.${encodeURIComponent(id)}` +
        '&select=*&order=released_at.desc&limit=10'
    );
    let history = historyResult.data ?? [];
    // Strip internal_notes for tenant-role callers.
    if (!canSeeAllTenants(caller)) {
      history = history.map((h) => ({ ...h, internal_notes: null }));
    }

    return res.status(200).json({ ok: true, component: comp, history });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// POST /api/v1/releases/components  (developer / super-admin only)
// =============================================================================

const componentCreateSchema = z.object({
  slug: z.string().min(3).max(128).regex(/^[a-z0-9._-]+$/),
  display_name: z.string().min(1).max(128),
  owner: z.enum(['platform', 'tenant']),
  tenant_id: z.string().uuid().nullable().optional(),
  surface: z.enum(['command_hub', 'web', 'api', 'sdk', 'desktop', 'ios', 'android']),
  repo: z.string().max(256).nullable().optional(),
  min_platform_version: z.string().max(64).nullable().optional(),
  target_platform_version: z.string().max(64).nullable().optional(),
  public_changelog: z.boolean().optional(),
});

releasesRouter.post('/api/v1/releases/components', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    if (!canEditAnyTenant(caller)) {
      return res.status(403).json({ ok: false, error: 'Only developer/super-admin can register components' });
    }
    const parsed = componentCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    const body = parsed.data;
    if (body.owner === 'tenant' && !body.tenant_id) {
      return res.status(400).json({ ok: false, error: 'tenant_id required when owner=tenant' });
    }
    if (body.owner === 'platform' && body.tenant_id) {
      return res.status(400).json({ ok: false, error: 'tenant_id must be null when owner=platform' });
    }

    const insertResult = await supabaseRequest<ReleaseComponentRow[]>(
      '/rest/v1/release_components',
      {
        method: 'POST',
        body: {
          slug: body.slug,
          display_name: body.display_name,
          owner: body.owner,
          tenant_id: body.tenant_id ?? null,
          surface: body.surface,
          repo: body.repo ?? null,
          min_platform_version: body.min_platform_version ?? null,
          target_platform_version: body.target_platform_version ?? null,
          public_changelog: body.public_changelog ?? false,
        },
      }
    );
    if (!insertResult.ok || !insertResult.data?.[0]) {
      return res.status(500).json({ ok: false, error: insertResult.error });
    }
    const comp = insertResult.data[0];
    await emitOasisEvent('release.component.registered', { slug: comp.slug, id: comp.id }, caller.user_id);
    return res.status(201).json({ ok: true, component: comp });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// PATCH /api/v1/releases/components/:id  (rejects current_channel writes)
// =============================================================================

const componentPatchSchema = z.object({
  display_name: z.string().min(1).max(128).optional(),
  repo: z.string().max(256).nullable().optional(),
  min_platform_version: z.string().max(64).nullable().optional(),
  target_platform_version: z.string().max(64).nullable().optional(),
  public_changelog: z.boolean().optional(),
  enabled: z.boolean().optional(),
  current_channel: z.never().optional(), // explicitly forbidden — use /promote
}).strict();

releasesRouter.patch('/api/v1/releases/components/:id', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const id = req.params.id;

    if ('current_channel' in (req.body ?? {})) {
      return res.status(400).json({
        ok: false,
        error: 'Channel changes must use POST /api/v1/releases/components/:id/promote',
      });
    }

    const parsed = componentPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
    }

    const compResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(id)}&select=*`
    );
    if (!compResult.ok || !compResult.data?.[0]) {
      return res.status(404).json({ ok: false, error: 'Component not found' });
    }
    const comp = compResult.data[0];
    if (!canEditOwnTenant(caller, comp.tenant_id)) {
      return res.status(403).json({ ok: false, error: 'Cannot edit other tenants' });
    }

    const updateResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: { ...parsed.data, updated_at: new Date().toISOString() },
      }
    );
    if (!updateResult.ok || !updateResult.data?.[0]) {
      return res.status(500).json({ ok: false, error: updateResult.error });
    }
    return res.status(200).json({ ok: true, component: updateResult.data[0] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// POST /api/v1/releases/components/:id/promote  (P3 — channel promotion)
// =============================================================================

const promoteSchema = z.object({
  from: z.enum(['internal', 'beta', 'stable']),
  to: z.enum(['internal', 'beta', 'stable']),
  release_id: z.string().uuid(),
});

const CHANNEL_RANK: Record<ReleaseChannel, number> = { internal: 0, beta: 1, stable: 2 };

releasesRouter.post('/api/v1/releases/components/:id/promote', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const id = req.params.id;

    const parsed = promoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    const { from, to, release_id } = parsed.data;

    // Forward-only progression — reject reverse / skip
    if (CHANNEL_RANK[to] < CHANNEL_RANK[from]) {
      return res.status(400).json({
        ok: false,
        error: `Invalid promotion: ${from} → ${to} is reverse. Use rollback flow instead.`,
      });
    }
    if (CHANNEL_RANK[to] - CHANNEL_RANK[from] > 1) {
      return res.status(400).json({
        ok: false,
        error: `Invalid promotion: ${from} → ${to} skips a channel. Promote step-by-step.`,
      });
    }

    const compResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(id)}&select=*`
    );
    if (!compResult.ok || !compResult.data?.[0]) {
      return res.status(404).json({ ok: false, error: 'Component not found' });
    }
    const comp = compResult.data[0];
    if (!canEditOwnTenant(caller, comp.tenant_id)) {
      return res.status(403).json({ ok: false, error: 'Cannot promote on other tenants' });
    }
    if (comp.current_channel !== from) {
      return res.status(409).json({
        ok: false,
        error: `Component is on '${comp.current_channel}', not '${from}'. Refresh and retry.`,
      });
    }

    // Verify release_id belongs to this component
    const histResult = await supabaseRequest<ReleaseHistoryRow[]>(
      `/rest/v1/release_history?id=eq.${encodeURIComponent(release_id)}` +
        `&component_id=eq.${encodeURIComponent(id)}&select=*`
    );
    if (!histResult.ok || !histResult.data?.[0]) {
      return res.status(404).json({ ok: false, error: 'Release not found for this component' });
    }
    const release = histResult.data[0];

    const now = new Date().toISOString();

    // Record a new history row at the new channel (creates an audit trail for the promotion)
    await supabaseRequest('/rest/v1/release_history', {
      method: 'POST',
      body: {
        component_id: id,
        version: release.version,
        channel: to,
        released_at: now,
        released_by: caller.user_id,
        changelog: release.changelog,
        internal_notes: release.internal_notes,
        artifact_url: release.artifact_url,
        commit_sha: release.commit_sha,
        metadata: { ...release.metadata, promoted_from: from, promotion_source_release_id: release_id },
      },
    });

    // Bump the component's current_channel + current_version + current_release pointer
    await supabaseRequest(`/rest/v1/release_components?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        current_channel: to,
        current_version: release.version,
        current_released_at: now,
        current_release_id: release_id,
        updated_at: now,
      },
    });

    await emitOasisEvent(
      'release.promoted',
      {
        component_slug: comp.slug,
        component_id: id,
        from_channel: from,
        to_channel: to,
        version: release.version,
        release_id,
      },
      caller.user_id
    );
    if (to === 'stable') {
      await emitOasisEvent(
        'release.changelog.published',
        { component_slug: comp.slug, version: release.version, surface: comp.surface },
        caller.user_id
      );
    }

    return res.status(200).json({
      ok: true,
      promoted: { from, to, version: release.version, release_id },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// GET /api/v1/releases/history
// =============================================================================

releasesRouter.get('/api/v1/releases/history', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const params: string[] = ['select=*', 'order=released_at.desc', 'limit=100'];

    const componentId = req.query.component_id as string | undefined;
    const channel = req.query.channel as string | undefined;
    if (componentId) params.push(`component_id=eq.${encodeURIComponent(componentId)}`);
    if (channel && ['internal', 'beta', 'stable'].includes(channel)) {
      params.push(`channel=eq.${channel}`);
    }

    const result = await supabaseRequest<ReleaseHistoryRow[]>(
      `/rest/v1/release_history?${params.join('&')}`
    );
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    let rows = result.data ?? [];
    if (!canSeeAllTenants(caller)) {
      rows = rows.map((r) => ({ ...r, internal_notes: null }));
    }
    return res.status(200).json({ ok: true, history: rows });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// POST /api/v1/releases/history  (atomic: writes history + bumps component current_*)
// =============================================================================

const historyCreateSchema = z.object({
  component_id: z.string().uuid(),
  version: z.string().min(1).max(64),
  channel: z.enum(['internal', 'beta', 'stable']),
  changelog: z.string().max(64_000).nullable().optional(),
  internal_notes: z.string().max(16_000).nullable().optional(),
  artifact_url: z.string().max(1024).nullable().optional(),
  commit_sha: z.string().max(64).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

releasesRouter.post('/api/v1/releases/history', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const parsed = historyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    const compResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(body.component_id)}&select=*`
    );
    if (!compResult.ok || !compResult.data?.[0]) {
      return res.status(404).json({ ok: false, error: 'Component not found' });
    }
    const comp = compResult.data[0];
    if (!canEditOwnTenant(caller, comp.tenant_id)) {
      return res.status(403).json({ ok: false, error: 'Cannot record release for other tenants' });
    }

    const now = new Date().toISOString();
    const insertResult = await supabaseRequest<ReleaseHistoryRow[]>('/rest/v1/release_history', {
      method: 'POST',
      body: {
        component_id: body.component_id,
        version: body.version,
        channel: body.channel,
        released_at: now,
        released_by: caller.user_id,
        changelog: body.changelog ?? null,
        internal_notes: body.internal_notes ?? null,
        artifact_url: body.artifact_url ?? null,
        commit_sha: body.commit_sha ?? null,
        metadata: body.metadata ?? {},
      },
    });
    if (!insertResult.ok || !insertResult.data?.[0]) {
      return res.status(500).json({ ok: false, error: insertResult.error });
    }
    const release = insertResult.data[0];

    // Update component current_* if this release is on the same channel as current
    // (or if the component has no current channel yet — first release).
    if (!comp.current_channel || comp.current_channel === body.channel) {
      await supabaseRequest(
        `/rest/v1/release_components?id=eq.${encodeURIComponent(body.component_id)}`,
        {
          method: 'PATCH',
          body: {
            current_version: body.version,
            current_channel: body.channel,
            current_released_at: now,
            current_release_id: release.id,
            updated_at: now,
          },
        }
      );
    }

    await emitOasisEvent(
      'release.published',
      {
        component_slug: comp.slug,
        component_id: body.component_id,
        version: body.version,
        channel: body.channel,
        release_id: release.id,
      },
      caller.user_id
    );

    return res.status(201).json({ ok: true, release });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// GET /api/v1/releases/backlog  (P1: effective_status read-through for VTID-linked)
// =============================================================================

releasesRouter.get('/api/v1/releases/backlog', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const componentId = req.query.component_id as string | undefined;
    const status = req.query.status as string | undefined;

    const params: string[] = ['select=*', 'order=priority.desc,created_at.desc'];
    if (componentId) params.push(`component_id=eq.${encodeURIComponent(componentId)}`);
    if (status) params.push(`status=eq.${encodeURIComponent(status)}`);

    // Tenant-role visibility filter — only see tenant + public
    if (!canSeeAllTenants(caller)) {
      params.push('visibility=in.(tenant,public)');
    }

    const result = await supabaseRequest<BacklogItemRow[]>(
      `/rest/v1/release_backlog_items?${params.join('&')}`
    );
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    const rows = result.data ?? [];

    // P1: read-through effective_status for VTID-linked items
    const vtids = rows.map((r) => r.vtid).filter((v): v is string => v !== null && v.length > 0);
    const vtidStatusMap = new Map<string, string>();
    if (vtids.length > 0) {
      const ledgerResult = await supabaseRequest<{ vtid: string; status: string }[]>(
        `/rest/v1/vtid_ledger?vtid=in.(${vtids.map((v) => `"${v}"`).join(',')})&select=vtid,status`
      );
      if (ledgerResult.ok && ledgerResult.data) {
        for (const r of ledgerResult.data) {
          vtidStatusMap.set(r.vtid, r.status);
        }
      }
    }

    // Map component_id → component slug for client convenience
    const compIds = Array.from(new Set(rows.map((r) => r.component_id)));
    const compSlugMap = new Map<string, string>();
    if (compIds.length > 0) {
      const compResult = await supabaseRequest<{ id: string; slug: string }[]>(
        `/rest/v1/release_components?id=in.(${compIds.map((id) => `"${id}"`).join(',')})&select=id,slug`
      );
      if (compResult.ok && compResult.data) {
        for (const r of compResult.data) compSlugMap.set(r.id, r.slug);
      }
    }

    const items = rows.map((r) => {
      const linked = r.vtid !== null && r.vtid.length > 0;
      const effective = linked ? vtidStatusMap.get(r.vtid as string) ?? r.status : r.status;
      return {
        id: r.id,
        component_id: r.component_id,
        component_slug: compSlugMap.get(r.component_id) ?? null,
        title: r.title,
        summary: r.summary,
        vtid: r.vtid,
        effective_status: effective,
        vtid_linked: linked,
        target_version: r.target_version,
        target_channel: r.target_channel,
        visibility: r.visibility,
        priority: r.priority,
      };
    });

    return res.status(200).json({ ok: true, items });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// POST /api/v1/releases/backlog
// =============================================================================

const backlogCreateSchema = z.object({
  component_id: z.string().uuid(),
  title: z.string().min(1).max(256),
  summary: z.string().max(4096).nullable().optional(),
  vtid: z.string().regex(/^VTID-[A-Z0-9-]+$/).max(64).nullable().optional(),
  status: z.enum(['proposed', 'planned', 'in_progress', 'blocked', 'done', 'dropped']).optional(),
  target_version: z.string().max(64).nullable().optional(),
  target_channel: z.enum(['internal', 'beta', 'stable']).nullable().optional(),
  visibility: z.enum(['internal', 'tenant', 'public']).optional(),
  priority: z.number().int().optional(),
});

releasesRouter.post('/api/v1/releases/backlog', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const parsed = backlogCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    const compResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(body.component_id)}&select=*`
    );
    if (!compResult.ok || !compResult.data?.[0]) {
      return res.status(404).json({ ok: false, error: 'Component not found' });
    }
    const comp = compResult.data[0];
    if (!canEditOwnTenant(caller, comp.tenant_id)) {
      return res.status(403).json({ ok: false, error: 'Cannot create backlog for other tenants' });
    }

    // P1: validate VTID exists if provided
    if (body.vtid) {
      const vtidResult = await supabaseRequest<{ vtid: string }[]>(
        `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(body.vtid)}&select=vtid`
      );
      if (!vtidResult.ok || !vtidResult.data?.[0]) {
        return res.status(400).json({ ok: false, error: `VTID '${body.vtid}' not found in ledger` });
      }
    }

    const insertResult = await supabaseRequest<BacklogItemRow[]>(
      '/rest/v1/release_backlog_items',
      {
        method: 'POST',
        body: {
          component_id: body.component_id,
          title: body.title,
          summary: body.summary ?? null,
          vtid: body.vtid ?? null,
          status: body.status ?? 'proposed',
          target_version: body.target_version ?? null,
          target_channel: body.target_channel ?? null,
          visibility: body.visibility ?? 'internal',
          priority: body.priority ?? 0,
        },
      }
    );
    if (!insertResult.ok || !insertResult.data?.[0]) {
      return res.status(500).json({ ok: false, error: insertResult.error });
    }
    const item = insertResult.data[0];
    await emitOasisEvent(
      'release.backlog.item.created',
      { item_id: item.id, component_slug: comp.slug, vtid: item.vtid },
      caller.user_id
    );
    return res.status(201).json({ ok: true, item });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// PATCH /api/v1/releases/backlog/:id  (P1: rejects status writes for VTID-linked)
// =============================================================================

const backlogPatchSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  summary: z.string().max(4096).nullable().optional(),
  status: z.enum(['proposed', 'planned', 'in_progress', 'blocked', 'done', 'dropped']).optional(),
  target_version: z.string().max(64).nullable().optional(),
  target_channel: z.enum(['internal', 'beta', 'stable']).nullable().optional(),
  visibility: z.enum(['internal', 'tenant', 'public']).optional(),
  priority: z.number().int().optional(),
}).strict();

releasesRouter.patch('/api/v1/releases/backlog/:id', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const id = req.params.id;

    const parsed = backlogPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
    }

    const itemResult = await supabaseRequest<BacklogItemRow[]>(
      `/rest/v1/release_backlog_items?id=eq.${encodeURIComponent(id)}&select=*`
    );
    if (!itemResult.ok || !itemResult.data?.[0]) {
      return res.status(404).json({ ok: false, error: 'Backlog item not found' });
    }
    const item = itemResult.data[0];

    // Lookup component to validate tenant scoping
    const compResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(item.component_id)}&select=*`
    );
    const comp = compResult.data?.[0];
    if (!comp) return res.status(500).json({ ok: false, error: 'Component lookup failed' });
    if (!canEditOwnTenant(caller, comp.tenant_id)) {
      return res.status(403).json({ ok: false, error: 'Cannot edit backlog for other tenants' });
    }

    // P1: reject status writes for VTID-linked items
    if (item.vtid && parsed.data.status !== undefined) {
      return res.status(409).json({
        ok: false,
        error: 'This item is linked to a VTID. Edit the VTID in vtid_ledger; status is read-through.',
      });
    }

    const updateResult = await supabaseRequest<BacklogItemRow[]>(
      `/rest/v1/release_backlog_items?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: { ...parsed.data, updated_at: new Date().toISOString() },
      }
    );
    if (!updateResult.ok || !updateResult.data?.[0]) {
      return res.status(500).json({ ok: false, error: updateResult.error });
    }
    await emitOasisEvent(
      'release.backlog.item.updated',
      { item_id: id, fields: Object.keys(parsed.data) },
      caller.user_id
    );
    return res.status(200).json({ ok: true, item: updateResult.data[0] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// DELETE /api/v1/releases/backlog/:id
// =============================================================================

releasesRouter.delete('/api/v1/releases/backlog/:id', requireAuth, async (req, res) => {
  try {
    const caller = extractCaller(req);
    const id = req.params.id;

    const itemResult = await supabaseRequest<BacklogItemRow[]>(
      `/rest/v1/release_backlog_items?id=eq.${encodeURIComponent(id)}&select=component_id`
    );
    if (!itemResult.ok || !itemResult.data?.[0]) {
      return res.status(404).json({ ok: false, error: 'Backlog item not found' });
    }
    const compResult = await supabaseRequest<ReleaseComponentRow[]>(
      `/rest/v1/release_components?id=eq.${encodeURIComponent(itemResult.data[0].component_id)}&select=tenant_id`
    );
    const comp = compResult.data?.[0];
    if (!comp) return res.status(500).json({ ok: false, error: 'Component lookup failed' });
    if (!canEditOwnTenant(caller, comp.tenant_id)) {
      return res.status(403).json({ ok: false, error: 'Cannot delete backlog for other tenants' });
    }

    await supabaseRequest(
      `/rest/v1/release_backlog_items?id=eq.${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
    await emitOasisEvent('release.backlog.item.dropped', { item_id: id }, caller.user_id);
    return res.status(204).send();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

// =============================================================================
// GET /api/v1/releases/changelog/public  (R17 — NO AUTH; P4 filter)
// =============================================================================

releasesRouter.get('/api/v1/releases/changelog/public', async (_req, res) => {
  try {
    // Filter: stable channel + component.public_changelog=TRUE
    const result = await supabaseRequest<
      Array<
        ReleaseHistoryRow & {
          release_components: { slug: string; display_name: string; surface: Surface; public_changelog: boolean } | null;
        }
      >
    >(
      '/rest/v1/release_history?channel=eq.stable' +
        '&select=id,version,channel,released_at,changelog,artifact_url,release_components!inner(slug,display_name,surface,public_changelog)' +
        '&release_components.public_changelog=eq.true' +
        '&order=released_at.desc&limit=200'
    );
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });

    const entries = (result.data ?? []).map((r) => ({
      component_slug: r.release_components?.slug ?? null,
      display_name: r.release_components?.display_name ?? null,
      surface: r.release_components?.surface ?? null,
      version: r.version,
      released_at: r.released_at,
      changelog: r.changelog ?? '',
      // internal_notes intentionally NEVER returned here
    }));

    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ ok: true, entries });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});
