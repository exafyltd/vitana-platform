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
    console.log("VTID created: " + vtid);
    return res.status(201).json(data[0]);
  } catch (e: any) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "validation_failed", details: e.errors });
    return res.status(500).json({ error: "internal_server_error", message: e.message });
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

router.options("*", (_req: Request, res: Response) => { 
  res.status(200).end(); 
});

export { router as vtidRouter };
