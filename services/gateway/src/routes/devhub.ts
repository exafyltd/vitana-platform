import { Router, Request, Response } from "express";

export const router = Router();

// In-memory cache for last 20 events (for instant replay on connection)
let eventCache: any[] = [];
const CACHE_SIZE = 20;

// Helper to update cache
function updateCache(event: any) {
  eventCache.unshift(event);
  if (eventCache.length > CACHE_SIZE) {
    eventCache = eventCache.slice(0, CACHE_SIZE);
  }
}

// Helper to transform DB event to ticker format
function transformEventToTicker(dbEvent: any): any {
  // Extract layer and module from VTID (e.g., "DEV-CICDL-0031" -> layer: "CICDL")
  const vtid = dbEvent.vtid || "DEV-UNKNOWN-0000";
  const vtidParts = vtid.split("-");
  const layer = vtidParts[1] || "UNKNOWN";
  
  // Determine module from service or topic
  const module = (dbEvent.service || "CORE").toUpperCase();
  
  // Map database status to ticker status
  const statusMap: Record<string, string> = {
    success: "success",
    error: "failure",
    warning: "in_progress",
    info: "info",
  };
  
  const status = statusMap[dbEvent.status] || "info";
  
  // Determine source from service
  const sourceMap: Record<string, string> = {
    gateway: "oasis.events",
    github: "github.actions",
    gcp: "gcp.deploy",
    agent: "agent.ping",
  };
  
  const source = sourceMap[dbEvent.service] || "oasis.events";
  
  // Determine kind from topic
  const kind = dbEvent.topic || "event";
  
  // Create title in UPPERCASE format: LAYER-MODULE-ACTION
  const action = (dbEvent.topic || "EVENT").toUpperCase().replace(/\./g, "-");
  const title = `${layer}-${module}-${action}`;
  
  // Create ref from VTID
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
function generateMockEvent(): any {
  const now = new Date().toISOString();
  const mockEvents = [
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
  
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  
  // Send immediate connection success
  res.write(`data: ${JSON.stringify({ type: "connected", ts: new Date().toISOString() })}\n\n`);
  
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;
  
  if (!svcKey || !supabaseUrl) {
    console.error("❌ SSE: Missing Supabase credentials");
    res.write(`data: ${JSON.stringify({ error: "Configuration error" })}\n\n`);
    res.end();
    return;
  }
  
  // Function to send event to client
  const sendEvent = (event: any) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      console.error("❌ SSE: Error writing event:", err);
    }
  };
  
  // Step 1: Replay last 20 events from cache OR fetch from database
  try {
    if (eventCache.length > 0) {
      console.log(`📤 SSE: Replaying ${eventCache.length} cached events`);
      eventCache.slice().reverse().forEach(event => sendEvent(event));
    } else {
      // Fetch last 20 events from database
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
        const dbEvents = await resp.json();
        console.log(`✅ SSE: Retrieved ${dbEvents.length} events from database`);
        
        if (dbEvents.length > 0) {
          // Transform and cache events
          const tickerEvents = dbEvents.reverse().map((dbEvent: any) => {
            const tickerEvent = transformEventToTicker(dbEvent);
            updateCache(tickerEvent);
            return tickerEvent;
          });
          
          // Replay to client
          tickerEvents.forEach(event => sendEvent(event));
        } else {
          // No events in database - send mock events
          console.log("⚠️ SSE: No events in database, sending mock events");
          for (let i = 0; i < 5; i++) {
            const mockEvent = generateMockEvent();
            updateCache(mockEvent);
            sendEvent(mockEvent);
          }
        }
      } else {
        console.error(`❌ SSE: Database query failed: ${resp.status}`);
        // Send mock events on error
        for (let i = 0; i < 5; i++) {
          const mockEvent = generateMockEvent();
          updateCache(mockEvent);
          sendEvent(mockEvent);
        }
      }
    }
  } catch (err) {
    console.error("❌ SSE: Error during initial replay:", err);
  }
  
  // Step 2: Set up polling for new events (every 2 seconds)
  let lastEventTime = new Date();
  
  const pollInterval = setInterval(async () => {
    try {
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_events?created_at=gt.${lastEventTime.toISOString()}&order=created_at.asc`,
        {
          headers: {
            "Content-Type": "application/json",
            apikey: svcKey,
            Authorization: `Bearer ${svcKey}`,
          },
        }
      );
      
      if (resp.ok) {
        const newEvents = await resp.json();
        if (newEvents.length > 0) {
          console.log(`📨 SSE: ${newEvents.length} new event(s) detected`);
          newEvents.forEach((dbEvent: any) => {
            const tickerEvent = transformEventToTicker(dbEvent);
            updateCache(tickerEvent);
            sendEvent(tickerEvent);
            lastEventTime = new Date(dbEvent.created_at);
          });
        }
      }
    } catch (err) {
      console.error("❌ SSE: Error polling for new events:", err);
    }
  }, 2000);
  
  // Step 3: Heartbeat every 15 seconds
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
  
  // Step 4: Handle client disconnect
  req.on("close", () => {
    console.log("👋 SSE client disconnected");
    clearInterval(pollInterval);
    clearInterval(heartbeatInterval);
    res.end();
  });
});

// Health endpoint for SSE feed
router.get("/api/v1/devhub/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "devhub-feed",
    cache_size: eventCache.length,
    timestamp: new Date().toISOString(),
  });
});
