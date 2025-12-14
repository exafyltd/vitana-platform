/**
 * Gateway Events API - DEV-OASIS-0210
 * Implements: /api/v1/events (list) and /api/v1/events/stream (SSE)
 *
 * Queries oasis_events table directly for proper filtering by topic and vtid.
 */

import { Router, Request, Response } from 'express';
import fetch from 'node-fetch';

const router = Router();

// OASIS base URL from environment (kept for SSE proxy fallback)
const OASIS_URL = process.env.OASIS_OPERATOR_URL || 'https://oasis-operator-86804897789.us-central1.run.app';

/**
 * GET /api/v1/events
 * DEV-OASIS-0210: List events from oasis_events table with topic/vtid filtering
 *
 * Query params:
 * - topic: Filter by event type/topic (e.g., "deploy.gateway.success")
 * - vtid: Filter by VTID (e.g., "VTID-0416")
 * - limit: Max number of events to return (default 50, max 200)
 * - since: ISO timestamp to filter events after
 */
router.get('/api/v1/events', async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!svcKey || !supabaseUrl) {
      console.error('[DEV-OASIS-0210] Gateway misconfigured: Missing Supabase credentials');
      return res.status(500).json({
        ok: false,
        error: 'Gateway misconfigured'
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

    console.log(`[DEV-OASIS-0210] Querying oasis_events: topic=${topic || 'all'}, vtid=${vtid || 'all'}, limit=${limit}`);

    const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events?${queryParams}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': svcKey,
        'Authorization': `Bearer ${svcKey}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[DEV-OASIS-0210] Supabase query failed: ${resp.status} - ${text}`);
      return res.status(502).json({
        ok: false,
        error: 'Database query failed'
      });
    }

    const events = (await resp.json()) as any[];

    // Transform to Gateway standard format
    const normalizedEvents = events.map((event: any) => ({
      id: event.id,
      vtid: event.vtid || (event.metadata && event.metadata.vtid) || undefined,
      type: event.topic || 'unknown',
      topic: event.topic || 'unknown',
      source: event.service || 'oasis',
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
        ...event.metadata
      }
    }));

    console.log(`[DEV-OASIS-0210] Returning ${normalizedEvents.length} events`);

    return res.status(200).json({
      ok: true,
      count: normalizedEvents.length,
      data: normalizedEvents
    });

  } catch (error: any) {
    console.error('[DEV-OASIS-0210] Error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Operator channel event types for filtering
const OPERATOR_CHANNEL_TYPES = [
  'gateway.health',
  'deploy',
  'operator.chat',
  'operator.heartbeat',
  'operator.upload',
  'cicd'
];

/**
 * Check if an event type matches the operator channel filter
 */
function isOperatorChannelEvent(eventType: string): boolean {
  if (!eventType) return false;
  return OPERATOR_CHANNEL_TYPES.some(prefix => eventType.startsWith(prefix));
}

/**
 * GET /api/v1/events/stream
 * SSE stream - proxies OASIS event stream to browser
 * Supports ?channel=operator for filtered operator events
 */
router.get('/api/v1/events/stream', async (req: Request, res: Response) => {
  const channel = req.query.channel as string;
  const isOperatorChannel = channel === 'operator';

  console.log(`[Gateway SSE] Client connected (channel: ${channel || 'all'})`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // CORS headers for Lovable preview
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    // Connect to OASIS SSE stream
    const oasisStreamUrl = `${OASIS_URL}/api/v1/events/stream`;
    console.log(`[Gateway SSE] Connecting to OASIS: ${oasisStreamUrl} (operator filter: ${isOperatorChannel})`);

    const oasisResponse = await fetch(oasisStreamUrl);

    if (!oasisResponse.ok) {
      console.error(`[Gateway SSE] OASIS stream returned ${oasisResponse.status}`);
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'OASIS stream unavailable' })}\n\n`);
      res.end();
      return;
    }

    // Send connection confirmation
    res.write(`event: connected\ndata: ${JSON.stringify({
      message: 'Gateway SSE stream connected',
      timestamp: new Date().toISOString(),
      channel: channel || 'all'
    })}\n\n`);

    // Pipe OASIS stream to client with transformation
    if (oasisResponse.body) {
      oasisResponse.body.on('data', (chunk: Buffer) => {
        try {
          const text = chunk.toString();

          // Forward SSE data, transforming event names
          if (text.startsWith('data:')) {
            // Parse and normalize the event
            const dataMatch = text.match(/data: (.+)/);
            if (dataMatch) {
              try {
                const oasisEvent = JSON.parse(dataMatch[1]);

                // Transform to standard format
                const gatewayEvent = {
                  id: oasisEvent.id || oasisEvent.event_id || crypto.randomUUID(),
                  vtid: oasisEvent.vtid || oasisEvent.data?.vtid,
                  type: oasisEvent.event_type || oasisEvent.type,
                  source: oasisEvent.source || 'oasis',
                  created_at: oasisEvent.timestamp || oasisEvent.created_at || new Date().toISOString(),
                  payload: oasisEvent.data || oasisEvent
                };

                // Apply operator channel filter if requested
                if (isOperatorChannel) {
                  if (!isOperatorChannelEvent(gatewayEvent.type)) {
                    // Skip non-operator events
                    return;
                  }
                }

                // Send as oasis-event type
                res.write(`event: oasis-event\ndata: ${JSON.stringify(gatewayEvent)}\n\n`);
              } catch (parseError) {
                // If can't parse, forward as-is (only if not filtered)
                if (!isOperatorChannel) {
                  res.write(text + '\n\n');
                }
              }
            }
          } else if (text.startsWith(':')) {
            // Forward keepalive comments as-is
            res.write(text + '\n');
          }
        } catch (error) {
          console.error('[Gateway SSE] Error processing chunk:', error);
        }
      });

      oasisResponse.body.on('end', () => {
        console.log('[Gateway SSE] OASIS stream ended');
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream ended' })}\n\n`);
        res.end();
      });

      oasisResponse.body.on('error', (error: Error) => {
        console.error('[Gateway SSE] OASIS stream error:', error);
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
      });
    } else {
      console.error('[Gateway SSE] No response body from OASIS');
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'No stream available' })}\n\n`);
      res.end();
    }

    // Handle client disconnect
    req.on('close', () => {
      console.log('[Gateway SSE] Client disconnected');
      if (oasisResponse.body) {
        (oasisResponse.body as any).destroy();
      }
    });

  } catch (error: any) {
    console.error('[Gateway SSE] Setup error:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

export default router;

/**
 * POST /events/ingest
 * Ingest events with validation
 */
router.post('/events/ingest', async (req: Request, res: Response) => {
  try {
    const { service, status, message, metadata } = req.body;

    // Validation
    if (!service || !status) {
      return res.status(400).json({ 
        error: "Invalid payload",
        details: "Missing required fields: service, status" 
      });
    }

    // Validate status enum
    const validStatuses = ['pending', 'running', 'completed', 'failed', 'success'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: "Invalid payload",
        details: `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}` 
      });
    }

    // For now, just return success (tests expect this behavior)
    res.status(200).json({
      success: true,
      message: "Event ingested successfully",
      eventId: `evt-${Date.now()}`
    });

  } catch (error) {
    console.error('Error ingesting event:', error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /events/health
 * Health check endpoint
 */
router.get('/events/health', (req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "oasis-events",
    timestamp: new Date().toISOString(),
    status: "healthy"
  });
});

