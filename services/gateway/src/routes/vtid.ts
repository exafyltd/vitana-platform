import { Router, Request, Response } from "express";
import { z } from "zod";
import { buildStageTimeline, defaultStageTimeline, type TimelineEvent, type StageTimelineEntry } from '../lib/stage-mapping';

const router = Router();

// ===========================================================================
// VTID-01010: Target Role Enum (canonical)
// ===========================================================================
const TARGET_ROLES_ENUM = ['DEV', 'COM', 'ADM', 'PRO', 'ERP', 'PAT', 'INFRA'] as const;
type TargetRole = typeof TARGET_ROLES_ENUM[number];

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

// VTID-01010: Target roles validation helper
const TargetRolesSchema = z.array(z.enum(TARGET_ROLES_ENUM)).min(1, "At least one target role is required");

const VtidCreateSchema = z.object({
  task_family: z.enum(["DEV", "ADM", "GOVRN", "OASIS"]),
  task_module: z.string().min(1).max(10).transform((s) => s.toUpperCase()),
  title: z.string().min(1).max(200),
  status: z.enum(["scheduled", "queued", "todo", "in_progress", "running", "validating", "done", "merged", "deployed", "closed"]).default("scheduled"),
  tenant: z.string().min(1).default("vitana"),
  is_test: z.boolean().default(false),
  description_md: z.string().default(""),
  metadata: z.record(z.any()).optional(),
  // VTID-01010: Target roles - mandatory for all tasks
  target_roles: TargetRolesSchema,
});

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) throw new Error("Supabase not configured");
  return { supabaseUrl, svcKey };
}

/**
 * VTID-0543: Atomic VTID creation via RPC
 * This replaces the non-atomic next_vtid + separate INSERT pattern
 */
interface AtomicCreateResult {
  id: string;
  vtid: string;
  title: string;
  status: string;
  tenant: string;
  layer: string;
  module: string;
  created_at: string;
}

router.post("/create", async (req: Request, res: Response) => {
  try {
    const body = VtidCreateSchema.parse(req.body);
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // VTID-01010: Validate INFRA exclusivity - if INFRA is selected, it must be the only role
    let targetRoles = body.target_roles;
    if (targetRoles.includes('INFRA') && targetRoles.length > 1) {
      return res.status(400).json({
        ok: false,
        error: "validation_failed",
        message: "INFRA role is exclusive and cannot be combined with other roles",
        details: [{ path: ["target_roles"], message: "INFRA must be the only role when selected" }]
      });
    }

    console.log(`[VTID-01010] Creating VTID atomically: family=${body.task_family}, module=${body.task_module}, target_roles=${targetRoles.join(',')}`);

    // VTID-01010: Merge target_roles into metadata
    const metadata = {
      ...(body.metadata || {}),
      target_roles: targetRoles
    };

    // VTID-0543: Use atomic RPC that generates VTID + inserts in one transaction
    const rpcResp = await fetch(supabaseUrl + "/rest/v1/rpc/create_vtid_atomic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: "Bearer " + svcKey,
      },
      body: JSON.stringify({
        p_family: body.task_family,
        p_module: body.task_module,
        p_title: body.title,
        p_status: body.status,
        p_tenant: body.tenant,
        p_is_test: body.is_test,
        p_summary: body.description_md || body.title,
        p_metadata: metadata,
      }),
    });

    if (!rpcResp.ok) {
      const errorText = await rpcResp.text();
      let supabaseError: { code?: string; message?: string; details?: string; hint?: string } = {};
      try {
        supabaseError = JSON.parse(errorText);
      } catch {
        supabaseError = { message: errorText };
      }

      console.error(`[VTID-0543] Atomic create FAILED:`);
      console.error(`  HTTP Status: ${rpcResp.status} ${rpcResp.statusText}`);
      console.error(`  Error Code: ${supabaseError.code || 'N/A'}`);
      console.error(`  Message: ${supabaseError.message || 'N/A'}`);
      console.error(`  Details: ${supabaseError.details || 'N/A'}`);

      // Check if RPC doesn't exist (function not deployed yet) - fall back to legacy method
      if (rpcResp.status === 404 || (supabaseError.message && supabaseError.message.includes('does not exist'))) {
        console.warn(`[VTID-0543] Atomic RPC not found, falling back to legacy method`);
        return await legacyCreate(req, res, body, supabaseUrl, svcKey);
      }

      return res.status(rpcResp.status >= 400 && rpcResp.status < 500 ? rpcResp.status : 502).json({
        ok: false,
        error: "database_insert_failed",
        message: supabaseError.message || `Atomic VTID creation failed: ${rpcResp.statusText}`,
        statusCode: rpcResp.status,
        supabase_error: {
          code: supabaseError.code,
          details: supabaseError.details,
          hint: supabaseError.hint,
        },
      });
    }

    const result = await rpcResp.json() as AtomicCreateResult[];

    if (!result || result.length === 0) {
      console.error(`[VTID-0543] Atomic create returned empty result`);
      return res.status(502).json({
        ok: false,
        error: "database_insert_failed",
        message: "Atomic VTID creation returned no result",
      });
    }

    const created = result[0];
    console.log(`[VTID-01010] Successfully created atomically: ${created.vtid} with target_roles=${targetRoles.join(',')}`);

    // VTID-01010: Include target_roles in response
    return res.status(201).json({
      ok: true,
      id: created.id,
      vtid: created.vtid,
      title: created.title,
      status: created.status,
      tenant: created.tenant,
      layer: created.layer,
      module: created.module,
      created_at: created.created_at,
      target_roles: targetRoles,
    });
  } catch (e: any) {
    console.error(`[VTID-01010] Error:`, e.message);
    if (e instanceof z.ZodError) return res.status(400).json({ ok: false, error: "validation_failed", details: e.errors });
    return res.status(500).json({ ok: false, error: "internal_server_error", message: e.message });
  }
});

