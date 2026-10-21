import { Router, Request, Response } from "express";

export const router = Router();

// Type definitions
interface TickerEvent {
  ts: string;
  vtid: string;
  layer: string;
  module: string;
  source: string;
  kind: string;
  status: string;
  title: string;
  ref: string;
  link: string | null;
}

interface DatabaseEvent {
  created_at: string;
  vtid?: string;
  topic?: string;
  service?: string;
  status: string;
  message: string;
  link?: string;
}

// In-memory cache for last 20 events (for instant replay on connection)
let eventCache: TickerEvent[] = [];
const CACHE_SIZE = 20;

// Helper to update cache
export function broadcastEvent(event: TickerEvent) {
  eventCache.unshift(event);
  if (eventCache.length > CACHE_SIZE) {
    eventCache = eventCache.slice(0, CACHE_SIZE);
  }
}

// Helper to transform DB event to ticker format
function transformEventToTicker(dbEvent: DatabaseEvent): TickerEvent {
  const vtid = dbEvent.vtid || "DEV-UNKNOWN-0000";
  const vtidParts = vtid.split("-");
  const layer = vtidParts[1] || "UNKNOWN";
  
  const module = (dbEvent.service || "CORE").toUpperCase();
  
  const statusMap: Record<string, string> = {
    success: "success",
    error: "failure",
    warning: "in_progress",
    info: "info",
  };
  
  const status = statusMap[dbEvent.status] || "info";
  
  const sourceMap: Record<string, string> = {
    gateway: "oasis.events",
    github: "github.actions",
    gcp: "gcp.deploy",
    agent: "agent.ping",
  };
  
  const source = sourceMap[dbEvent.service || ""] || "oasis.events";
  const kind = dbEvent.topic || "event";
  const action = (dbEvent.topic || "EVENT").toUpperCase().replace(/\./g, "-");
  const title = `${layer}-${module}-${action}`;
  const ref = `vt/${vtid}-${kind.replace(/\./g, "-")}`;
  
  return {
    ts: dbEvent.created_at,
    vtid: vtid,
    layer: layer,
    module: module,
    source: source,
    kind: kind,
    status: status,
    title: title,
    ref: ref,
    link: dbEvent.link || null,
  };
}

// Helper to generate mock event for testing
function generateMockEvent(): TickerEvent {
  const now = new Date().toISOString();
  const mockEvents: TickerEvent[] = [
    {
      ts: now,
      vtid: "DEV-CICDL-0031",
      layer: "CICDL",
      module: "CORE",
      source: "oasis.events",
      kind: "task.init",
      status: "info",
      title: "CICDL-CORE-TASK-INIT",
      ref: "vt/DEV-CICDL-0031-task-init",
      link: null,
    },
    {
      ts: now,
      vtid: "DEV-CICDL-0031",
      layer: "CICDL",
      module: "GATEWAY",
      source: "github.actions",
      kind: "workflow_run",
      status: "in_progress",
      title: "CICDL-GATEWAY-WORKFLOW-RUN",
      ref: "vt/DEV-CICDL-0031-workflow-run",
      link: "https://github.com/exafyltd/vitana-platform/actions",
    },
    {
      ts: now,
      vtid: "DEV-CICDL-0031",
      layer: "CICDL",
      module: "DEPLOY",
      source: "gcp.deploy",
      kind: "deploy",
      status: "success",
      title: "CICDL-DEPLOY-CLOUD-RUN",
      ref: "vt/DEV-CICDL-0031-deploy",
      link: "https://console.cloud.google.com/run",
    },
    {
      ts: now,
      vtid: "DEV-CICDL-0031",
      layer: "CICDL",
      module: "AGENT",
      source: "agent.ping",
      kind: "ping",
      status: "success",
      title: "CICDL-AGENT-HEALTH-CHECK",
      ref: "vt/DEV-CICDL-0031-ping",
      link: null,
    },
  ];
  
  return mockEvents[Math.floor(Math.random() * mockEvents.length)];
}

