import { Router, Request, Response } from "express";
import { z } from "zod";

const router = Router();

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
    
    const insertResp = await fetch(supabaseUrl + "/rest/v1/VtidLedger", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: svcKey, Authorization: "Bearer " + svcKey, Prefer: "return=representation" },
      body: JSON.stringify({ vtid, ...body, metadata: body.metadata || {} }),
    });

    if (!insertResp.ok) return res.status(502).json({ error: "database_insert_failed" });
    const data = (await insertResp.json()) as any[];
    console.log("VTID created:", vtid);
    return res.status(201).json(data[0]);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "validation_failed", details: e.errors });
    return res.status(500).json({ error: "internal_server_error", message: e.message });
  }
});

router.get("/list", async (req: Request, res: Response) => {
  try {
    const { limit = "50", families = "DEV,ADM,GOVRN,OASIS", status, tenant = "vitana" } = req.query as Record<string, string>;
    const { supabaseUrl, svcKey } = getSupabaseConfig();
    let queryUrl = supabaseUrl + "/rest/v1/VtidLedger?order=updated_at.desc&limit=" + limit + "&tenant=eq." + tenant;
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
    if (!/^[A-Z]+-[A-Z0-9]+-\d{4}-\d{4}$/.test(vtid)) return res.status(400).json({ error: "invalid_format" });
    const { supabaseUrl, svcKey } = getSupabaseConfig();
    const resp = await fetch(supabaseUrl + "/rest/v1/VtidLedger?vtid=eq." + vtid, {
      headers: { apikey: svcKey, Authorization: "Bearer " + svcKey },
    });
    if (!resp.ok) return res.status(502).json({ error: "database_query_failed" });
    const data = (await resp.json()) as any[];
    if (data.length === 0) return res.status(404).json({ error: "not_found", message: "VTID not found" });
    return res.status(200).json(data[0]);
  } catch (e: any) {
    return res.status(500).json({ error: "internal_server_error" });
  }
});

// VTID format validation regex - matches LAYER-MODULE-NNNN-NNNN or LAYER-MODULE-NNNN
const VTID_FORMAT_REGEX = /^[A-Z]+-[A-Z0-9]+-\d{4}(-\d{4})?$/;

