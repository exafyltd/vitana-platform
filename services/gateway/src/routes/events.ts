import { Router, Request, Response } from "express";
import { z } from "zod";

const OasisEventSchema = z.object({
  service: z.string().min(1, "Service name required"),
  event: z.string().min(1, "Event name required"),
  tenant: z.string().min(1, "Tenant required"),
  status: z.enum(["start", "success", "fail", "blocked", "warning", "info"]),
  notes: z.string().optional(),
  git_sha: z.string().optional(),
  rid: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  timestamp: z.string().optional(),
});

type OasisEventInput = z.infer<typeof OasisEventSchema>;

export const router = Router();

router.post("/events/ingest", async (req: Request, res: Response) => {
  try {
    const body = OasisEventSchema.parse(req.body);

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("❌ Gateway misconfigured: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
      return res.status(500).json({
        error: "Gateway misconfigured",
        detail: "Missing Supabase environment variables",
      });
    }

    const payload = {
      rid: body.rid ?? crypto.randomUUID(),
      service: body.service,
      event: body.event,
      tenant: body.tenant,
      status: body.status,
      notes: body.notes ?? null,
      git_sha: body.git_sha ?? null,
      metadata: body.metadata ?? null,
    };

    const resp = await fetch(`${supabaseUrl}/rest/v1/OasisEvent`, {
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
        error: "Supabase insert failed",
        detail: text,
        status: resp.status,
      });
    }

    const data = await resp.json();
    console.log(`✅ Event persisted: ${payload.rid} - ${payload.service}/${payload.event}`);

    return res.status(200).json({
      ok: true,
      data,
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

router.get("/events", async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("❌ Gateway misconfigured: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
      return res.status(500).json({
        error: "Gateway misconfigured",
        detail: "Missing Supabase environment variables",
      });
    }

    // Parse query parameters
    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    const service = req.query.service as string;
    const topic = req.query.topic as string;
    const status = req.query.status as string;

    // Build query string
    let queryParams = `limit=${limit}&offset=${offset}&order=created_at.desc`;
    if (service) queryParams += `&service=eq.${service}`;
    if (topic) queryParams += `&topic=eq.${topic}`;
    if (status) queryParams += `&status=eq.${status}`;

    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events?${queryParams}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Supabase query failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "Supabase query failed",
        detail: text,
        status: resp.status,
      });
    }

    const data = (await resp.json()) as any[];
    console.log(`✅ Retrieved ${data.length} events`);

    return res.status(200).json(data);
  } catch (e: any) {
    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});

router.get("/events/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "oasis-events",
    timestamp: new Date().toISOString(),
  });
});

// CI Verification Test - 2025-10-28
