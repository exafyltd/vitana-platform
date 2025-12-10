import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { mapRawToStage, normalizeStage, isValidStage, emptyStageCounters, VALID_STAGES, type TaskStage, type StageCounters } from "../lib/stage-mapping";

export const router = Router();

// Telemetry Event Schema (TickerEvent format)
// VTID-0526-D: Added task_stage for 4-stage mapping
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
  task_stage: z.enum(["PLANNER", "WORKER", "VALIDATOR", "DEPLOY"]).optional(), // VTID-0526-D
});

type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

// POST /event - Single telemetry event
// VTID-0526-D: Route mounted at /api/v1/telemetry, so this becomes /api/v1/telemetry/event
router.post("/event", async (req: Request, res: Response) => {
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

    // VTID-0526-D: Determine task_stage - use provided value or auto-map from kind/title
    const taskStage = body.task_stage || mapRawToStage(body.kind, body.title, body.status);

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
      task_stage: taskStage, // VTID-0526-D
      // Legacy fields required by existing oasis_events table
      topic: body.kind, // Use kind as topic for compatibility
      service: body.source, // Use source as service for compatibility
      message: body.title, // Use title as message for compatibility
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
        task_stage: taskStage, // VTID-0526-D
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

// POST /batch - Batch telemetry events
// VTID-0526-D: Route mounted at /api/v1/telemetry, so this becomes /api/v1/telemetry/batch
router.post("/batch", async (req: Request, res: Response) => {
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
    // VTID-0526-D: Include task_stage with auto-mapping
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
      task_stage: event.task_stage || mapRawToStage(event.kind, event.title, event.status), // VTID-0526-D
      // Legacy fields required by existing oasis_events table
      topic: event.kind,
      service: event.source,
      message: event.title,
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
          task_stage: payloads[idx].task_stage, // VTID-0526-D
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

// GET /health - Telemetry subsystem health
// VTID-0526-D: Route mounted at /api/v1/telemetry, so this becomes /api/v1/telemetry/health
router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "telemetry",
    timestamp: new Date().toISOString(),
  });
});

/**
 * VTID-0526-D: Telemetry Snapshot Endpoint
 *
 * GET /snapshot
 * Route mounted at /api/v1/telemetry, so this becomes /api/v1/telemetry/snapshot
 *
 * Returns a snapshot of:
 * - Recent telemetry events (last N events)
 * - Stage counters (PLANNER, WORKER, VALIDATOR, DEPLOY)
 *
 * This endpoint is used by the frontend for auto-loading telemetry
 * when the Operator Console / Command Hub opens.
 */
router.get("/snapshot", async (req: Request, res: Response) => {
  console.log("[Telemetry Snapshot] Request received");

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

    // Parse query params
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const hoursBack = Math.min(parseInt(req.query.hours as string) || 24, 168); // Max 7 days

    // Calculate time window
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    // Fetch recent events with task_stage
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?select=id,created_at,vtid,kind,status,title,task_stage,source,layer&order=created_at.desc&limit=${limit}`,
      {
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

    if (!eventsResp.ok) {
      const text = await eventsResp.text();
      console.error(`❌ Events query failed: ${eventsResp.status} - ${text}`);
      return res.status(502).json({
        error: "Database query failed",
        detail: text,
      });
    }

    const events = await eventsResp.json();

    // Fetch stage counters (counts of events per stage within time window)
    // Using a separate query for efficiency
    const countersResp = await fetch(
      `${supabaseUrl}/rest/v1/rpc/count_events_by_stage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
        body: JSON.stringify({ since_time: since }),
      }
    );

    // Build counters - either from RPC or from manual count
    let counters: StageCounters = emptyStageCounters();

    if (countersResp.ok) {
      // If RPC exists and works, use it
      const rpcResult = (await countersResp.json()) as Array<{ task_stage: string; count: string | number }>;
      if (Array.isArray(rpcResult)) {
        for (const row of rpcResult) {
          if (isValidStage(row.task_stage)) {
            counters[row.task_stage] = parseInt(String(row.count)) || 0;
          }
        }
      }
    } else {
      // Fallback: count from events in memory (less accurate but works without RPC)
      console.log("[Telemetry Snapshot] RPC not available, counting from events");

      // Fetch all events with stage in time window for counting
      const countResp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_events?select=task_stage&created_at=gte.${since}&task_stage=not.is.null`,
        {
          headers: {
            "Content-Type": "application/json",
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
        }
      );

      if (countResp.ok) {
        const countEvents = (await countResp.json()) as Array<{ task_stage: string }>;
        for (const event of countEvents) {
          if (isValidStage(event.task_stage)) {
            counters[event.task_stage]++;
          }
        }
      }
    }

    // Type the events array
    const eventsTyped = events as Array<{
      id: string;
      created_at: string;
      vtid: string;
      kind: string;
      status: string;
      title: string;
      task_stage: string | null;
      source: string;
      layer: string;
    }>;

    console.log(`[Telemetry Snapshot] Returning ${eventsTyped.length} events, counters:`, counters);

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      events: eventsTyped.map((e) => ({
        id: e.id,
        created_at: e.created_at,
        vtid: e.vtid,
        kind: e.kind,
        status: e.status,
        title: e.title,
        task_stage: e.task_stage,
        source: e.source,
        layer: e.layer,
      })),
      counters: counters,
      valid_stages: VALID_STAGES,
    });
  } catch (e: any) {
    console.error("❌ Telemetry snapshot error:", e);
    return res.status(500).json({
      error: "Internal server error",
      detail: e.message,
    });
  }
});