/**
 * Legacy create method - fallback when atomic RPC is not available
 * This is the old non-atomic pattern for backwards compatibility during migration
 */
async function legacyCreate(
  _req: Request,
  res: Response,
  body: z.infer<typeof VtidCreateSchema>,
  supabaseUrl: string,
  svcKey: string
) {
  // Generate VTID via old RPC
  const vtidResp = await fetch(supabaseUrl + "/rest/v1/rpc/next_vtid", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: svcKey, Authorization: "Bearer " + svcKey },
    body: JSON.stringify({ p_family: body.task_family, p_module: body.task_module }),
  });
  if (!vtidResp.ok) {
    return res.status(502).json({ ok: false, error: "vtid_generation_failed", message: vtidResp.statusText });
  }
  const vtid = await vtidResp.json() as string;

  // VTID-01010: Merge target_roles into metadata (same as atomic path)
  const metadata = {
    ...(body.metadata || {}),
    target_roles: body.target_roles
  };

  // Insert separately (non-atomic - race condition possible)
  // VTID-0544: Use only valid vtid_ledger columns to avoid PGRST204 schema mismatch
  const insertPayload = {
    vtid,
    layer: body.task_family,
    module: body.task_module,
    status: body.status,
    title: body.title,
    summary: body.description_md || body.title,
    metadata: metadata,
  };

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
    console.error(`[VTID-CREATE-LEGACY] Insert failed: ${errorText}`);
    return res.status(insertResp.status >= 400 && insertResp.status < 500 ? insertResp.status : 502).json({
      ok: false,
      error: "database_insert_failed",
      message: errorText,
    });
  }

  const data = (await insertResp.json()) as any[];
  console.log(`[VTID-01010-LEGACY] Created: ${vtid} with target_roles=${body.target_roles.join(',')}`);
  // VTID-01010: Include target_roles in legacy response
  return res.status(201).json({ ok: true, ...data[0], target_roles: body.target_roles });
}

