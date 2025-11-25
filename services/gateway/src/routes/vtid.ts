import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";

const VtidCreateSchema = z.object({
  taskFamily: z.string().min(1, "Task family required"),
  taskType: z.string().min(1, "Task type required"),
  description: z.string().min(1, "Description required"),
  title: z.string().min(1, "Title required").max(200, "Title max 200 chars"),
  summary: z.string().max(500, "Summary max 500 chars").optional(),
  layer: z.enum(["DEV", "ADM", "UPO"], { errorMap: () => ({ message: "Layer must be DEV, ADM, or UPO" }) }),
  module: z.string().length(5, "Module must be exactly 5 characters").regex(/^[A-Z]{5}$/, "Module must be 5 uppercase letters"),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  status: z.enum(["pending", "active", "complete", "blocked", "cancelled"]).default("pending"),
  assignedTo: z.string().optional(),
  tenant: z.string().min(1, "Tenant required"),
  metadata: z.record(z.any()).optional(),
  parentVtid: z.string().optional(),
});

const VtidUpdateSchema = z.object({
  status: z.enum(["pending", "active", "complete", "blocked", "cancelled"]).optional(),
  assignedTo: z.string().optional(),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(500).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  metadata: z.record(z.any()).optional(),
});

type VtidCreateInput = z.infer<typeof VtidCreateSchema>;
type VtidUpdateInput = z.infer<typeof VtidUpdateSchema>;

export const router = Router();

async function generateVtid(supabaseUrl: string, svcKey: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `VTID-${year}-`;

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/VtidLedger?select=vtid&vtid=like.${prefix}*&order=vtid.desc&limit=1`,
    {
      method: "GET",
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to query latest VTID: ${resp.statusText}`);
  }

  const data = (await resp.json()) as any[];

  let nextNumber = 1;
  if (data.length > 0) {
    const lastVtid = data[0].vtid;
    const lastNumber = parseInt(lastVtid.split("-")[2], 10);
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${String(nextNumber).padStart(4, "0")}`;
}

function getStatusDisplay(status: string): string {
  const map: Record<string, string> = {
    pending: "Scheduled",
    active: "In Progress",
    complete: "Completed",
    blocked: "Blocked",
    cancelled: "Cancelled",
  };
  return map[status] || status;
}

function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    pending: "blue",
    active: "yellow",
    complete: "green",
    blocked: "red",
    cancelled: "gray",
  };
  return map[status] || "gray";
}

router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "vtid-ledger",
    timestamp: new Date().toISOString(),
  });
});

router.get("/list", async (req: Request, res: Response) => {
  try {
    const { taskFamily, status, tenant, layer, module, priority, limit = "50" } = req.query;

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        error: "Gateway misconfigured",
      });
    }

    let queryUrl = `${supabaseUrl}/rest/v1/VtidLedger?order=created_at.desc&limit=${limit}`;

    if (taskFamily) queryUrl += `&task_family=eq.${taskFamily}`;
    if (status) queryUrl += `&status=eq.${status}`;
    if (tenant) queryUrl += `&tenant=eq.${tenant}`;
    if (layer) queryUrl += `&layer=eq.${layer}`;
    if (module) queryUrl += `&module=eq.${module}`;
    if (priority) queryUrl += `&priority=eq.${priority}`;

    const resp = await fetch(queryUrl, {
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
        error: "Failed to query VTIDs",
        detail: text,
      });
    }

    const data = (await resp.json()) as any[];

    const transformedData = data.map((vtid) => ({
      ...vtid,
      statusDisplay: getStatusDisplay(vtid.status),
      statusColor: getStatusColor(vtid.status),
    }));

    return res.status(200).json(transformedData);
  } catch (e: any) {
    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});

router.post("/create", async (req: Request, res: Response) => {
  try {
    const body = VtidCreateSchema.parse(req.body);

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        error: "Gateway misconfigured",
      });
    }

    const vtid = await generateVtid(supabaseUrl, svcKey);

    const payload = {
      id: randomUUID(),
      vtid,
      task_family: body.taskFamily,
      task_type: body.taskType,
      description: body.description,
      title: body.title,
      summary: body.summary ?? null,
      layer: body.layer,
      module: body.module,
      priority: body.priority ?? null,
      status: body.status ?? "pending",
      assigned_to: body.assignedTo ?? null,
      tenant: body.tenant,
      metadata: body.metadata ?? null,
      parent_vtid: body.parentVtid ?? null,
    };

    const resp = await fetch(`${supabaseUrl}/rest/v1/VtidLedger`, {
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

    const data = (await resp.json()) as any[];
    console.log(`✅ VTID created: ${vtid} - ${body.layer}-${body.module} - ${body.title}`);

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

router.get("/:vtid([A-Z0-9-]+)", async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;

    if (!vtid || !vtid.startsWith("VTID-")) {
      return res.status(400).json({
        error: "Invalid VTID format",
        detail: "VTID must start with 'VTID-'",
      });
    }

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        error: "Gateway misconfigured",
      });
    }

    const resp = await fetch(
      `${supabaseUrl}/rest/v1/VtidLedger?vtid=eq.${vtid}`,
      {
        method: "GET",
        headers: {
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

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

    const vtidData = data[0];
    return res.status(200).json({
      ok: true,
      data: {
        ...vtidData,
        statusDisplay: getStatusDisplay(vtidData.status),
        statusColor: getStatusColor(vtidData.status),
      },
    });
  } catch (e: any) {
    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});

router.patch("/:vtid([A-Z0-9-]+)", async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const body = VtidUpdateSchema.parse(req.body);

    if (!vtid || !vtid.startsWith("VTID-")) {
      return res.status(400).json({
        error: "Invalid VTID format",
        detail: "VTID must start with 'VTID-'",
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
    if (body.assignedTo !== undefined) updatePayload.assigned_to = body.assignedTo;
    if (body.title) updatePayload.title = body.title;
    if (body.summary !== undefined) updatePayload.summary = body.summary;
    if (body.priority !== undefined) updatePayload.priority = body.priority;
    if (body.metadata) updatePayload.metadata = body.metadata;

    const resp = await fetch(
      `${supabaseUrl}/rest/v1/VtidLedger?vtid=eq.${vtid}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify(updatePayload),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Supabase update failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "Failed to update VTID",
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

    console.log(`✅ VTID updated: ${vtid}`);

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