// SSE endpoint: GET /api/v1/devhub/feed
router.get("/api/v1/devhub/feed", async (req: Request, res: Response) => {
  console.log("🎯 SSE client connected to /api/v1/devhub/feed");
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  
  res.write(`data: ${JSON.stringify({ type: "connected", ts: new Date().toISOString() })}\n\n`);
  
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;
  
  if (!svcKey || !supabaseUrl) {
    console.error("❌ SSE: Missing Supabase credentials");
    res.write(`data: ${JSON.stringify({ error: "Configuration error" })}\n\n`);
    res.end();
    return;
  }
  
  const sendEvent = (event: TickerEvent | { type: string; ts: string }) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      console.error("❌ SSE: Error writing event:", err);
    }
  };
  
  try {
    if (eventCache.length > 0) {
      console.log(`📤 SSE: Replaying ${eventCache.length} cached events`);
      eventCache.slice().reverse().forEach(event => sendEvent(event));
    } else {
      console.log("📥 SSE: Fetching last 20 events from database");
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_events?order=created_at.desc&limit=20`,
        {
          headers: {
            "Content-Type": "application/json",
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
        }
      );
      
      if (resp.ok) {
        const dbEvents = await resp.json() as DatabaseEvent[];
        console.log(`✅ SSE: Retrieved ${dbEvents.length} events from database`);
        
        if (dbEvents.length > 0) {
          const tickerEvents = dbEvents.reverse().map((dbEvent: DatabaseEvent) => {
            const tickerEvent = transformEventToTicker(dbEvent);
            broadcastEvent(tickerEvent);
            return tickerEvent;
          });
          
          tickerEvents.forEach((event: TickerEvent) => sendEvent(event));
        } else {
          console.log("⚠️ SSE: No events in database, sending mock events");
          for (let i = 0; i < 5; i++) {
            const mockEvent = generateMockEvent();
            broadcastEvent(mockEvent);
            sendEvent(mockEvent);
          }
        }
      } else {
        console.error(`❌ SSE: Database query failed: ${resp.status}`);
        for (let i = 0; i < 5; i++) {
          const mockEvent = generateMockEvent();
          broadcastEvent(mockEvent);
          sendEvent(mockEvent);
        }
      }
    }
  } catch (err) {
    console.error("❌ SSE: Error during initial replay:", err);
  }
  
  let lastEventTime = new Date();
  
  const pollInterval = setInterval(async () => {
    try {
      // VTID-01227: Add LIMIT to prevent disk IO exhaustion
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_events?created_at=gt.${lastEventTime.toISOString()}&order=created_at.asc&limit=50`,
        {
          headers: {
            "Content-Type": "application/json",
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
        }
      );
      
      if (resp.ok) {
        const newEvents = await resp.json() as DatabaseEvent[];
        if (newEvents.length > 0) {
          console.log(`📨 SSE: ${newEvents.length} new event(s) detected`);
          newEvents.forEach((dbEvent: DatabaseEvent) => {
            const tickerEvent = transformEventToTicker(dbEvent);
            broadcastEvent(tickerEvent);
            sendEvent(tickerEvent);
            lastEventTime = new Date(dbEvent.created_at);
          });
        }
      }
    } catch (err) {
      console.error("❌ SSE: Error polling for new events:", err);
    }
  }, 5000); // VTID-01227: Increased from 2s to 5s to reduce DB load
  
  const heartbeatInterval = setInterval(() => {
    try {
      sendEvent({
        type: "heartbeat",
        ts: new Date().toISOString(),
      });
    } catch (err) {
      console.error("❌ SSE: Heartbeat failed:", err);
    }
  }, 15000);
  
  req.on("close", () => {
    console.log("👋 SSE client disconnected");
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

router.get("/api/v1/devhub/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "devhub-feed",
    cache_size: eventCache.length,
    timestamp: new Date().toISOString(),
  });
});

