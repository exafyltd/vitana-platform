/**
 * Events Routes
 * Handles OASIS event ingestion, retrieval, and streaming
 * 
 * Recent Updates:
 * - DEV-AICOR-EVENT-VTID-SYNC: Added event webhook for VTID sync
 * - DEV-COMMU-GCHAT-NOTIFY: Added GChat notifications
 */

import { Router, Request, Response } from 'express';
import { VtidSyncService } from '../services/vtidSync';
import { GChatNotifierService } from '../services/gchatNotifier';

const router = Router();

// Initialize services
let vtidSync: VtidSyncService | null = null;
let gchatNotifier: GChatNotifierService | null = null;

function getVtidSync(): VtidSyncService {
  if (!vtidSync) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not configured');
    }
    
    vtidSync = new VtidSyncService(supabaseUrl, supabaseKey);
  }
  return vtidSync;
}

function getGChatNotifier(): GChatNotifierService | null {
  if (!gchatNotifier) {
    const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
    
    if (!webhookUrl) {
      console.warn('⚠️ Google Chat webhook URL not configured');
      return null;
    }
    
    gchatNotifier = new GChatNotifierService(webhookUrl);
  }
  return gchatNotifier;
}

/**
 * Health check
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'oasis-events',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Ingest new event (with VTID sync and GChat notifications)
 * POST /api/v1/events/ingest
 */
router.post('/ingest', async (req: Request, res: Response) => {
  try {
    const event = req.body;

    // Validate required fields
    if (!event.topic || !event.service || !event.status || !event.message) {
      return res.status(400).json({
        error: 'Missing required fields: topic, service, status, message',
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        error: 'Gateway misconfigured',
      });
    }

    // Insert event into oasis_events
    const eventPayload = {
      vtid: event.vtid || null,
      topic: event.topic,
      service: event.service,
      role: event.role || 'SYSTEM',
      model: event.model || null,
      status: event.status,
      message: event.message,
      link: event.link || null,
      metadata: event.metadata || {},
    };

    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(eventPayload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Failed to insert event: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: 'Failed to insert event',
        detail: text,
      });
    }

    const data = await resp.json() as any[];

    // Trigger VTID sync if event has VTID
    if (event.vtid) {
      try {
        const sync = getVtidSync();
        await sync.processEvent(event);
      } catch (syncError: any) {
        console.error('⚠️ VTID sync failed:', syncError.message);
        // Don't fail the request if sync fails
      }
    }

    // Send GChat notification for important events
    try {
      const notifier = getGChatNotifier();
      if (notifier) {
        await notifier.processEvent(event);
      }
    } catch (notifyError: any) {
      console.error('⚠️ GChat notification failed:', notifyError.message);
      // Don't fail the request if notification fails
    }

    console.log(`✅ Event ingested: ${event.topic} [${event.service}]`);

    return res.status(200).json({
      ok: true,
      data: data[0],
    });
  } catch (error: any) {
    console.error('❌ Event ingest error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error.message,
    });
  }
});

/**
 * List events with filtering
 * GET /api/v1/events?limit=50&service=gateway&topic=task.completed
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const service = req.query.service as string;
    const topic = req.query.topic as string;
    const status = req.query.status as string;
    const vtid = req.query.vtid as string;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        error: 'Gateway misconfigured',
      });
    }

    // Build query filters
    const filters: string[] = [];
    if (service) filters.push(`service=eq.${encodeURIComponent(service)}`);
    if (topic) filters.push(`topic=eq.${encodeURIComponent(topic)}`);
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
    if (vtid) filters.push(`vtid=eq.${encodeURIComponent(vtid)}`);

    const filterStr = filters.length > 0 ? '&' + filters.join('&') : '';
    const url = `${supabaseUrl}/rest/v1/oasis_events?order=created_at.desc&limit=${limit}&offset=${offset}${filterStr}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`❌ Failed to fetch events: ${resp.status} - ${text}`);
      return res.status(502).json({
        error: 'Failed to fetch events',
        detail: text,
      });
    }

    const data = await resp.json() as any[];

    return res.status(200).json({
      ok: true,
      count: data.length,
      data,
    });
  } catch (error: any) {
    console.error('❌ Event fetch error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error.message,
    });
  }
});

/**
 * SSE stream endpoint (for Task 3 - Live Refresh)
 * GET /api/v1/events/stream
 */
router.get('/stream', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Gateway misconfigured' })}\n\n`);
    res.end();
    return;
  }

  let lastEventId: string | null = null;

  // Poll for new events every 2 seconds
  const pollInterval = setInterval(async () => {
    try {
      const filterStr = lastEventId ? `&id=gt.${lastEventId}` : '';
      const url = `${supabaseUrl}/rest/v1/oasis_events?order=created_at.asc&limit=10${filterStr}`;

      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      });

      if (resp.ok) {
        const events = await resp.json() as any[];
        
        for (const event of events) {
          res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
          lastEventId = event.id;
        }
      }
    } catch (error: any) {
      console.error('❌ SSE poll error:', error.message);
    }
  }, 2000);

  // Heartbeat every 15 seconds
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);
  }, 15000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(pollInterval);
    clearInterval(heartbeat);
  });
});

export default router;
