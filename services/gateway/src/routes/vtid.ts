import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { buildStageTimeline, defaultStageTimeline, type TimelineEvent, type StageTimelineEntry } from '../lib/stage-mapping';

const router = Router();

// ===========================================================================
// VTID-0542: Global VTID Allocator Configuration
// ===========================================================================

// Feature flags for allocator activation
// OFF until all 3 paths (Manual/CTO, Operator Console, Command Hub) are wired
const VTID_ALLOCATOR_ENABLED = process.env.VTID_ALLOCATOR_ENABLED === 'true';
const VTID_ALLOCATOR_START = parseInt(process.env.VTID_ALLOCATOR_START || '1000', 10);

// Allocator response type
interface AllocatorResponse {
  ok: boolean;
  vtid?: string;
  num?: number;
  id?: string;
  error?: string;
  message?: string;
}

/**
 * POST /allocate → /api/v1/vtid/allocate
 * VTID-0542: Global VTID Allocator
 *
 * Atomically allocates the next sequential VTID and creates a shell entry
 * in the ledger. This ensures allocated == registered (no split-brain).
 *
 * Returns 409 if allocator is disabled (feature flag OFF).
 */
router.post("/allocate", async (req: Request, res: Response) => {
  console.log(`[VTID-0542] Allocate request received, enabled=${VTID_ALLOCATOR_ENABLED}`);

  // D2: Check feature flag - return 409 if disabled
  if (!VTID_ALLOCATOR_ENABLED) {
    console.log(`[VTID-0542] Allocator disabled, returning 409`);
    return res.status(409).json({
      ok: false,
      error: 'allocator_disabled',
      message: 'VTID allocator is not active. Enable VTID_ALLOCATOR_ENABLED=true after all 3 paths are wired.',
      vtid: 'VTID-0542'
    } as AllocatorResponse);
  }

  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Extract optional parameters from request body
    const source = req.body?.source || 'api';
    const layer = req.body?.layer || 'DEV';
    const module = req.body?.module || 'TASK';

    // Call the atomic allocation function
    const resp = await fetch(supabaseUrl + "/rest/v1/rpc/allocate_global_vtid", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: "Bearer " + svcKey
      },
      body: JSON.stringify({
        p_source: source,
        p_layer: layer,
        p_module: module
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[VTID-0542] Allocation RPC failed: ${resp.status} - ${errorText}`);
      return res.status(502).json({
        ok: false,
        error: 'allocation_failed',
        message: `Database allocation failed: ${resp.statusText}`,
      } as AllocatorResponse);
    }

    const result = await resp.json() as Array<{ vtid: string; num: number; id: string }>;

    if (!result || result.length === 0) {
      console.error(`[VTID-0542] Allocation returned empty result`);
      return res.status(502).json({
        ok: false,
        error: 'allocation_empty',
        message: 'Allocation function returned no result',
      } as AllocatorResponse);
    }

    const allocated = result[0];
    console.log(`[VTID-0542] Successfully allocated: ${allocated.vtid} (num=${allocated.num})`);

    return res.status(201).json({
      ok: true,
      vtid: allocated.vtid,
      num: allocated.num,
      id: allocated.id,
    } as AllocatorResponse);

  } catch (e: any) {
    console.error(`[VTID-0542] Allocation error:`, e);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: e.message,
    } as AllocatorResponse);
  }
});

/**
 * GET /allocator/status → /api/v1/vtid/allocator/status
 * VTID-0542: Check allocator status and configuration
 */
router.get("/allocator/status", (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    enabled: VTID_ALLOCATOR_ENABLED,
    start: VTID_ALLOCATOR_START,
    format: 'VTID-XXXXX',
    vtid: 'VTID-0542',
    message: VTID_ALLOCATOR_ENABLED
      ? 'Allocator is active. All task creation paths should use POST /api/v1/vtid/allocate.'
      : 'Allocator is disabled. Set VTID_ALLOCATOR_ENABLED=true to activate.'
  });
});

/**
 * GET /health → /api/v1/vtid/health
 * Health check that verifies ledger is readable and writable
 */
router.get("/health", async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; latency_ms?: number; error?: string }> = {};

  try {
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Check 1: Ledger is readable (SELECT)
    const readStart = Date.now();
    try {
      const readResp = await fetch(
        supabaseUrl + "/rest/v1/vtid_ledger?limit=1",
        { headers: { apikey: svcKey, Authorization: "Bearer " + svcKey } }
      );
      checks.ledger_read = {
        ok: readResp.ok,
        latency_ms: Date.now() - readStart,
        error: readResp.ok ? undefined : `HTTP ${readResp.status}`,
      };
    } catch (e: any) {
      checks.ledger_read = { ok: false, latency_ms: Date.now() - readStart, error: e.message };
    }

    // Check 2: Ledger is writable (test via RPC or direct insert check)
    // We use a SELECT to verify the table exists and is accessible for writes
    // A true write test would require cleanup, so we just verify schema access
    const writeStart = Date.now();
    try {
      // Test that next_vtid RPC is accessible (this is required for create)
      const rpcResp = await fetch(
        supabaseUrl + "/rest/v1/rpc/next_vtid",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: svcKey,
            Authorization: "Bearer " + svcKey,
          },
          body: JSON.stringify({ p_family: "DEV", p_module: "TEST" }),
        }
      );
      checks.vtid_generator = {
        ok: rpcResp.ok,
        latency_ms: Date.now() - writeStart,
        error: rpcResp.ok ? undefined : `HTTP ${rpcResp.status}`,
      };
    } catch (e: any) {
      checks.vtid_generator = { ok: false, latency_ms: Date.now() - writeStart, error: e.message };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    return res.status(allOk ? 200 : 503).json({
      ok: allOk,
      service: "vtid",
      checks,
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    return res.status(503).json({
      ok: false,
      service: "vtid",
      error: e.message,
      checks,
      timestamp: new Date().toISOString(),
    });
  }
});

const VtidCreateSchema = z.object({
  task_family: z.enum(["DEV", "ADM", "GOVRN", "OASIS"]),
  task_module: z.string().min(1).max(10).transform((s) => s.toUpperCase()),
  title: z.string().min(1).max(200),
  status: z.enum(["scheduled", "queued", "todo", "in_progress", "running", "validating", "done", "merged", "deployed", "closed"]).default("scheduled"),
  tenant: z.string().min(1).default("vitana"),
  is_test: z.boolean().default(false),
  description_md: z.string().default(""),
  metadata: z.record(z.any()).optional(),
});

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) throw new Error("Supabase not configured");
  return { supabaseUrl, svcKey };
}

async function generateVtidInDb(supabaseUrl: string, svcKey: string, family: string, module: string): Promise<string> {
  const resp = await fetch(supabaseUrl + "/rest/v1/rpc/next_vtid", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: svcKey, Authorization: "Bearer " + svcKey },
    body: JSON.stringify({ p_family: family, p_module: module }),
  });
  if (!resp.ok) throw new Error("VTID generation failed: " + resp.statusText);
  return (await resp.json()) as string;
}

router.post("/create", async (req: Request, res: Response) => {
  try {
    const body = VtidCreateSchema.parse(req.body);
    const { supabaseUrl, svcKey } = getSupabaseConfig();
    const vtid = await generateVtidInDb(supabaseUrl, svcKey, body.task_family, body.task_module);

    // FIX: Use vtid_ledger (snake_case) to match the read endpoint table name
    const insertPayload = {
      id: randomUUID(),
      vtid,
      title: body.title,
      status: body.status,
      tenant: body.tenant,
      is_test: body.is_test,
      task_family: body.task_family,
      module: body.task_module,
      layer: body.task_family, // Use task_family as layer (DEV, ADM, etc.)
      summary: body.description_md || body.title,
      metadata: body.metadata || {},
    };

    console.log(`[VTID-CREATE] Inserting VTID ${vtid} into vtid_ledger`);

    const insertResp = await fetch(supabaseUrl + "/rest/v1/vtid_ledger", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: "Bearer " + svcKey,
        Prefer: "return=representation"
      },
      body: JSON.stringify(insertPayload),
    });

    if (!insertResp.ok) {
      const errorText = await insertResp.text();
      console.error(`[VTID-CREATE] Supabase insert failed: ${insertResp.status} - ${errorText}`);
      return res.status(500).json({
        ok: false,
        error: "database_insert_failed",
        message: `Failed to persist VTID to ledger: ${insertResp.statusText}`,
        statusCode: insertResp.status,
      });
    }

    const data = (await insertResp.json()) as any[];
    console.log(`[VTID-CREATE] Successfully created and persisted: ${vtid}`);
    return res.status(201).json({ ok: true, ...data[0] });
  } catch (e: any) {
    console.error(`[VTID-CREATE] Error:`, e.message);
    if (e instanceof z.ZodError) return res.status(400).json({ ok: false, error: "validation_failed", details: e.errors });
    return res.status(500).json({ ok: false, error: "internal_server_error", message: e.message });
  }
});

router.get("/list", async (req: Request, res: Response) => {
  try {
    const { limit = "50", families = "DEV,ADM,GOVRN,OASIS", status, tenant = "vitana" } = req.query as Record<string, string>;
    const { supabaseUrl, svcKey } = getSupabaseConfig();
    // FIX: Use vtid_ledger (snake_case) to match the read endpoint table name
    let queryUrl = supabaseUrl + "/rest/v1/vtid_ledger?order=updated_at.desc&limit=" + limit + "&tenant=eq." + tenant;
    if (families) {
      const familyList = families.split(",").map(f => f.trim());
      const familyFilter = familyList.map(f => "task_family.eq." + f).join(",");
      queryUrl += "&or=(" + familyFilter + ")";
    }
    if (status) {
      const statusList = status.split(",").map(s => s.trim());
      const statusFilter = statusList.map(s => "status.eq." + s).join(",");
      queryUrl += "&or=(" + statusFilter + ")";
    }
    const resp = await fetch(queryUrl, { headers: { apikey: svcKey, Authorization: "Bearer " + svcKey } });
    if (!resp.ok) return res.status(502).json({ error: "database_query_failed" });
    return res.status(200).json((await resp.json()) as any[]);
  } catch (e: any) {
    return res.status(500).json({ error: "internal_server_error" });
  }
});

router.get("/:vtid", async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    // VTID-0527-C: Accept both formats:
    // - Simple: VTID-0516, VTID-0527-B
    // - Complex: DEV-ABC-0001-0002
    const VTID_REGEX = /^(VTID-\d{4}(-[A-Za-z0-9]+)?|[A-Z]+-[A-Z0-9]+-\d{4}-\d{4})$/;
    if (!VTID_REGEX.test(vtid)) {
      console.log(`[VTID-0527-C] Invalid VTID format: ${vtid}`);
      return res.status(400).json({ error: "invalid_format", vtid, expected: "VTID-#### or XXX-YYY-####-####" });
    }
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // VTID-0527-C: Query vtid_ledger (lowercase) for consistency with tasks.ts
    const resp = await fetch(supabaseUrl + "/rest/v1/vtid_ledger?vtid=eq." + vtid, {
      headers: { apikey: svcKey, Authorization: "Bearer " + svcKey },
    });
    if (!resp.ok) return res.status(502).json({ error: "database_query_failed" });
    const data = (await resp.json()) as any[];
    if (data.length === 0) return res.status(404).json({ error: "not_found", message: "VTID not found", vtid });

    const row = data[0];

    // VTID-0527-C: Build stage timeline from telemetry events
    // ALWAYS return 4 entries (PLANNER, WORKER, VALIDATOR, DEPLOY), never null or empty
    let stageTimeline: StageTimelineEntry[] = defaultStageTimeline();
    let eventsFound = 0;

    try {
      console.log(`[VTID-0527-C] Fetching events for VTID: ${vtid}`);
      // VTID-0530: Use topic->kind and message->title aliases since events use topic/message not kind/title
      const eventsResp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${vtid}&select=id,created_at,vtid,kind:topic,status,title:message,task_stage,source,layer&order=created_at.asc&limit=100`,
        {
          headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
        }
      );

      if (eventsResp.ok) {
        const events = await eventsResp.json() as TimelineEvent[];
        eventsFound = events.length;
        console.log(`[VTID-0527-C] Found ${eventsFound} events for ${vtid}`);

        if (events.length > 0) {
          stageTimeline = buildStageTimeline(events);
          console.log(`[VTID-0527-C] Built stage timeline for ${vtid}:`, stageTimeline.map(s => `${s.stage}:${s.status}`).join(', '));
        } else {
          console.log(`[VTID-0527-C] No events found for ${vtid}, using default timeline (all PENDING)`);
        }
      } else {
        const errText = await eventsResp.text();
        console.warn(`[VTID-0527-C] Events query failed for ${vtid}: ${eventsResp.status} - ${errText}`);
      }
    } catch (err) {
      console.warn(`[VTID-0527-C] Failed to fetch events for ${vtid}:`, err);
    }

    // Ensure stageTimeline always has 4 entries
    if (!stageTimeline || stageTimeline.length !== 4) {
      console.warn(`[VTID-0527-C] Invalid stageTimeline, using default`);
      stageTimeline = defaultStageTimeline();
    }

    // Return response with stageTimeline
    return res.status(200).json({
      ok: true,
      data: {
        vtid: row.vtid,
        layer: row.layer,
        module: row.module,
        status: row.status,
        title: row.title,
        description: row.summary ?? row.title,
        summary: row.summary,
        task_family: row.task_family || row.module,
        task_type: row.task_type || row.module,
        assigned_to: row.assigned_to ?? null,
        metadata: row.metadata ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        // VTID-0527-C: Stage timeline (always 4 entries, never null)
        stageTimeline: stageTimeline,
        _stageTimelineEventsFound: eventsFound,
      }
    });
  } catch (e: any) {
    console.error(`[VTID-0527-C] Error:`, e);
    return res.status(500).json({ error: "internal_server_error", message: e.message });
  }
});

router.options("*", (_req: Request, res: Response) => { 
  res.status(200).end(); 
});

export { router as vtidRouter };
