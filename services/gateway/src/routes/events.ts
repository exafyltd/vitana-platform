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
      });
    }

    const eventId = randomUUID();
    const timestamp = body.created_at || new Date().toISOString();

    const payload = {
      id: eventId,
      created_at: timestamp,
      vtid: body.vtid,
      topic: body.type,
      service: body.source,
      role: "API",
      model: "event-ingestion-api",
      status: body.status,
      message: body.message,
      link: null,
      metadata: body.payload || {},
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
      });
    }

    const data = await resp.json();
    const insertedEvent = Array.isArray(data) ? data[0] : data;

    console.log(`✅ Event ingested: ${eventId} - ${body.vtid}/${body.type}`);

    return res.status(200).json({
      ok: true,
      event_id: insertedEvent.id
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

/**
 * GET /api/v1/events
 * DEV-OASIS-0210-B: Canonical events list endpoint - queries local oasis_events table
 *
 * Query params:
 * - topic: Filter by event type/topic (e.g., "assistant.session.started", "deploy.gateway.success")
 * - vtid: Filter by VTID (e.g., "VTID-0416")
 * - limit: Max number of events to return (default 50, max 200)
 * - since: ISO timestamp to filter events after
 */
router.get("/api/v1/events", async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("[DEV-OASIS-0210-B] Gateway misconfigured: Missing Supabase credentials");
      return res.status(500).json({
        ok: false,
        error: "Gateway misconfigured",
      });
    }

    // Parse query parameters
    const limitParam = parseInt(req.query.limit as string) || 50;
    const limit = Math.min(Math.max(limitParam, 1), 200); // Clamp between 1-200
    const topic = req.query.topic as string;
    const vtid = req.query.vtid as string;
    const since = req.query.since as string;
    const type = req.query.type as string; // Legacy support

    // Build Supabase REST API query
    let queryParams = `limit=${limit}&order=created_at.desc`;

    // Topic filter - filter by event type/topic column
    if (topic) {
      queryParams += `&topic=eq.${encodeURIComponent(topic)}`;
    } else if (type) {
      // Legacy support for 'type' param
      queryParams += `&topic=eq.${encodeURIComponent(type)}`;
    }

    // VTID filter
    if (vtid) {
      queryParams += `&vtid=eq.${encodeURIComponent(vtid)}`;
    }

    // Since filter - events created after timestamp
    if (since) {
      queryParams += `&created_at=gt.${encodeURIComponent(since)}`;
    }

    console.log(`[DEV-OASIS-0210-B] Querying oasis_events: topic=${topic || 'all'}, vtid=${vtid || 'all'}, limit=${limit}`);

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
      console.error(`[DEV-OASIS-0210-B] Supabase query failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: "Database query failed",
      });
    }

    const events = (await resp.json()) as any[];

    // Transform to Gateway standard format
    const normalizedEvents = events.map((event: any) => ({
      id: event.id,
      vtid: event.vtid || (event.metadata && event.metadata.vtid) || undefined,
      type: event.topic || "unknown",
      topic: event.topic || "unknown",
      source: event.service || "oasis",
      status: event.status,
      message: event.message,
      created_at: event.created_at,
      payload: {
        message: event.message,
        vtid: event.vtid,
        swv: event.metadata && event.metadata.swv,
        service: event.metadata && event.metadata.service,
        branch: event.metadata && event.metadata.branch,
        environment: event.metadata && event.metadata.environment,
        ...event.metadata,
      },
    }));

    console.log(`[DEV-OASIS-0210-B] Returning ${normalizedEvents.length} events`);

    return res.status(200).json({
      ok: true,
      count: normalizedEvents.length,
      data: normalizedEvents,
    });
  } catch (e: any) {
    console.error("[DEV-OASIS-0210-B] Error:", e);
    return res.status(500).json({
      ok: false,
      error: e.message || "Internal server error",
    });
  }
});

/**
 * GET /events (legacy route)
 */
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

/**
 * VTID-0416: Deploy Event Schema for CI/CD workflow
 * Accepts deploy events from the governed CI pipeline
 */
const DeployEventSchema = z.object({
  type: z.string().min(1, "type required"),
  vtid: z.string().min(1, "vtid required"),
  service: z.string().min(1, "service required"),
  branch: z.string().optional(),
  source: z.string().default("ci_cd"),
  message: z.string().min(1, "message required"),
  details: z.record(z.any()).optional(),
});

/**
 * POST /api/v1/oasis/events
 * VTID-0416: Emit deploy events to OASIS from CI/CD workflow
 */
router.post("/api/v1/oasis/events", async (req: Request, res: Response) => {
  try {
    const validation = DeployEventSchema.safeParse(req.body);

    if (!validation.success) {
      console.error("[VTID-0416] Validation error:", validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: validation.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      });
    }

    const body = validation.data;

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("[VTID-0416] Gateway misconfigured: Missing Supabase credentials");
      return res.status(500).json({
        ok: false,
        error: "Gateway misconfigured",
      });
    }

    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    // Determine status based on event type
    let eventStatus: string = "info";
    if (body.type.includes(".success")) {
      eventStatus = "success";
    } else if (body.type.includes(".failed") || body.type.includes(".blocked")) {
      eventStatus = "error";
    } else if (body.type.includes(".warning")) {
      eventStatus = "warning";
    }

    const payload = {
      id: eventId,
      created_at: timestamp,
      vtid: body.vtid,
      topic: body.type,
      service: body.source,
      role: "CICD",
      model: "vtid-0416-governed-deploy",
      status: eventStatus,
      message: body.message,
      link: null,
      metadata: {
        service: body.service,
        branch: body.branch,
        ...body.details,
      },
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
      console.error(`[VTID-0416] OASIS insert failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: "Database insert failed",
      });
    }

    const data = await resp.json();
    const insertedEvent = Array.isArray(data) ? data[0] : data;

    console.log(`[VTID-0416] Deploy event recorded: ${eventId} - ${body.type} for ${body.service}`);

    return res.status(200).json({
      ok: true,
      event_id: insertedEvent.id,
      vtid: body.vtid,
      type: body.type,
    });
  } catch (e: any) {
    console.error("[VTID-0416] Unexpected error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
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

/**
 * DEV-COMHU-0202: SSE Stream endpoint for real-time events
 * GET /api/v1/events/stream
 *
 * Provides Server-Sent Events for real-time event streaming to Command Hub UI.
 * Supports the following query parameters:
 * - channel: Filter channel (e.g., "operator")
 * - topic: Filter by event topic (e.g., "deploy.gateway.success")
 * - vtid: Filter by VTID
 */
router.get("/api/v1/events/stream", async (req: Request, res: Response) => {
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ status: "connected", timestamp: new Date().toISOString() })}\n\n`);

  // Track last seen event ID for polling
  let lastSeenId: string | null = null;
  let lastSeenTimestamp: string | null = null;

  // Function to fetch and send new events
  const pollEvents = async () => {
    if (!svcKey || !supabaseUrl) {
      console.error("[SSE] Gateway misconfigured");
      return;
    }

    try {
      // Build query params - fetch recent events
      let queryParams = "limit=20&order=created_at.desc";

      // If we have a last seen timestamp, only get newer events
      if (lastSeenTimestamp) {
        queryParams += `&created_at=gt.${lastSeenTimestamp}`;
      }

      // Apply optional filters
      const topic = req.query.topic as string;
      const vtid = req.query.vtid as string;
      if (topic) queryParams += `&topic=eq.${topic}`;
      if (vtid) queryParams += `&vtid=eq.${vtid}`;

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
        console.error(`[SSE] OASIS poll failed: ${resp.status}`);
        return;
      }

      const events = (await resp.json()) as any[];

      // Send new events (reverse to send oldest first)
      const newEvents = events.filter((e: any) => e.id !== lastSeenId).reverse();

      for (const event of newEvents) {
        // Normalize event structure for frontend
        const normalizedEvent = {
          id: event.id,
          type: event.topic || event.kind || "unknown",
          topic: event.topic || event.kind || "unknown",
          vtid: event.vtid || (event.metadata && event.metadata.vtid) || null,
          swv: event.metadata && event.metadata.swv || null,
          service: event.service || (event.metadata && event.metadata.service) || null,
          created_at: event.created_at,
          status: event.status,
          message: event.message || event.title || "",
          task_stage: event.task_stage || (event.metadata && event.metadata.task_stage) || null,
          payload: {
            message: event.message || event.title || "",
            vtid: event.vtid,
            swv: event.metadata && event.metadata.swv,
            service: event.metadata && event.metadata.service,
            branch: event.metadata && event.metadata.branch,
            task_stage: event.task_stage || (event.metadata && event.metadata.task_stage),
            ...event.metadata,
          },
        };

        res.write(`event: oasis-event\ndata: ${JSON.stringify(normalizedEvent)}\n\n`);

        lastSeenId = event.id;
        if (event.created_at) {
          lastSeenTimestamp = event.created_at;
        }
      }
    } catch (err: any) {
      console.error("[SSE] Poll error:", err.message);
    }
  };

  // Initial poll to send recent events
  await pollEvents();

  // Set up polling interval (every 3 seconds)
  const pollInterval = setInterval(pollEvents, 3000);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeatInterval = setInterval(() => {
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, 30000);

  // Cleanup on client disconnect
  req.on("close", () => {
    console.log("[SSE] Client disconnected");
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

/**
 * VTID-01005: Terminal Lifecycle Event Schema
 * Ensures mandatory terminal lifecycle events are emitted for governance compliance
 */
const TerminalLifecycleEventSchema = z.object({
  vtid: z.string().min(1, "vtid required"),
  outcome: z.enum(["success", "failed"], {
    errorMap: () => ({ message: "outcome must be: success or failed" }),
  }),
  source: z.enum(["claude", "cicd", "operator"], {
    errorMap: () => ({ message: "source must be: claude, cicd, or operator" }),
  }),
  summary: z.string().optional(),
});

/**
 * POST /api/v1/vtid/lifecycle/complete
 * VTID-01005: Emit terminal lifecycle event for a VTID
 *
 * This is the MANDATORY endpoint for marking a VTID as terminally complete.
 * OASIS is the single source of truth for task completion.
 *
 * Body:
 * - vtid: The VTID to mark as complete (required)
 * - outcome: "success" or "failed" (required)
 * - source: "claude", "cicd", or "operator" (required)
 * - summary: Optional summary message
 *
 * Idempotency: If a terminal lifecycle event already exists for this VTID,
 * this endpoint returns 200 OK with a note that the event already exists.
 */
router.post("/api/v1/vtid/lifecycle/complete", async (req: Request, res: Response) => {
  try {
    const validation = TerminalLifecycleEventSchema.safeParse(req.body);

    if (!validation.success) {
      console.error("[VTID-01005] Validation error:", validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: validation.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      });
    }

    const body = validation.data;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("[VTID-01005] Gateway misconfigured: Missing Supabase credentials");
      return res.status(500).json({
        ok: false,
        error: "Gateway misconfigured",
      });
    }

    // Check for existing terminal lifecycle event (idempotency)
    const existingResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${body.vtid}&or=(topic.eq.vtid.lifecycle.completed,topic.eq.vtid.lifecycle.failed)&limit=1`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

    if (existingResp.ok) {
      const existingEvents = await existingResp.json() as any[];
      if (existingEvents.length > 0) {
        console.log(`[VTID-01005] Terminal lifecycle event already exists for ${body.vtid}`);
        return res.status(200).json({
          ok: true,
          vtid: body.vtid,
          already_exists: true,
          existing_event_id: existingEvents[0].id,
          message: `Terminal lifecycle event already exists for ${body.vtid}`,
        });
      }
    }

    // Emit the terminal lifecycle event
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();
    const topic = body.outcome === "success" ? "vtid.lifecycle.completed" : "vtid.lifecycle.failed";
    const eventStatus = body.outcome === "success" ? "success" : "error";
    const defaultMessage = body.outcome === "success"
      ? `VTID ${body.vtid} completed successfully`
      : `VTID ${body.vtid} failed`;

    const payload = {
      id: eventId,
      created_at: timestamp,
      vtid: body.vtid,
      topic: topic,
      service: `vtid-lifecycle-${body.source}`,
      role: "GOVERNANCE",
      model: "vtid-01005-terminal-lifecycle",
      status: eventStatus,
      message: body.summary || defaultMessage,
      link: null,
      metadata: {
        vtid: body.vtid,
        outcome: body.outcome,
        source: body.source,
        terminal: true,
        completed_at: timestamp,
      },
    };

    const insertResp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!insertResp.ok) {
      const text = await insertResp.text();
      console.error(`[VTID-01005] OASIS insert failed: ${insertResp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: "Database insert failed",
      });
    }

    const data = await insertResp.json();
    const insertedEvent = Array.isArray(data) ? data[0] : data;

    console.log(`[VTID-01005] Terminal lifecycle event emitted: ${eventId} - ${body.vtid} (${body.outcome})`);

    // Also update the vtid_ledger status
    const ledgerStatus = body.outcome === "success" ? "complete" : "failed";
    const ledgerUpdateResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${body.vtid}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
        body: JSON.stringify({
          status: ledgerStatus,
          updated_at: timestamp,
        }),
      }
    );

    if (!ledgerUpdateResp.ok) {
      console.warn(`[VTID-01005] Ledger update failed for ${body.vtid}, but lifecycle event was emitted`);
    }

    return res.status(200).json({
      ok: true,
      event_id: insertedEvent.id,
      vtid: body.vtid,
      outcome: body.outcome,
      topic: topic,
      message: `Terminal lifecycle event emitted for ${body.vtid}`,
    });
  } catch (e: any) {
    console.error("[VTID-01005] Unexpected error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
});

/**
 * VTID-01009: Lifecycle Start Event Schema
 * Emits authoritative lifecycle.started event when task is activated
 */
const LifecycleStartEventSchema = z.object({
  vtid: z.string().min(1, "vtid required"),
  source: z.enum(["claude", "cicd", "operator", "command-hub"], {
    errorMap: () => ({ message: "source must be: claude, cicd, operator, or command-hub" }),
  }),
  summary: z.string().optional(),
});

/**
 * POST /api/v1/vtid/lifecycle/start
 * VTID-01009: Emit lifecycle.started event when task is activated
 *
 * This endpoint emits an authoritative OASIS event when a task transitions
 * from SCHEDULED to IN_PROGRESS. OASIS is the single source of truth.
 *
 * Body:
 * - vtid: The VTID to mark as started (required)
 * - source: "claude", "cicd", "operator", or "command-hub" (required)
 * - summary: Optional summary message
 *
 * Idempotency: If a lifecycle.started event already exists for this VTID,
 * this endpoint returns 200 OK with a note that the event already exists.
 */
router.post("/api/v1/vtid/lifecycle/start", async (req: Request, res: Response) => {
  try {
    const validation = LifecycleStartEventSchema.safeParse(req.body);

    if (!validation.success) {
      console.error("[VTID-01009] Validation error:", validation.error.errors);
      return res.status(400).json({
        ok: false,
        error: validation.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      });
    }

    const body = validation.data;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("[VTID-01009] Gateway misconfigured: Missing Supabase credentials");
      return res.status(500).json({
        ok: false,
        error: "Gateway misconfigured",
      });
    }

    // Check for existing started event (idempotency)
    const existingResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${body.vtid}&topic=eq.vtid.lifecycle.started&limit=1`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
      }
    );

    if (existingResp.ok) {
      const existingEvents = await existingResp.json() as any[];
      if (existingEvents.length > 0) {
        console.log(`[VTID-01009] Lifecycle started event already exists for ${body.vtid}`);
        return res.status(200).json({
          ok: true,
          vtid: body.vtid,
          already_exists: true,
          existing_event_id: existingEvents[0].id,
          message: `Lifecycle started event already exists for ${body.vtid}`,
        });
      }
    }

    // Emit the lifecycle.started event
    const eventId = randomUUID();
    const timestamp = new Date().toISOString();
    const topic = "vtid.lifecycle.started";
    const defaultMessage = `${body.vtid}: Activated from Command Hub`;

    const payload = {
      id: eventId,
      created_at: timestamp,
      vtid: body.vtid,
      topic: topic,
      service: `vtid-lifecycle-${body.source}`,
      role: "GOVERNANCE",
      model: "vtid-01009-lifecycle-start",
      status: "in_progress",
      message: body.summary || defaultMessage,
      link: null,
      metadata: {
        vtid: body.vtid,
        source: body.source,
        started_at: timestamp,
      },
    };

    const insertResp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!insertResp.ok) {
      const text = await insertResp.text();
      console.error(`[VTID-01009] OASIS insert failed: ${insertResp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: "Database insert failed",
      });
    }

    const data = await insertResp.json();
    const insertedEvent = Array.isArray(data) ? data[0] : data;

    console.log(`[VTID-01009] Lifecycle started event emitted: ${eventId} - ${body.vtid}`);

    // Also update the vtid_ledger status to in_progress
    const ledgerUpdateResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${body.vtid}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
        body: JSON.stringify({
          status: "in_progress",
          updated_at: timestamp,
        }),
      }
    );

    if (!ledgerUpdateResp.ok) {
      console.warn(`[VTID-01009] Ledger update failed for ${body.vtid}, but lifecycle event was emitted`);
    }

    return res.status(200).json({
      ok: true,
      event_id: insertedEvent.id,
      vtid: body.vtid,
      topic: topic,
      message: `Lifecycle started event emitted for ${body.vtid}`,
    });
  } catch (e: any) {
    console.error("[VTID-01009] Unexpected error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
    });
  }
});

/**
 * POST /api/v1/vtid/lifecycle/backfill
 * VTID-01005: Backfill terminal lifecycle events for VTIDs that are already complete
 *
 * This endpoint scans VTIDs that have terminal states (from ledger or events)
 * but don't have explicit terminal lifecycle events, and creates them.
 *
 * Query params:
 * - limit: Max VTIDs to process (default 50)
 * - dry_run: If true, don't actually emit events (default false)
 */
router.post("/api/v1/vtid/lifecycle/backfill", async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({ ok: false, error: "Gateway misconfigured" });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const dryRun = req.query.dry_run === "true";

    console.log(`[VTID-01005] Backfill request: limit=${limit}, dry_run=${dryRun}`);

    // Step 1: Get all VTIDs with terminal ledger status
    const ledgerResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?or=(status.eq.done,status.eq.complete,status.eq.deployed,status.eq.merged,status.eq.closed,status.eq.failed,status.eq.error)&limit=${limit}`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
    );

    if (!ledgerResp.ok) {
      return res.status(502).json({ ok: false, error: "Failed to fetch ledger" });
    }

    const terminalVtids = await ledgerResp.json() as any[];

    // Step 2: Get existing terminal lifecycle events
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?or=(topic.eq.vtid.lifecycle.completed,topic.eq.vtid.lifecycle.failed)`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
    );

    let existingTerminalEvents: any[] = [];
    if (eventsResp.ok) {
      existingTerminalEvents = await eventsResp.json() as any[];
    }

    const vtidsWithTerminalEvents = new Set(existingTerminalEvents.map((e: any) => e.vtid));

    // Step 3: Find VTIDs that need backfill
    const vtidsToBackfill = terminalVtids.filter((v: any) => !vtidsWithTerminalEvents.has(v.vtid));

    console.log(`[VTID-01005] Found ${vtidsToBackfill.length} VTIDs needing backfill`);

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dry_run: true,
        vtids_to_backfill: vtidsToBackfill.map((v: any) => ({
          vtid: v.vtid,
          current_status: v.status,
          proposed_outcome: ['done', 'complete', 'deployed', 'merged', 'closed'].includes(v.status.toLowerCase()) ? 'success' : 'failed',
        })),
        count: vtidsToBackfill.length,
      });
    }

    // Step 4: Emit terminal lifecycle events for each
    const results: any[] = [];
    for (const vtidRow of vtidsToBackfill) {
      const outcome = ['done', 'complete', 'deployed', 'merged', 'closed'].includes(vtidRow.status.toLowerCase())
        ? 'success'
        : 'failed';
      const topic = outcome === 'success' ? 'vtid.lifecycle.completed' : 'vtid.lifecycle.failed';
      const eventId = randomUUID();
      const timestamp = new Date().toISOString();

      const payload = {
        id: eventId,
        created_at: timestamp,
        vtid: vtidRow.vtid,
        topic: topic,
        service: 'vtid-lifecycle-backfill',
        role: 'GOVERNANCE',
        model: 'vtid-01005-backfill',
        status: outcome === 'success' ? 'success' : 'error',
        message: `VTID ${vtidRow.vtid} marked ${outcome} (backfilled)`,
        link: null,
        metadata: {
          vtid: vtidRow.vtid,
          outcome: outcome,
          source: 'backfill',
          terminal: true,
          original_status: vtidRow.status,
          backfilled_at: timestamp,
        },
      };

      const insertResp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
        body: JSON.stringify(payload),
      });

      results.push({
        vtid: vtidRow.vtid,
        outcome,
        event_id: eventId,
        success: insertResp.ok,
      });
    }

    console.log(`[VTID-01005] Backfill complete: ${results.filter(r => r.success).length}/${results.length} events emitted`);

    return res.status(200).json({
      ok: true,
      backfilled: results,
      count: results.filter(r => r.success).length,
    });
  } catch (e: any) {
    console.error("[VTID-01005] Backfill error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