router.get("/list", async (req: Request, res: Response) => {
  try {
    const { limit: limitParam = "50", families, status, tenant = "vitana" } = req.query as Record<string, string>;
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // VTID-0543: Parse limit safely (default 50, max 200)
    let limit = parseInt(limitParam, 10);
    if (isNaN(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    // VTID-0543: First discover actual columns to avoid schema mismatch errors
    let allowedColumns: string[] = [];
    try {
      const schemaResp = await fetch(supabaseUrl + "/rest/v1/vtid_ledger?limit=1", {
        headers: { apikey: svcKey, Authorization: "Bearer " + svcKey },
      });
      if (schemaResp.ok) {
        const sampleData = await schemaResp.json() as any[];
        if (sampleData.length > 0) {
          allowedColumns = Object.keys(sampleData[0]);
        }
      }
    } catch (schemaErr: any) {
      console.warn(`[VTID-LIST] Schema discovery failed: ${schemaErr.message}`);
    }

    // VTID-0543: Determine order column - prefer created_at, fallback to id
    const hasCreatedAt = allowedColumns.includes('created_at');
    const orderCol = hasCreatedAt ? 'created_at' : 'id';

    // Build base query with safe ordering
    let queryUrl = `${supabaseUrl}/rest/v1/vtid_ledger?order=${orderCol}.desc&limit=${limit}`;

    // VTID-0543: Add tenant filter only if column exists
    if (allowedColumns.length === 0 || allowedColumns.includes('tenant')) {
      queryUrl += `&tenant=eq.${encodeURIComponent(tenant)}`;
    }

    // VTID-0543: Build filters using columns that actually exist
    // Use 'layer' column (current schema) with fallback to 'task_family' (legacy)
    const hasLayer = allowedColumns.includes('layer');
    const hasTaskFamily = allowedColumns.includes('task_family');
    const familyColumn = hasLayer ? 'layer' : (hasTaskFamily ? 'task_family' : null);

    // Build combined AND filter conditions
    const andConditions: string[] = [];

    // Add family filter if families param provided and column exists
    if (families && familyColumn) {
      const familyList = families.split(",").map(f => f.trim().toUpperCase()).filter(f => f);
      if (familyList.length > 0) {
        const familyFilter = familyList.map(f => `${familyColumn}.eq.${encodeURIComponent(f)}`).join(",");
        andConditions.push(`or(${familyFilter})`);
      }
    }

    // Add status filter if status param provided and column exists
    const hasStatus = allowedColumns.length === 0 || allowedColumns.includes('status');
    if (status && hasStatus) {
      const statusList = status.split(",").map(s => s.trim()).filter(s => s);
      if (statusList.length > 0) {
        const statusFilter = statusList.map(s => `status.eq.${encodeURIComponent(s)}`).join(",");
        andConditions.push(`or(${statusFilter})`);
      }
    }

    // VTID-0543: Combine filters properly using PostgREST and() syntax
    if (andConditions.length > 0) {
      queryUrl += `&and=(${andConditions.join(",")})`;
    }

    console.log(`[VTID-LIST] Query: ${queryUrl.replace(svcKey, '***')}`);

    const resp = await fetch(queryUrl, { headers: { apikey: svcKey, Authorization: "Bearer " + svcKey } });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[VTID-LIST] Database query failed: ${resp.status} - ${errorText}`);
      return res.status(502).json({ ok: false, error: "database_query_failed", message: `HTTP ${resp.status}` });
    }

    const data = await resp.json() as any[];
    console.log(`[VTID-LIST] Returned ${data.length} rows`);

    // VTID-0543: Return consistent shape matching API style
    return res.status(200).json({ ok: true, count: data.length, data });
  } catch (e: any) {
    console.error(`[VTID-LIST] Error:`, e.message);
    return res.status(500).json({ ok: false, error: "internal_server_error", message: e.message });
  }
});

/**
 * VTID-01001: Projection endpoint for decision-grade VTID visibility
 * VTID-01005: Enhanced with terminal state fields (is_terminal, terminal_outcome)
 * GET /api/v1/vtid/projection?limit=50
 *
 * Returns a computed projection with derived fields:
 * - vtid: The VTID identifier
 * - title: Title (fallback to "")
 * - current_stage: Planner/Worker/Validator/Deploy/Done
 * - status: Moving/Blocked/Done/Failed
 * - attention_required: AUTO or HUMAN
 * - last_update: ISO timestamp of last activity
 * - last_decision: Most recent governance decision (optional)
 * - is_terminal: VTID-01005 - Boolean indicating if VTID has reached terminal state
 * - terminal_outcome: VTID-01005 - 'success' | 'failed' | null
 */
interface VtidProjectionItem {
  vtid: string;
  title: string;
  current_stage: 'Planner' | 'Worker' | 'Validator' | 'Deploy' | 'Done';
  status: 'Moving' | 'Blocked' | 'Done' | 'Failed';
  attention_required: 'AUTO' | 'HUMAN';
  last_update: string | null;
  last_decision: string | null;
  // VTID-01005: Terminal state fields
  is_terminal: boolean;
  terminal_outcome: 'success' | 'failed' | null;
}

router.get("/projection", async (req: Request, res: Response) => {
  try {
    const { limit: limitParam = "50" } = req.query as Record<string, string>;
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    let limit = parseInt(limitParam, 10);
    if (isNaN(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    console.log(`[VTID-01001] Projection request, limit=${limit}`);

    // Step 1: Fetch VTIDs from ledger
    const vtidResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?order=created_at.desc&limit=${limit}`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
    );

    if (!vtidResp.ok) {
      const errText = await vtidResp.text();
      console.error(`[VTID-01001] Ledger query failed: ${vtidResp.status} - ${errText}`);
      return res.status(502).json({ ok: false, error: "database_query_failed" });
    }

    const vtidRows = await vtidResp.json() as any[];
    console.log(`[VTID-01001] Fetched ${vtidRows.length} VTIDs from ledger`);

    if (vtidRows.length === 0) {
      return res.status(200).json({ ok: true, count: 0, data: [] });
    }

    // Step 2: Fetch recent events for all these VTIDs (batch query)
    // We fetch the last 500 events and filter client-side for efficiency
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?order=created_at.desc&limit=500`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
    );

    let allEvents: any[] = [];
    if (eventsResp.ok) {
      allEvents = await eventsResp.json() as any[];
      console.log(`[VTID-01001] Fetched ${allEvents.length} events for projection`);
    } else {
      console.warn(`[VTID-01001] Events query failed, proceeding without events`);
    }

    // Step 3: Build projection for each VTID
    // VTID-01005: OASIS is the SINGLE SOURCE OF TRUTH for terminal states
    const projections: VtidProjectionItem[] = vtidRows.map((row: any) => {
      const vtid = row.vtid;
      const vtidEvents = allEvents.filter((e: any) => e.vtid === vtid);

      // Derive current_stage from events using stage-mapping logic
      let currentStage: VtidProjectionItem['current_stage'] = 'Planner';
      let derivedStatus: VtidProjectionItem['status'] = 'Moving';
      let attentionRequired: VtidProjectionItem['attention_required'] = 'AUTO';
      let lastUpdate: string | null = row.updated_at || row.created_at || null;
      let lastDecision: string | null = null;

      // VTID-01005: Terminal state detection from OASIS events (AUTHORITATIVE)
      let isTerminal = false;
      let terminalOutcome: 'success' | 'failed' | null = null;

      if (vtidEvents.length > 0) {
        // Get the most recent event
        const latestEvent = vtidEvents[0]; // Already sorted desc
        lastUpdate = latestEvent.created_at || lastUpdate;

        // VTID-01005: Check for terminal lifecycle events FIRST (highest authority)
        const terminalCompletedEvent = vtidEvents.find((e: any) =>
          (e.topic || '').toLowerCase() === 'vtid.lifecycle.completed'
        );
        const terminalFailedEvent = vtidEvents.find((e: any) =>
          (e.topic || '').toLowerCase() === 'vtid.lifecycle.failed'
        );

        if (terminalCompletedEvent) {
          isTerminal = true;
          terminalOutcome = 'success';
          derivedStatus = 'Done';
          currentStage = 'Done';
        } else if (terminalFailedEvent) {
          isTerminal = true;
          terminalOutcome = 'failed';
          derivedStatus = 'Failed';
          attentionRequired = 'HUMAN';
        }

        // If not determined by terminal lifecycle events, check other patterns
        if (!isTerminal) {
          // Determine stage from latest event
          const eventTopic = (latestEvent.topic || latestEvent.kind || '').toLowerCase();
          const eventStatus = (latestEvent.status || '').toLowerCase();
          const eventMessage = (latestEvent.message || '').toLowerCase();
          const combined = `${eventTopic} ${eventStatus} ${eventMessage}`;

          // Stage detection (priority: later stages first)
          if (combined.includes('deploy') || combined.includes('release') || combined.includes('publish')) {
            currentStage = 'Deploy';
          } else if (combined.includes('validat') || combined.includes('test') || combined.includes('verify') || combined.includes('check')) {
            currentStage = 'Validator';
          } else if (combined.includes('worker') || combined.includes('execut') || combined.includes('run') || combined.includes('build') || combined.includes('process')) {
            currentStage = 'Worker';
          } else if (combined.includes('plan') || combined.includes('schedul') || combined.includes('queue')) {
            currentStage = 'Planner';
          }

          // VTID-01005: Check for terminal success patterns in events
          // These patterns indicate completion even without explicit lifecycle event
          const hasDeploySuccess = vtidEvents.some((e: any) => {
            const topic = (e.topic || '').toLowerCase();
            return topic === 'deploy.gateway.success' ||
                   topic === 'cicd.deploy.service.succeeded' ||
                   topic === 'cicd.github.safe_merge.executed';
          });

          // VTID-01150: Be more specific about what counts as completion
          // Exclude commandhub.task.scheduled which has status='info' (not 'success')
          // Only count actual lifecycle/deploy completion events
          const hasCompletionEvent = vtidEvents.some((e: any) => {
            const topic = (e.topic || '').toLowerCase();
            const status = (e.status || '').toLowerCase();
            // Exclude scheduled events - they are NOT completion events
            if (topic.includes('scheduled') || topic.includes('task.scheduled')) {
              return false;
            }
            return topic === 'vtid.lifecycle.completed' ||
                   topic.includes('deploy.success') ||
                   (status === 'success' && topic.includes('deploy.gateway'));
          });

          if (hasDeploySuccess || hasCompletionEvent) {
            isTerminal = true;
            terminalOutcome = 'success';
            derivedStatus = 'Done';
            currentStage = 'Done';
          }

          // VTID-01005: Check for terminal failure patterns
          const hasDeployFailed = vtidEvents.some((e: any) => {
            const topic = (e.topic || '').toLowerCase();
            return topic === 'deploy.gateway.failed' ||
                   topic === 'cicd.deploy.service.failed';
          });

          if (hasDeployFailed) {
            isTerminal = true;
            terminalOutcome = 'failed';
            derivedStatus = 'Failed';
            attentionRequired = 'HUMAN';
          }

          // Non-terminal status checks
          if (!isTerminal) {
            if (combined.includes('done') || combined.includes('complete') || combined.includes('success') || combined.includes('merged') || combined.includes('deployed')) {
              if (currentStage === 'Deploy') {
                currentStage = 'Done';
                isTerminal = true;
                terminalOutcome = 'success';
              }
              derivedStatus = 'Done';
            }

            // Check for failure/blocked states
            if (eventStatus === 'error' || eventStatus === 'fail' || eventStatus === 'failure' ||
                combined.includes('failed') || combined.includes('error') || combined.includes('exception')) {
              derivedStatus = 'Failed';
              attentionRequired = 'HUMAN';
            }

            if (eventStatus === 'blocked' || combined.includes('blocked') || combined.includes('rejected')) {
              derivedStatus = 'Blocked';
              attentionRequired = 'HUMAN';
            }
          }
        }

        // Check for governance decisions
        const governanceEvent = vtidEvents.find((e: any) =>
          (e.topic || '').includes('governance') ||
          (e.kind || '').includes('governance') ||
          (e.message || '').includes('governance')
        );
        if (governanceEvent) {
          lastDecision = governanceEvent.message || 'Governance decision recorded';
          if ((governanceEvent.status || '').toLowerCase() === 'rejected') {
            attentionRequired = 'HUMAN';
          }
        }
      }

      // VTID-01005: Use ledger status ONLY if no terminal OASIS event exists
      // OASIS events take precedence over local ledger state
      if (!isTerminal) {
        const ledgerStatus = (row.status || '').toLowerCase();
        if (ledgerStatus === 'done' || ledgerStatus === 'closed' || ledgerStatus === 'deployed' || ledgerStatus === 'merged' || ledgerStatus === 'complete') {
          derivedStatus = 'Done';
          currentStage = 'Done';
          isTerminal = true;
          terminalOutcome = 'success';
        } else if (ledgerStatus === 'failed' || ledgerStatus === 'error') {
          derivedStatus = 'Failed';
          attentionRequired = 'HUMAN';
          isTerminal = true;
          terminalOutcome = 'failed';
        } else if (ledgerStatus === 'blocked') {
          derivedStatus = 'Blocked';
          attentionRequired = 'HUMAN';
        }
      }

      return {
        vtid,
        title: row.title || '',
        current_stage: currentStage,
        status: derivedStatus,
        attention_required: attentionRequired,
        last_update: lastUpdate,
        last_decision: lastDecision,
        // VTID-01005: Terminal state fields
        is_terminal: isTerminal,
        terminal_outcome: terminalOutcome,
      };
    });

    console.log(`[VTID-01001] Built projection for ${projections.length} VTIDs`);
    return res.status(200).json({ ok: true, count: projections.length, data: projections });
  } catch (e: any) {
    console.error(`[VTID-01001] Projection error:`, e.message);
    return res.status(500).json({ ok: false, error: "internal_server_error", message: e.message });
  }
});

router.get("/:vtid", async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    // VTID-0527-C + VTID-01007: Accept both formats with 4-5 digit support:
    // - Simple: VTID-0516, VTID-01006, VTID-0527-B
    // - Complex: DEV-ABC-0001-0002
    const VTID_REGEX = /^(VTID-\d{4,5}(-[A-Za-z0-9]+)?|[A-Z]+-[A-Z0-9]+-\d{4}-\d{4})$/;
    if (!VTID_REGEX.test(vtid)) {
      console.log(`[VTID-01007] Invalid VTID format: ${vtid}`);
      return res.status(400).json({ error: "invalid_format", vtid, expected: "VTID-#### or VTID-##### or XXX-YYY-####-####" });
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
