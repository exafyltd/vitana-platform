import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

export const oasisTasksRouter = Router();

// ===========================================================================
// VTID-0542: Global VTID Allocator Feature Flags
// ===========================================================================

// When enabled, manual VTID creation is blocked - must use allocator
const VTID_ALLOCATOR_ENABLED = process.env.VTID_ALLOCATOR_ENABLED === 'true';

const TaskCreateSchema = z.object({
  title: z.string().min(1, "Title is required"),
  vtid: z.string().optional(),
  layer: z.string().default("oasis"),
  module: z.string().default("tasks"),
  status: z.enum(["scheduled", "in_progress", "completed", "pending", "blocked", "cancelled"]).default("scheduled"),
  summary: z.string().optional(),
  assigned_to: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const TaskUpdateSchema = z.object({
  title: z.string().optional(),
  status: z.enum(["scheduled", "in_progress", "completed", "pending", "blocked", "cancelled"]).optional(),
  summary: z.string().optional(),
  assigned_to: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

oasisTasksRouter.get('/api/v1/oasis/tasks', async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string;
    const layer = req.query.layer as string;

    let queryParams = `limit=${limit}&offset=${offset}&order=updated_at.desc`;
    if (status) queryParams += `&status=eq.${status}`;
    if (layer) queryParams += `&layer=eq.${layer}`;

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?${queryParams}`, {
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database query failed' });

    const data = await resp.json() as any[];
    const tasks = data.map(row => ({
      id: row.vtid, vtid: row.vtid, title: row.title, description: row.summary ?? row.title,
      status: row.status, layer: row.layer, module: row.module, assigned_to: row.assigned_to,
      metadata: row.metadata, created_at: row.created_at, updated_at: row.updated_at,
    }));

    return res.status(200).json(tasks);
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

oasisTasksRouter.post('/api/v1/oasis/tasks', async (req: Request, res: Response) => {
  try {
    const validation = TaskCreateSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: 'Validation failed', detail: validation.error.errors });

    const body = validation.data;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    // ===========================================================================
    // VTID-0542 D5: Manual/CTO path rule enforcement guard
    // When allocator is enabled, VTIDs MUST be allocated via /api/v1/vtid/allocate
    // Manual VTID creation is blocked to prevent split-brain
    // ===========================================================================
    if (VTID_ALLOCATOR_ENABLED) {
      console.log('[VTID-0542] D5 Guard: Allocator enabled, blocking manual task creation');
      return res.status(403).json({
        error: 'manual_vtid_blocked',
        message: 'VTID must be allocated via POST /api/v1/vtid/allocate. Manual VTID creation is disabled when allocator is active.',
        vtid: 'VTID-0542',
        help: 'Use the Command Hub "+Task" button or Operator Console /task command to create tasks with auto-allocated VTIDs.'
      });
    }

    // Legacy path: Only available when allocator is disabled
    console.log('[VTID-0542] D5 Guard: Allocator disabled, allowing legacy manual creation');

    const vtid = body.vtid || `OASIS-TASK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const payload = { vtid, title: body.title, summary: body.summary ?? null, layer: body.layer, module: body.module, status: body.status, assigned_to: body.assigned_to ?? null, metadata: body.metadata ?? null };

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database insert failed' });

    const data = await resp.json();
    const created = Array.isArray(data) ? data[0] : data;
    return res.status(201).json({ id: created.vtid, vtid: created.vtid, title: created.title, status: created.status, created_at: created.created_at });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

oasisTasksRouter.get('/api/v1/oasis/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${id}`, {
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database query failed' });
    const data = await resp.json() as any[];
    if (data.length === 0) return res.status(404).json({ error: 'Task not found', id });

    const row = data[0];
    return res.status(200).json({ id: row.vtid, vtid: row.vtid, title: row.title, status: row.status, layer: row.layer, module: row.module, created_at: row.created_at, updated_at: row.updated_at });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

oasisTasksRouter.patch('/api/v1/oasis/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const validation = TaskUpdateSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: 'Validation failed' });

    const body = validation.data;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    const payload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.title !== undefined) payload.title = body.title;
    if (body.status !== undefined) payload.status = body.status;
    if (body.summary !== undefined) payload.summary = body.summary;
    // VTID-01010: Support metadata update (including target_roles)
    if (body.metadata !== undefined) payload.metadata = body.metadata;

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database update failed' });
    const data = await resp.json() as any[];
    if (data.length === 0) return res.status(404).json({ error: 'Task not found', id });

    return res.status(200).json({ id: data[0].vtid, vtid: data[0].vtid, title: data[0].title, status: data[0].status });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

oasisTasksRouter.delete('/api/v1/oasis/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database delete failed' });
    return res.status(200).json({ ok: true, deleted: id });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});
