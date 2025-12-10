import { Router, Request, Response } from 'express';
import { z } from 'zod';

export const router = Router();

const VALID_STATUSES = ['scheduled', 'in_progress', 'completed', 'failed'] as const;
const StatusUpdateSchema = z.object({
  status: z.enum(VALID_STATUSES),
});

/**
 * GET /api/v1/tasks
 * 
 * Adapter endpoint that reads from vtid_ledger and transforms rows
 * into task objects compatible with Command Hub Task Board UI.
 * 
 * Database columns (vtid_ledger):
 * - vtid, layer, module, status, title, summary, created_at, updated_at
 * 
 * TEMPORARY COMPATIBILITY FIELDS:
 * - task_family: mirrors module (for existing UI code)
 * - task_type: mirrors module (for existing UI code)
 * - description: uses summary if available, otherwise title
 * 
 * These compatibility fields exist because the current Task Board UI
 * expects them. Future governance work may refactor this adapter.
 */
router.get('/api/v1/tasks', async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: "Misconfigured" });

    const limit = req.query.limit || '100';
    const layer = req.query.layer as string;
    const status = req.query.status as string;

    let url = `${supabaseUrl}/rest/v1/vtid_ledger?order=updated_at.desc&limit=${limit}`;
    if (layer) url += `&layer=eq.${layer}`;
    if (status) url += `&status=eq.${status}`;

    const resp = await fetch(url, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: "Query failed" });

    const data = await resp.json() as any[];
    
    // Transform database rows into task objects
    const tasks = data.map(row => ({
      // Core fields from vtid_ledger
      vtid: row.vtid,
      layer: row.layer,
      module: row.module,
      status: row.status,
      
      // Primary display fields
      title: row.title,
      description: row.summary ?? row.title, // Prefer summary, fallback to title
      summary: row.summary,
      
      // TEMPORARY compatibility fields for existing Task Board UI
      // TODO: Future governance work may refactor these
      task_family: row.module,  // TEMP: mirror module
      task_type: row.module,    // TEMP: mirror module
      
      // Metadata
      assigned_to: row.assigned_to ?? null,
      metadata: row.metadata ?? null,
      
      // Timestamps
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return res.json({ 
      data: tasks, 
      meta: { 
        count: tasks.length, 
        limit: parseInt(limit as string), 
        has_more: false 
      } 
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/vtid/:vtid
 * 
 * Returns detail for a specific VTID with the same field mapping
 * as /api/v1/tasks for consistency.
 */
router.get('/api/v1/vtid/:vtid', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: "Misconfigured" });

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: "Query failed" });
    const data = await resp.json() as any[];
    if (data.length === 0) return res.status(404).json({ error: "VTID not found", vtid });

    const row = data[0];
    return res.json({
      ok: true,
      data: {
        // Core fields
        vtid: row.vtid,
        layer: row.layer,
        module: row.module,
        status: row.status,

        // Primary display fields
        title: row.title,
        description: row.summary ?? row.title,
        summary: row.summary,

        // TEMPORARY compatibility fields
        task_family: row.module,  // TEMP: mirror module
        task_type: row.module,    // TEMP: mirror module

        // Metadata
        assigned_to: row.assigned_to ?? null,
        metadata: row.metadata ?? null,

        // Timestamps
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/v1/tasks/:id/status
 *
 * Updates the status of a task identified by its VTID.
 * Accepts status values: 'scheduled', 'in_progress', 'completed', 'failed'
 *
 * Request body: { "status": "in_progress" }
 * Response: { "ok": true, "id": "VTID-0528", "status": "in_progress" }
 */
router.patch('/api/v1/tasks/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Validate request body
    const validation = StatusUpdateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid status',
        detail: `Status must be one of: ${VALID_STATUSES.join(', ')}`,
        validation_errors: validation.error.errors
      });
    }

    const { status } = validation.data;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({ error: 'Gateway misconfigured' });
    }

    // Update the task status in vtid_ledger
    const payload = {
      status,
      updated_at: new Date().toISOString()
    };

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: 'return=representation'
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      return res.status(502).json({ error: 'Database update failed' });
    }

    const data = await resp.json() as any[];
    if (data.length === 0) {
      return res.status(404).json({ error: 'Task not found', id });
    }

    const updated = data[0];
    return res.json({
      ok: true,
      id: updated.vtid,
      vtid: updated.vtid,
      status: updated.status,
      title: updated.title,
      updated_at: updated.updated_at
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});