// Schema for get-or-create endpoint
const GetOrCreateSchema = z.object({
  vtid: z.string().optional(),
  task_family: z.enum(["DEV", "ADM", "GOVRN", "OASIS"]).default("DEV"),
  task_module: z.string().min(1).max(10).transform((s) => s.toUpperCase()).default("OASIS"),
  title: z.string().min(1).max(200).default("Auto-created task"),
  tenant: z.string().min(1).default("vitana"),
  agent: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

/**
 * POST /api/v1/vtid/get-or-create
 *
 * Centralized endpoint for agents to obtain VTIDs.
 * - If vtid is provided: validates and returns it if valid
 * - If no vtid: creates a new one via the ledger
 *
 * All new VTIDs are logged to OASIS with VTID_AUTOCREATED event.
 */
router.post("/get-or-create", async (req: Request, res: Response) => {
  try {
    const body = GetOrCreateSchema.parse(req.body);
    const { supabaseUrl, svcKey } = getSupabaseConfig();

    // Case 1: VTID provided - validate and return
    if (body.vtid) {
      // Validate format
      if (!VTID_FORMAT_REGEX.test(body.vtid)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_VTID_FORMAT",
          details: `VTID '${body.vtid}' does not match expected format (LAYER-MODULE-NNNN or LAYER-MODULE-NNNN-NNNN)`
        });
      }

      // Check existence in ledger
      const checkResp = await fetch(supabaseUrl + "/rest/v1/VtidLedger?vtid=eq." + body.vtid, {
        headers: { apikey: svcKey, Authorization: "Bearer " + svcKey },
      });

      if (!checkResp.ok) {
        return res.status(502).json({ ok: false, error: "DATABASE_ERROR", details: "Failed to query VTID ledger" });
      }

      const existing = (await checkResp.json()) as any[];
      if (existing.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "VTID_NOT_FOUND",
          details: `VTID '${body.vtid}' does not exist in the ledger. Use empty vtid to create a new one.`
        });
      }

      console.log(`[VTID] Validated existing VTID: ${body.vtid}`);
      return res.json({ ok: true, vtid: body.vtid, source: "existing" });
    }

    // Case 2: No VTID provided - create new one
    const newVtid = await generateVtidInDb(supabaseUrl, svcKey, body.task_family, body.task_module);

    // Insert into ledger
    const insertResp = await fetch(supabaseUrl + "/rest/v1/VtidLedger", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: svcKey, Authorization: "Bearer " + svcKey, Prefer: "return=representation" },
      body: JSON.stringify({
        vtid: newVtid,
        task_family: body.task_family,
        task_module: body.task_module,
        title: body.title,
        tenant: body.tenant,
        status: "scheduled",
        is_test: false,
        metadata: body.metadata || {},
        description_md: "",
      }),
    });

    if (!insertResp.ok) {
      return res.status(502).json({ ok: false, error: "DATABASE_INSERT_FAILED", details: "Failed to insert VTID into ledger" });
    }

    // Emit OASIS event VTID_AUTOCREATED
    const oasisPayload = {
      vtid: newVtid,
      topic: "VTID_AUTOCREATED",
      service: "gateway",
      role: "VTID_ALLOCATOR",
      model: "vtid-get-or-create",
      status: "success",
      message: "VTID automatically created via get-or-create endpoint",
      link: null,
      metadata: {
        layer: body.task_family,
        module: body.task_module,
        agent: body.agent || "unknown",
        title: body.title,
        tenant: body.tenant,
      },
    };

    const oasisResp = await fetch(supabaseUrl + "/rest/v1/oasis_events", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: svcKey, Authorization: "Bearer " + svcKey },
      body: JSON.stringify(oasisPayload),
    });

    if (!oasisResp.ok) {
      console.warn(`[VTID] Failed to emit OASIS event for ${newVtid}:`, await oasisResp.text());
    } else {
      console.log(`[OASIS] Emitted VTID_AUTOCREATED event for ${newVtid}`);
    }

    console.log(`[VTID] Created new VTID via get-or-create: ${newVtid}`);
    return res.status(201).json({
      ok: true,
      vtid: newVtid,
      source: "created",
      layer: body.task_family,
      module: body.task_module,
    });

  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: e.errors });
    }
    console.error("[VTID] get-or-create error:", e);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR", message: e.message });
  }
});

/**
 * POST /api/v1/vtid/validate
 *
 * Validates a VTID without creating anything.
 * Returns format validity and existence status.
 */
router.post("/validate", async (req: Request, res: Response) => {
  try {
    const { vtid } = req.body ?? {};

    if (!vtid || typeof vtid !== "string") {
      return res.status(400).json({ ok: false, error: "MISSING_VTID", details: "vtid field is required" });
    }

    const formatValid = VTID_FORMAT_REGEX.test(vtid);
    if (!formatValid) {
      return res.json({
        ok: true,
        vtid,
        format_valid: false,
        exists: false,
        details: "VTID does not match expected format"
      });
    }

    // Check existence
    const { supabaseUrl, svcKey } = getSupabaseConfig();
    const checkResp = await fetch(supabaseUrl + "/rest/v1/VtidLedger?vtid=eq." + vtid, {
      headers: { apikey: svcKey, Authorization: "Bearer " + svcKey },
    });

    if (!checkResp.ok) {
      return res.status(502).json({ ok: false, error: "DATABASE_ERROR" });
    }

    const existing = (await checkResp.json()) as any[];

    return res.json({
      ok: true,
      vtid,
      format_valid: true,
      exists: existing.length > 0,
    });

  } catch (e: any) {
    console.error("[VTID] validate error:", e);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

router.options("*", (_req: Request, res: Response) => {
  res.status(200).end();
});

export { router as vtidRouter };
