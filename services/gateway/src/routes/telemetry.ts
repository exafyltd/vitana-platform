import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";

export const router = Router();

// Telemetry Event Schema (TickerEvent format)
const TelemetryEventSchema = z.object({
  ts: z.string().optional(), // Will default to now() if not provided
  vtid: z.string().min(1, "VTID required"),
  layer: z.string().min(1, "Layer required"),
  module: z.string().min(1, "Module required"),
  source: z.string().min(1, "Source required"),
  kind: z.string().min(1, "Kind required"),
  status: z.enum(["success", "failure", "in_progress", "info", "warning"]),
  title: z.string().min(1, "Title required"),
  ref: z.string().optional(),
  link: z.string().nullable().optional(),
  meta: z.record(z.any()).optional(),
});

type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

// POST /api/v1/telemetry/event - Single telemetry event
router.post("/api/v1/telemetry/event", async (req: Request, res: Response) => {
  try {
    // Validate request body
    const body = TelemetryEventSchema.parse(req.body);

    // Get Supabase credentials
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("❌ Gateway misconfigured: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
      return res.status(500).json({
        error: "Gateway misconfigured",
        detail: "Missing Supabase environment variables",
      });
    }

    // Prepare event payload for OASIS
    const timestamp = body.ts || new Date().toISOString();
    const eventId = randomUUID();
    
    const payload = {
      id: eventId,
      created_at: timestamp,
      vtid: body.vtid,
      layer: body.layer,
      module: body.module,
      source: body.source,
      kind: body.kind,
      status: body.status,
      title: body.title,
      ref: body.ref || `vt/${body.vtid}-${body.kind.replace(/\./g, "-")}`,
      link: body.link || null,
      meta: body.meta || null,
    };

    // Persist to OASIS (oasis_events table)
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
      console.error(`❌ OASIS persistence failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "OASIS persistence failed",
        detail: text,
        status: resp.status,
      });
    }

    const data = await resp.json();
    console.log(`✅ Telemetry event persisted: ${payload.id} - ${payload.vtid}/${payload.kind}`);

    // Broadcast to SSE (import from devhub)
    // Note: We'll need to export broadcastEvent from devhub.ts
    try {
      const { broadcastEvent } = require("./devhub");
      broadcastEvent({
        ts: timestamp,
        vtid: body.vtid,
        layer: body.layer,
        module: body.module,
        source: body.source,
        kind: body.kind,
        status: body.status,
        title: body.title,
        ref: payload.ref,
        link: body.link || null,
      });
      console.log(`📡 Event broadcasted to SSE feed`);
    } catch (e: any) {
      console.warn(`⚠️  SSE broadcast failed (non-critical): ${e.message}`);
      // Don't fail the request if SSE broadcast fails
    }

    // Return 202 Accepted
    return res.status(202).json({
      ok: true,
      id: eventId,
      vtid: body.vtid,
      timestamp: timestamp,
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

// POST /api/v1/telemetry/batch - Batch telemetry events
router.post("/api/v1/telemetry/batch", async (req: Request, res: Response) => {
  try {
    // Validate that body is an array
    if (!Array.isArray(req.body)) {
      return res.status(400).json({
        error: "Invalid payload",
        detail: "Expected array of telemetry events",
      });
    }

    // Validate each event
    const events = req.body.map((event: any) => TelemetryEventSchema.parse(event));

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("❌ Gateway misconfigured");
      return res.status(500).json({
        error: "Gateway misconfigured",
        detail: "Missing Supabase environment variables",
      });
    }

    // Prepare payloads
    const timestamp = new Date().toISOString();
    const payloads = events.map((event: TelemetryEvent) => ({
      id: randomUUID(),
      created_at: event.ts || timestamp,
      vtid: event.vtid,
      layer: event.layer,
      module: event.module,
      source: event.source,
      kind: event.kind,
      status: event.status,
      title: event.title,
      ref: event.ref || `vt/${event.vtid}-${event.kind.replace(/\./g, "-")}`,
      link: event.link || null,
      meta: event.meta || null,
    }));

    // Batch insert to OASIS
    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(payloads),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Batch OASIS persistence failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: "Batch persistence failed",
        detail: text,
        status: resp.status,
      });
    }

    const data = await resp.json();
    console.log(`✅ Batch telemetry persisted: ${payloads.length} events`);

    // Broadcast each to SSE
    try {
      const { broadcastEvent } = require("./devhub");
      events.forEach((event: TelemetryEvent, idx: number) => {
        broadcastEvent({
          ts: payloads[idx].created_at,
          vtid: event.vtid,
          layer: event.layer,
          module: event.module,
          source: event.source,
          kind: event.kind,
          status: event.status,
          title: event.title,
          ref: payloads[idx].ref,
          link: event.link || null,
        });
      });
      console.log(`📡 ${events.length} events broadcasted to SSE feed`);
    } catch (e: any) {
      console.warn(`⚠️  SSE broadcast failed (non-critical): ${e.message}`);
    }

    return res.status(202).json({
      ok: true,
      count: payloads.length,
      ids: payloads.map((p) => p.id),
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

// GET /api/v1/health - Gateway health check
router.get("/api/v1/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "vitana-gateway",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// GET /api/v1/telemetry/health - Telemetry subsystem health
router.get("/api/v1/telemetry/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "telemetry",
    timestamp: new Date().toISOString(),
  });
});
