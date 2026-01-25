import { Router, Request, Response } from "express";
import { z } from "zod";

/**
 * VTID-01215: Command Hub Operational Events API
 *
 * Provides a dedicated endpoint for the Operational Events screen that:
 * - Normalizes event topics into operational categories
 * - Supports filtering by category and status
 * - Returns paginated results
 */

export const operationalEventsRouter = Router();

// Query parameter validation
const OperationalEventsQuerySchema = z.object({
  topic: z.string().default("all"),
  status: z.string().default("all"),
  limit: z.coerce.number().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

// Category mapping rules - map raw event topics to operational categories
const CATEGORY_MAPPINGS: Record<string, RegExp[]> = {
  deployments: [
    /^cicd\.deploy\./i,
    /^deploy\./i,
    /^release\./i,
    /^version\./i,
    /\.deploy\./i,
    /\.deployed$/i,
  ],
  cicd: [
    /^cicd\.ci\./i,
    /^cicd\./i,
    /^github\./i,
    /^safe_merge\./i,
    /^build\./i,
  ],
  governance: [
    /^gov\./i,
    /^governance\./i,
    /^vtid\.governance\./i,
    /^controls\./i,
    /^GOVERNANCE/i,
    /\.governance\./i,
  ],
  autopilot: [
    /^autopilot\./i,
    /^worker_orchestrator\./i,
    /^worker_runner\./i,
    /^vtid\.stage\./i,
    /^preflight/i,
  ],
  operator: [
    /^operator\./i,
    /^orb\./i,
    /^command_hub\./i,
    /^commandhub\./i,
  ],
  lifecycle: [
    /^vtid\.lifecycle\./i,
    /^vtid\.spec\./i,
    /^vtid\.stage\./i,
  ],
};

// Normalize status values
function normalizeStatus(status: string | null | undefined): string {
  if (!status) return "INFO";
  const s = status.toUpperCase();
  if (s === "SUCCESS" || s === "OK" || s === "PASS") return "SUCCESS";
  if (s === "FAILED" || s === "ERROR" || s === "FAIL") return "FAILED";
  if (s === "WARNING" || s === "WARN") return "WARN";
  if (s === "IN_PROGRESS" || s === "START" || s === "BLOCKED") return "INFO";
  return "INFO";
}

// Determine category from topic
function categorizeEvent(topic: string | null | undefined): string {
  if (!topic) return "system";

  for (const [category, patterns] of Object.entries(CATEGORY_MAPPINGS)) {
    for (const pattern of patterns) {
      if (pattern.test(topic)) {
        return category;
      }
    }
  }

  return "system"; // fallback
}

/**
 * GET /api/v1/commandhub/operational-events
 *
 * Query params:
 * - topic: Category filter (all, deployments, cicd, governance, autopilot, operator, lifecycle, system)
 * - status: Status filter (all, SUCCESS, FAILED, INFO, WARN)
 * - limit: Max results (1-200, default 50)
 * - cursor: Pagination cursor (ISO timestamp for "before" queries)
 */
operationalEventsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error("[VTID-01215] Gateway misconfigured: Missing Supabase credentials");
      return res.status(500).json({
        ok: false,
        error: "Gateway misconfigured",
        data: null,
      });
    }

    // Validate query parameters
    const queryValidation = OperationalEventsQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      return res.status(400).json({
        ok: false,
        error: "Invalid query parameters: " + queryValidation.error.message,
        data: null,
      });
    }

    const { topic, status, limit, cursor } = queryValidation.data;

    // Build Supabase query - fetch more than needed for client-side category filtering
    // We need to over-fetch because category filtering happens after retrieval
    const fetchLimit = Math.min(limit * 4, 500);
    let queryParams = `limit=${fetchLimit}&order=created_at.desc`;

    // Apply cursor for pagination (before timestamp)
    if (cursor) {
      queryParams += `&created_at=lt.${encodeURIComponent(cursor)}`;
    }

    console.log(`[VTID-01215] Fetching operational events: topic=${topic}, status=${status}, limit=${limit}`);

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
      console.error(`[VTID-01215] OASIS query failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: `Database query failed: ${resp.status}`,
        data: null,
      });
    }

    const rawEvents = (await resp.json()) as any[];

    // Transform and categorize events
    let items = rawEvents.map((event: any) => {
      const category = categorizeEvent(event.topic);
      const normalizedStatus = normalizeStatus(event.status);

      return {
        id: event.id,
        created_at: event.created_at,
        topic: event.topic || "unknown",
        category: category,
        service: event.service || "unknown",
        status: normalizedStatus,
        message: event.message || event.title || "",
        vtid: event.vtid || (event.metadata?.vtid) || null,
        metadata: event.metadata || {},
      };
    });

    // Apply category filter
    if (topic !== "all") {
      items = items.filter((item) => item.category === topic.toLowerCase());
    }

    // Apply status filter
    if (status !== "all") {
      items = items.filter((item) => item.status === status.toUpperCase());
    }

    // Trim to requested limit
    const hasMore = items.length > limit;
    items = items.slice(0, limit);

    // Determine next cursor
    const nextCursor = hasMore && items.length > 0
      ? items[items.length - 1].created_at
      : null;

    console.log(`[VTID-01215] Returning ${items.length} operational events (hasMore=${hasMore})`);

    return res.status(200).json({
      ok: true,
      data: {
        items: items,
        next_cursor: nextCursor,
      },
      error: null,
    });
  } catch (e: any) {
    console.error("[VTID-01215] Unexpected error:", e);
    return res.status(500).json({
      ok: false,
      error: e.message || "Internal server error",
      data: null,
    });
  }
});

/**
 * GET /api/v1/commandhub/operational-events/categories
 * Returns available categories and their descriptions
 */
operationalEventsRouter.get("/categories", (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    data: {
      categories: [
        { id: "all", label: "All Types", description: "All operational events" },
        { id: "deployments", label: "Deployments", description: "Deploy events, releases, versioning" },
        { id: "cicd", label: "CI/CD", description: "Build, test, merge events" },
        { id: "governance", label: "Governance", description: "Governance checks, controls" },
        { id: "autopilot", label: "Autopilot", description: "Autonomous task execution" },
        { id: "operator", label: "Operator", description: "Operator actions" },
        { id: "lifecycle", label: "Lifecycle", description: "VTID lifecycle events" },
        { id: "system", label: "System", description: "Other system events" },
      ],
      statuses: [
        { id: "all", label: "All Status" },
        { id: "SUCCESS", label: "Success" },
        { id: "FAILED", label: "Failed" },
        { id: "INFO", label: "Info" },
        { id: "WARN", label: "Warning" },
      ],
    },
    error: null,
  });
});

export default operationalEventsRouter;
