import { Router, Request, Response } from 'express';
import { buildStageTimeline, defaultStageTimeline, type TimelineEvent, type StageTimelineEntry } from '../lib/stage-mapping';

export const oasisVtidLedgerRouter = Router();

/**
 * VTID-01020: VTID Ledger JSON Endpoint
 *
 * GET /api/v1/oasis/vtid-ledger
 *
 * Returns a list of VTIDs with full details including stageTimeline.
 * Always returns JSON, never HTML error pages.
 *
 * Query params:
 * - limit: number (default 50, max 200)
 * - status: optional filter (e.g., "pending", "in_progress", "completed")
 * - layer: optional filter (e.g., "DEV", "ADM", "OASIS")
 * - module: optional filter (e.g., "COMHU", "ABC")
 */

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !svcKey) {
    throw new Error("Supabase not configured");
  }
  return { supabaseUrl, svcKey };
}

oasisVtidLedgerRouter.get('/api/v1/oasis/vtid-ledger', async (req: Request, res: Response) => {
  try {
    // Parse and validate query params
    const limitParam = req.query.limit as string | undefined;
    const statusParam = req.query.status as string | undefined;
    const layerParam = req.query.layer as string | undefined;
    const moduleParam = req.query.module as string | undefined;

    // Parse limit (default 50, max 200)
    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        limit = Math.min(parsed, 200);
      }
    }

    let supabaseUrl: string;
    let svcKey: string;
    try {
      const config = getSupabaseConfig();
      supabaseUrl = config.supabaseUrl;
      svcKey = config.svcKey;
    } catch (e: any) {
      console.error('[VTID-01020] Supabase config error:', e.message);
      return res.status(500).json({
        ok: false,
        error: 'configuration_error',
        message: 'Gateway not properly configured'
      });
    }

    // Build query URL with filters
    let queryUrl = `${supabaseUrl}/rest/v1/vtid_ledger?order=created_at.desc&limit=${limit}`;

    // Add optional filters
    if (statusParam) {
      queryUrl += `&status=eq.${encodeURIComponent(statusParam)}`;
    }
    if (layerParam) {
      queryUrl += `&layer=eq.${encodeURIComponent(layerParam.toUpperCase())}`;
    }
    if (moduleParam) {
      queryUrl += `&module=eq.${encodeURIComponent(moduleParam.toUpperCase())}`;
    }

    console.log(`[VTID-01020] Fetching VTIDs: limit=${limit}, status=${statusParam || '*'}, layer=${layerParam || '*'}, module=${moduleParam || '*'}`);

    // Fetch VTIDs from ledger
    const vtidResp = await fetch(queryUrl, {
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      }
    });

    if (!vtidResp.ok) {
      const errText = await vtidResp.text();
      console.error(`[VTID-01020] Ledger query failed: ${vtidResp.status} - ${errText}`);
      return res.status(502).json({
        ok: false,
        error: 'database_query_failed',
        message: `Failed to query VTID ledger: HTTP ${vtidResp.status}`
      });
    }

    const vtidRows = await vtidResp.json() as any[];
    console.log(`[VTID-01020] Fetched ${vtidRows.length} VTIDs from ledger`);

    if (vtidRows.length === 0) {
      return res.status(200).json({
        ok: true,
        data: []
      });
    }

    // Collect all VTIDs for batch event fetch
    const vtidList = vtidRows.map((row: any) => row.vtid);

    // Fetch events for all VTIDs in one batch query
    // Using "in" operator for efficiency
    const vtidFilter = vtidList.map((v: string) => `"${v}"`).join(',');
    const eventsUrl = `${supabaseUrl}/rest/v1/oasis_events?vtid=in.(${vtidFilter})&select=id,created_at,vtid,kind:topic,status,title:message,task_stage,source,layer&order=created_at.asc&limit=1000`;

    let allEvents: TimelineEvent[] = [];
    try {
      const eventsResp = await fetch(eventsUrl, {
        headers: {
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`
        }
      });

      if (eventsResp.ok) {
        allEvents = await eventsResp.json() as TimelineEvent[];
        console.log(`[VTID-01020] Fetched ${allEvents.length} events for timeline building`);
      } else {
        console.warn(`[VTID-01020] Events query failed, proceeding without timelines: ${eventsResp.status}`);
      }
    } catch (err) {
      console.warn('[VTID-01020] Failed to fetch events:', err);
    }

    // Build response data with stageTimeline for each VTID
    const data = vtidRows.map((row: any) => {
      // Filter events for this VTID
      const vtidEvents = allEvents.filter((e: TimelineEvent) => e.vtid === row.vtid);

      // Build stage timeline
      let stageTimeline: StageTimelineEntry[];
      if (vtidEvents.length > 0) {
        stageTimeline = buildStageTimeline(vtidEvents);
      } else {
        stageTimeline = defaultStageTimeline();
      }

      // Return the same shape as /api/v1/vtid/:vtid
      return {
        vtid: row.vtid,
        layer: row.layer,
        module: row.module,
        status: row.status,
        title: row.title,
        description: row.summary ?? row.title,
        summary: row.summary,
        task_family: row.task_family || row.module,
        task_type: row.task_type || row.module,
        assigned_to: row.assigned_to ?? null,
        metadata: row.metadata ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        stageTimeline,
        _stageTimelineEventsFound: vtidEvents.length
      };
    });

    console.log(`[VTID-01020] Returning ${data.length} VTIDs with stage timelines`);

    return res.status(200).json({
      ok: true,
      data
    });

  } catch (e: any) {
    console.error('[VTID-01020] Unexpected error:', e);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: e.message
    });
  }
});

// OPTIONS for CORS preflight
oasisVtidLedgerRouter.options('/api/v1/oasis/vtid-ledger', (_req: Request, res: Response) => {
  res.status(200).end();
});
