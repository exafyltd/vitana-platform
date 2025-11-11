/**
 * VTID Management Routes
 * Handles creation, retrieval, and updates of VTIDs in the ledger
 * 
 * VTID Format: DEV-{LAYER}-{NUMBER}
 * Example: DEV-CICDL-0031, DEV-AICOR-0013
 * 
 * Recent Updates:
 * - DEV-AICOR-VTID-LEDGER-CLEANUP: Added is_test filtering
 * - DEV-COMMU-0054: Added field mapping adapter for consistency with /api/v1/tasks
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

const router = Router();

// Validation schemas
const VtidCreateSchema = z.object({
  taskFamily: z.string().min(1).max(50),
  taskType: z.string().min(1).max(50),
  description: z.string().min(1).max(500),
  tenant: z.string().min(1).max(100),
  assignedTo: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  parentVtid: z.string().optional(),
  isTest: z.boolean().optional().default(false),
});

const VtidUpdateSchema = z.object({
  status: z.enum(['pending', 'active', 'review', 'complete', 'blocked', 'cancelled']).optional(),
  assignedTo: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

/**
 * Health check endpoint
 */
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'vtid-ledger',
    timestamp: new Date().toISOString(),
  });
});

/**
 * List VTIDs with optional filters
 * Query params:
 * - limit: max results (default 50, max 200)
 * - offset: pagination offset
 * - taskFamily: filter by task family
 * - status: filter by status
 * - tenant: filter by tenant
 * - includeTest: include test VTIDs (default false)
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const taskFamily = req.query.taskFamily as string;
    const status = req.query.status as string;
    const tenant = req.query.tenant as string;
    const includeTest = req.query.includeTest === 'true';

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        error: "Gateway misconfigured",
      });
    }

    // Build query filters
    const filters: string[] = [];
    
    // Always filter out test VTIDs unless explicitly requested
    if (!includeTest) {
      filters.push('is_test=eq.false');
    }
    
    if (taskFamily) filters.push(`task_family=eq.${encodeURIComponent(taskFamily)}`);
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
    if (tenant) filters.push(`tenant=eq.${encodeURIComponent(tenant)}`);

    const filterStr = filters.length > 0 ? '&' + filters.join('&') : '';
    const url = `${supabaseUrl}/rest/v1/vtid_ledger?order=created_at.desc&limit=${limit}&offset=${offset}${filterStr}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Supabase query failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "Failed to list VTIDs",
        detail: text,
      });
    }

    const data = await resp.json() as any[];

    return res.status(200).json({
      ok: true,
      count: data.length,
      data,
    });
  } catch (e: any) {
    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});

/**
 * Generate next VTID number for given task family
 * Returns format: DEV-{LAYER}-{NUMBER}
 */
