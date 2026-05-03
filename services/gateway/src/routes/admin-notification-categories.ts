/**
 * Admin Notification Categories API — CRUD + Test (BOOTSTRAP-NOTIF-CATEGORIES)
 * Deploy timestamp: 2026-04-16T08:00Z
 *
 * Endpoints:
 * - GET    /              — List all categories (supports ?type=chat&tenant_id=...)
 * - GET    /:id           — Get single category
 * - POST   /              — Create category
 * - PATCH  /:id           — Update category
 * - DELETE /:id           — Soft-delete (set is_active=false)
 * - POST   /:id/test      — Send test notification to admin
 *
 * Security:
 * - All endpoints are protected by the `requireAdmin` middleware.
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../middleware/requireAdmin';
import { notifyUser, NotificationPayload } from '../services/notification-service';

const router = Router();
router.use(requireAdmin);

const VTID = 'ADMIN-NOTIF-CATEGORIES';

const VALID_TYPES = ['chat', 'calendar', 'community'];

// ── Supabase ────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );
}

// ── Slug helper ─────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ── GET / — List all categories ─────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  const { type, tenant_id, include_inactive } = req.query;

  let query = supabase
    .from('notification_categories')
    .select('*')
    .order('type')
    .order('sort_order', { ascending: true });

  if (type && typeof type === 'string' && VALID_TYPES.includes(type)) {
    query = query.eq('type', type);
  }
  if (tenant_id && typeof tenant_id === 'string') {
    query = query.or(`tenant_id.eq.${tenant_id},tenant_id.is.null`);
  } else {
    query = query.is('tenant_id', null);
  }
  if (include_inactive !== 'true') {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) {
    console.error(`[${VTID}] GET / error:`, error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // Group by type
  const grouped: Record<string, any[]> = { chat: [], calendar: [], community: [] };
  for (const cat of data || []) {
    if (grouped[cat.type]) {
      grouped[cat.type].push(cat);
    }
  }

  return res.json({ ok: true, data: grouped, total: (data || []).length });
});

// ── GET /:id — Get single category ─────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('notification_categories')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ ok: false, error: 'CATEGORY_NOT_FOUND' });
  }

  return res.json({ ok: true, data });
});

// ── POST / — Create category ───────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const user = (req as any).user;

  const supabase = getSupabase();
  const {
    type,
    display_name,
    slug: slugInput,
    description,
    icon,
    sort_order,
    default_enabled,
    mapped_types,
    tenant_id,
  } = req.body;

  // Validate required fields
  if (!type || !display_name) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'type and display_name are required' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ ok: false, error: 'INVALID_TYPE', message: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const slug = slugInput || toSlug(display_name);

  // Validate mapped_types is an array
  if (mapped_types && !Array.isArray(mapped_types)) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'mapped_types must be an array' });
  }

  const insertData: Record<string, any> = {
    type,
    slug,
    display_name,
    description: description || null,
    icon: icon || null,
    sort_order: sort_order ?? 0,
    default_enabled: default_enabled ?? true,
    mapped_types: mapped_types || [],
    tenant_id: tenant_id || null,
    created_by: user?.id,
  };

  const { data, error } = await supabase
    .from('notification_categories')
    .insert(insertData)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ ok: false, error: 'SLUG_CONFLICT', message: `Category with slug "${slug}" already exists` });
    }
    console.error(`[${VTID}] POST / error:`, error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  console.log(`[${VTID}] Created category "${slug}" (${type}) by ${user?.email ?? 'unknown'}`);
  return res.status(201).json({ ok: true, data });
});

// ── PATCH /:id — Update category ────────────────────────────

router.patch('/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;

  const supabase = getSupabase();
  const allowedFields = ['display_name', 'description', 'icon', 'sort_order', 'is_active', 'default_enabled', 'mapped_types'];
  const updateData: Record<string, any> = { updated_at: new Date().toISOString() };

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  }

  // Validate type if provided (cannot change type)
  if (req.body.type !== undefined) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'Cannot change category type after creation' });
  }

  const { data, error } = await supabase
    .from('notification_categories')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    console.error(`[${VTID}] PATCH /:id error:`, error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
  if (!data) {
    return res.status(404).json({ ok: false, error: 'CATEGORY_NOT_FOUND' });
  }

  console.log(`[${VTID}] Updated category "${data.slug}" by ${user?.email ?? 'unknown'}`);
  return res.json({ ok: true, data });
});

// ── DELETE /:id — Soft-delete (set is_active=false) ─────────

router.delete('/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('notification_categories')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    console.error(`[${VTID}] DELETE /:id error:`, error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
  if (!data) {
    return res.status(404).json({ ok: false, error: 'CATEGORY_NOT_FOUND' });
  }

  console.log(`[${VTID}] Soft-deleted category "${data.slug}" by ${user?.email ?? 'unknown'}`);
  return res.json({ ok: true, data });
});

// ── POST /:id/test — Send test notification to admin ────────

router.post('/:id/test', async (req: Request, res: Response) => {
  const user = (req as any).user;

  const supabase = getSupabase();

  // Get the category
  const { data: category, error: catError } = await supabase
    .from('notification_categories')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (catError || !category) {
    return res.status(404).json({ ok: false, error: 'CATEGORY_NOT_FOUND' });
  }

  const mappedTypes = category.mapped_types as string[];
  const testType = mappedTypes.length > 0 ? mappedTypes[0] : 'welcome_to_vitana';

  const payload: NotificationPayload = {
    title: `Test: ${category.display_name}`,
    body: `This is a test notification for the "${category.display_name}" category.`,
    data: { test: 'true', category_id: category.id, category_slug: category.slug },
  };

  // Look up the admin's tenant_id from user_tenants
  const { data: tenantRow } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', user?.id)
    .limit(1)
    .single();

  const tenantId = tenantRow?.tenant_id || '00000000-0000-0000-0000-000000000000';

  try {
    const result = await notifyUser(user?.id, tenantId, testType, payload, supabase);
    console.log(`[${VTID}] Test notification sent for category "${category.slug}" by ${user?.email ?? 'unknown'}`);
    return res.json({ ok: true, result });
  } catch (err: any) {
    console.error(`[${VTID}] POST /:id/test error:`, err.message);
    return res.status(500).json({ ok: false, error: 'SEND_FAILED' });
  }
});

export default router;