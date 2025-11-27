import { Router, Request, Response } from 'express';

export const router = Router();

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
const getTasks = async (req: Request, res: Response) => {
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
};

router.get('/api/v1/tasks', getTasks);
// Alias for Command Hub compatibility
console.log('Registering /api/v1/oasis/tasks alias');
router.get('/api/v1/oasis/tasks', getTasks);


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