async function generateVtid(taskFamily: string, supabaseUrl: string, svcKey: string): Promise<string> {
  // Extract layer from task family (e.g., "cicd" -> "CICDL", "ai-core" -> "AICOR")
  const layerMap: Record<string, string> = {
    'cicd': 'CICDL',
    'ai-core': 'AICOR',
    'ai-agent': 'AIAGE',
    'communication': 'COMMU',
    'gateway': 'GATEW',
    'oasis': 'OASIS',
    'mcp': 'MCPGW',
    'deploy': 'DEPLO',
    'test': 'TESTT',
  };

  const layer = layerMap[taskFamily.toLowerCase()] || 'GENER';

  // Find the highest number for this layer
  const resp = await fetch(
    `${supabaseUrl}/rest/v1/vtid_ledger?vtid=like.DEV-${layer}-%&order=vtid.desc&limit=1`,
    {
      method: "GET",
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to query latest VTID: ${resp.status}`);
  }

  const data = await resp.json() as any[];
  
  let nextNum = 1;
  if (data.length > 0) {
    const lastVtid = data[0].vtid as string;
    const match = lastVtid.match(/DEV-[A-Z]+-(\d+)$/);
    if (match) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }

  return `DEV-${layer}-${String(nextNum).padStart(4, '0')}`;
}

/**
 * Create new VTID
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = VtidCreateSchema.parse(req.body);

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        error: "Gateway misconfigured",
      });
    }

    const vtid = await generateVtid(body.taskFamily, supabaseUrl, svcKey);

    const payload = {
      id: crypto.randomUUID(),
      vtid,
      task_family: body.taskFamily,
      task_type: body.taskType,
      description: body.description,
      status: 'pending',
      assigned_to: body.assignedTo ?? null,
      tenant: body.tenant,
      metadata: body.metadata ?? null,
      parent_vtid: body.parentVtid ?? null,
      is_test: body.isTest ?? false,
    };

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Supabase insert failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "Failed to create VTID",
        detail: text,
        status: resp.status,
      });
    }

    const data = await resp.json() as any[];
    console.log(`✅ VTID created: ${vtid} - ${body.taskFamily}/${body.taskType}`);

    return res.status(200).json({
      ok: true,
      vtid,
      data: data[0],
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      console.error("❌ Validation error:", e.errors);
      return res.status(400).json({
        error: "Invalid payload",
        detail: e.errors,
      });
    }

    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});

/**
 * Get specific VTID by ID
 * 
 * Field mapping adapter (DEV-COMMU-0054):
 * Returns the same field structure as /api/v1/tasks for consistency
 * with Command Hub Task Board UI.
 */
router.get('/:vtid', async (req: Request, res: Response) => {
  console.log('🔍 GET route hit for VTID:', req.params.vtid);
  try {
    const { vtid } = req.params;

    if (!vtid || !vtid.startsWith('DEV-')) {
      return res.status(400).json({
        error: "Invalid VTID format",
        detail: "VTID must start with 'DEV-'",
      });
    }

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        error: "Gateway misconfigured",
      });
    }

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: "GET",
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Supabase query failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "Failed to query VTID",
        detail: text,
      });
    }

    const data = (await resp.json()) as any[];

    if (data.length === 0) {
      return res.status(404).json({
        error: "VTID not found",
        vtid,
      });
    }

    const row = data[0];
    
    // Apply same field mapping as /api/v1/tasks for consistency
    return res.status(200).json({
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
        
        // TEMPORARY compatibility fields for Task Board UI
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
    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});

/**
 * Update VTID status or metadata
 */
router.patch('/:vtid', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const body = VtidUpdateSchema.parse(req.body);

    if (!vtid || !vtid.startsWith('DEV-')) {
      return res.status(400).json({
        error: "Invalid VTID format",
      });
    }

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        error: "Gateway misconfigured",
      });
    }

    const updatePayload: any = {};
    if (body.status) updatePayload.status = body.status;
    if (body.assignedTo) updatePayload.assigned_to = body.assignedTo;
    if (body.metadata) updatePayload.metadata = body.metadata;

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(updatePayload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Supabase update failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "Failed to update VTID",
        detail: text,
      });
    }

    const data = await resp.json() as any[];
    console.log(`✅ VTID updated: ${vtid}`);

    // Emit task.lifecycle event if status changed
    if (body.status && data[0]) {
      try {
        const lifecycleEvent = {
          event_type: "task.lifecycle",
          service: "vtid-ledger",
          tenant: data[0].tenant || "default",
          status: "success",
          vtid: vtid,
          metadata: {
            from_status: data[0].status,
            to_status: body.status,
            layer: data[0].layer,
            module: data[0].module,
            assigned_to: data[0].assigned_to,
          },
          timestamp: new Date().toISOString(),
        };

        const eventResp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
          body: JSON.stringify(lifecycleEvent),
        });

        if (eventResp.ok) {
          console.log(`🔄 [LIFECYCLE] ${vtid}: ${data[0].status} → ${body.status}`);
        }
      } catch (eventError) {
        console.error(`⚠️ [LIFECYCLE] Event emission error:`, eventError);
      }
    }

    return res.status(200).json({
      ok: true,
      vtid,
      data: data[0],
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({
        error: "Invalid payload",
        detail: e.errors,
      });
    }

    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});

export default router;
