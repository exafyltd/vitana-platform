import { Router, Request, Response } from "express";

export const router = Router();

interface OasisEventResponse {
  service: string;
  event: string;
  status: string;
  metadata?: {
    vtid?: string;
    [key: string]: any;
  };
  created_at: string;
}

router.get("/init", async (req: Request, res: Response) => {
  try {
    const agent = req.query.agent || 'unknown';
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    
    if (!supabaseUrl || !svcKey) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const eventsResp = await fetch(`${supabaseUrl}/rest/v1/OasisEvent?order=created_at.desc&limit=50`, {
      headers: {
        'apikey': svcKey,
        'Authorization': `Bearer ${svcKey}`
      }
    });
    
    const events = await eventsResp.json() as OasisEventResponse[];
    
    const vtids = [...new Set(events
      .map((e) => e.metadata?.vtid)
      .filter((v): v is string => !!v && v !== 'UNSET')
    )];

    const context = {
      timestamp: new Date().toISOString(),
      agent: agent,
      active_vtids: vtids.slice(0, 10),
      recent_events: events.slice(0, 20).map((e) => ({
        service: e.service,
        event: e.event,
        status: e.status,
        vtid: e.metadata?.vtid,
        created_at: e.created_at
      })),
      project_status: {
        command_hub: "operational",
        autologger: "operational",
        gateway: "operational"
      }
    };

    res.json(context);
  } catch (error: any) {
    console.error("Context init error:", error);
    res.status(500).json({ error: error.message });
  }
});
