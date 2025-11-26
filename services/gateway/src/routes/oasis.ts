/**
 * OASIS Router
 * Mounted at: /api/v1/oasis
 *
 * Provides OASIS-compliant endpoints for:
 * - Tasks (GET/POST /tasks)
 * - Specs (GET /specs/dev-screen-inventory)
 *
 * Note: /events endpoint exists in events.ts
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

// Supabase configuration
const getSupabaseConfig = () => {
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!svcKey || !supabaseUrl) {
    throw new Error('Supabase not configured');
  }
  return { svcKey, supabaseUrl };
};

/**
 * GET /tasks
 *
 * Returns tasks from vtid_ledger in OASIS-compatible format.
 * Query params: limit, layer, status
 */
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const { svcKey, supabaseUrl } = getSupabaseConfig();

    const limit = req.query.limit || '50';
    const layer = req.query.layer as string;
    const status = req.query.status as string;

    let url = `${supabaseUrl}/rest/v1/vtid_ledger?order=updated_at.desc&limit=${limit}`;
    if (layer) url += `&layer=eq.${layer}`;
    if (status) url += `&status=eq.${status}`;

    const resp = await fetch(url, {
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
    });

    if (!resp.ok) {
      return res.status(502).json({ ok: false, error: 'Database query failed' });
    }

    const data = await resp.json() as any[];

    // Transform to OASIS task format
    const tasks = data.map(row => ({
      id: row.id,
      vtid: row.vtid,
      layer: row.layer,
      module: row.module,
      status: row.status,
      title: row.title,
      summary: row.summary,
      description: row.summary ?? row.title,
      assigned_to: row.assigned_to ?? null,
      metadata: row.metadata ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return res.status(200).json(tasks);

  } catch (e: any) {
    console.error('[OASIS Tasks] GET error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /tasks
 *
 * Creates a new task in vtid_ledger and emits an OASIS event.
 * Body: { title, vtid, status, summary?, layer?, module?, metadata? }
 */
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { svcKey, supabaseUrl } = getSupabaseConfig();

    const { title, vtid, status, summary, layer, module } = req.body;

    // Validation
    if (!title) {
      return res.status(400).json({ ok: false, error: 'title is required' });
    }
    if (!vtid) {
      return res.status(400).json({ ok: false, error: 'vtid is required' });
    }

    // Map frontend status to OASIS status
    let oasisStatus = 'pending';
    if (status === 'in_progress' || status === 'In Progress') {
      oasisStatus = 'in_progress';
    } else if (status === 'complete' || status === 'Completed') {
      oasisStatus = 'complete';
    } else if (status === 'pending' || status === 'Scheduled') {
      oasisStatus = 'pending';
    }

    // Build task record (only columns that exist in vtid_ledger)
    const taskRecord = {
      vtid,
      title,
      summary: summary ?? title,
      status: oasisStatus,
      layer: layer ?? 'DEV',
      module: module ?? 'command-hub',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Insert into vtid_ledger
    const insertResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
      method: 'POST',
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(taskRecord),
    });

    if (!insertResp.ok) {
      const errorText = await insertResp.text();
      console.error('[OASIS Tasks] Insert failed:', errorText);
      return res.status(502).json({ ok: false, error: 'Failed to create task', details: errorText });
    }

    const created = await insertResp.json() as any[];
    const createdTask = created[0];

    // Emit OASIS event for task creation
    try {
      await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
        method: 'POST',
        headers: {
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vtid,
          kind: 'TASK_CREATED',
          source: 'command-hub',
          layer: taskRecord.layer,
          status: 'success',
          payload: { task: createdTask },
          created_at: new Date().toISOString(),
        }),
      });
    } catch (eventError) {
      // Log but don't fail the request if event emission fails
      console.warn('[OASIS Tasks] Event emission failed:', eventError);
    }

    return res.status(201).json(createdTask);

  } catch (e: any) {
    console.error('[OASIS Tasks] POST error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /specs/dev-screen-inventory
 *
 * Returns the canonical Developer Screen Inventory spec.
 */
router.get('/specs/dev-screen-inventory', (req: Request, res: Response) => {
  try {
    // Resolve path to canonical spec file
    const specPath = path.resolve(__dirname, '../../specs/dev-screen-inventory-v1.json');

    if (!fs.existsSync(specPath)) {
      console.error('[OASIS Specs] Spec file not found:', specPath);
      return res.status(404).json({ ok: false, error: 'SPEC_NOT_FOUND' });
    }

    const specContent = fs.readFileSync(specPath, 'utf-8');
    const specData = JSON.parse(specContent);

    return res.status(200).json(specData);

  } catch (e: any) {
    console.error('[OASIS Specs] Error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
