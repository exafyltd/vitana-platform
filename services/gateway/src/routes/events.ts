import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";

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

const IngestEventSchema = z.object({
  vtid: z.string().min(1, "vtid required"),
  type: z.string().min(1, "type required"),
  source: z.string().min(1, "source required"),
  status: z.enum(["info", "warning", "error", "success"], {
    errorMap: () => ({
      message: "status must be: info, warning, error, or success",
    }),
  }),
  message: z.string().min(1, "message required"),
  payload: z.record(z.any()).optional(),
  created_at: z.string().optional(),
});

export const router = Router();

router.post("/api/v1/events/ingest", async (req: Request, res: Response) => {
  try {
    const validation = IngestEventSchema.safeParse(req.body);

    if (!validation.success) {
      console.error("❌ Validation error:", validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: validation.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
        data: null,
      });
    }

    const body = validation.data;

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error(
        "❌ Gateway misconfigured: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE",
      );
      return res.status(500).json({
        ok: false,
        error: "Gateway misconfigured",
        data: null,
      });
    }

    const eventId = randomUUID();
    const timestamp = body.created_at || new Date().toISOString();

    const payload = {
      id: eventId,
      vtid: body.vtid,
      kind: body.type,
      source: body.source,
      status: body.status,
      title: body.message,
      topic: body.type,
      service: body.source,
      meta: body.payload || null,
      created_at: timestamp,
      ref: `vt/${body.vtid}-${body.type.replace(/\./g, "-")}`,
      link: null,
      layer: null,
      module: null,
    };

    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
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
      console.error(`❌ OASIS insert failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: "Database insert failed",
        data: null,
      });
    }

    const data = await resp.json();
    const insertedEvent = Array.isArray(data) ? data[0] : data;

    console.log(`✅ Event ingested: ${eventId} - ${body.vtid}/${body.type}`);

    return res.status(200).json({
      ok: true,
      error: null,
      data: {
        id: insertedEvent.id,
        vtid: insertedEvent.vtid,
        type: insertedEvent.kind,
        source: insertedEvent.source,
        status: insertedEvent.status,
        message: insertedEvent.title,
        created_at: insertedEvent.created_at,
        payload: insertedEvent.meta,
      },
    });
  } catch (e: any) {
    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      data: null,
    });
  }
});

router.post("/events/ingest", async (req: Request, res: Response) => {
  try {
    const body = OasisEventSchema.parse(req.body);

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error(
        "❌ Gateway misconfigured: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE",
      );
      return res.status(500).json({
        error: "Gateway misconfigured",
        detail: "Missing Supabase environment variables",
      });
    }

    const payload = {
      rid: body.rid ?? randomUUID(),
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
    console.log(
      `✅ Event persisted: ${payload.rid} - ${payload.service}/${payload.event}`,
    );

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
      console.error(
        "❌ Gateway misconfigured: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE",
      );
      return res.status(500).json({
        error: "Gateway misconfigured",
        detail: "Missing Supabase environment variables",
      });
    }

    const limit = parseInt(req.query.limit as string) || 10;
    const offset = parseInt(req.query.offset as string) || 0;
    const service = req.query.service as string;
    const topic = req.query.topic as string;
    const status = req.query.status as string;

    let queryParams = `limit=${limit}&offset=${offset}&order=created_at.desc`;
    if (service) queryParams += `&service=eq.${service}`;
    if (topic) queryParams += `&topic=eq.${topic}`;
    if (status) queryParams += `&status=eq.${status}`;

    const resp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?${queryParams}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      },
    );

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

router.get("/api/v1/oasis/events", async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("❌ Gateway misconfigured");
      return res.status(500).json({
        error: "Gateway misconfigured",
        detail: "Missing Supabase environment variables",
      });
    }

    const vtid = req.query.vtid as string;
    const limit = parseInt(req.query.limit as string) || 200;
    const offset = parseInt(req.query.offset as string) || 0;
    const source = req.query.source as string;
    const kind = req.query.kind as string;
    const status = req.query.status as string;
    const layer = req.query.layer as string;

    let queryParams = `limit=${limit}&offset=${offset}&order=created_at.desc`;
    if (vtid) queryParams += `&vtid=eq.${vtid}`;
    if (source) queryParams += `&source=eq.${source}`;
    if (kind) queryParams += `&kind=eq.${kind}`;
    if (status) queryParams += `&status=eq.${status}`;
    if (layer) queryParams += `&layer=eq.${layer}`;

    const resp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?${queryParams}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ OASIS query failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "OASIS query failed",
        detail: text,
        status: resp.status,
      });
    }

    const data = (await resp.json()) as any[];

    if (vtid) {
      res.setHeader("X-VTID", vtid);
    }

    console.log(
      `✅ OASIS query: ${data.length} events (vtid=${vtid || "all"})`,
    );

    return res.status(200).json(data);
  } catch (e: any) {
    console.error("❌ Unexpected error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});
