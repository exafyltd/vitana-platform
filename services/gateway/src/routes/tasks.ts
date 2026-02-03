import { Router, Request, Response } from 'express';
import { buildStageTimeline, defaultStageTimeline, mapRawToStage, type TimelineEvent, type StageTimelineEntry } from '../lib/stage-mapping';

export const router = Router();

/**
 * GET /api/v1/tasks
 *
 * VTID-01005: Enhanced task adapter that derives terminal state from OASIS events.
 * OASIS is the SINGLE SOURCE OF TRUTH for task completion.
 *
 * Adapter endpoint that reads from vtid_ledger and transforms rows
 * into task objects compatible with Command Hub Task Board UI.
 *
 * Database columns (vtid_ledger):
 * - vtid, layer, module, status, title, summary, created_at, updated_at
 *
 * VTID-01005 ENHANCEMENTS:
 * - is_terminal: derived from OASIS events (authoritative)
 * - terminal_outcome: 'success' | 'failed' | null
 * - column: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED'
 *
 * TEMPORARY COMPATIBILITY FIELDS:
 * - task_family: mirrors module (for existing UI code)
 * - task_type: mirrors module (for existing UI code)
 * - description: uses summary if available, otherwise title
 */
router.get('/api/v1/tasks', async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: "Misconfigured" });

    const limit = req.query.limit || '100';
    const layer = req.query.layer as string;
    const status = req.query.status as string;

    let url = `${supabaseUrl}/rest/v1/vtid_ledger?order=updated_at.desc&limit=${limit}&status=neq.deleted`;
    if (layer) url += `&layer=eq.${layer}`;
    if (status) url += `&status=eq.${status}`;

    const resp = await fetch(url, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: "Query failed" });

    const data = await resp.json() as any[];

    // VTID-01005: Fetch OASIS events for terminal state derivation
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?order=created_at.desc&limit=500`,
      { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
    );

    let allEvents: any[] = [];
    if (eventsResp.ok) {
      allEvents = await eventsResp.json() as any[];
    }

    // Transform database rows into task objects with OASIS-derived terminal states
    const tasks = data.map(row => {
      const vtid = row.vtid;
      const vtidEvents = allEvents.filter((e: any) => e.vtid === vtid);

      // VTID-01005: Derive terminal state from OASIS events (AUTHORITATIVE)
      let isTerminal = false;
      let terminalOutcome: 'success' | 'failed' | null = null;
      let column: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' = 'SCHEDULED';
      let derivedStatus = row.status || 'scheduled';

      // Check for terminal lifecycle events FIRST (highest authority)
      const terminalCompletedEvent = vtidEvents.find((e: any) =>
        (e.topic || '').toLowerCase() === 'vtid.lifecycle.completed'
      );
      const terminalFailedEvent = vtidEvents.find((e: any) =>
        (e.topic || '').toLowerCase() === 'vtid.lifecycle.failed'
      );

      if (terminalCompletedEvent) {
        isTerminal = true;
        terminalOutcome = 'success';
        column = 'COMPLETED';
        derivedStatus = 'completed';
      } else if (terminalFailedEvent) {
        isTerminal = true;
        terminalOutcome = 'failed';
        column = 'COMPLETED';
        derivedStatus = 'failed';
      }

      // If not terminal from lifecycle events, check other OASIS patterns
      if (!isTerminal) {
        const hasDeploySuccess = vtidEvents.some((e: any) => {
          const topic = (e.topic || '').toLowerCase();
          return topic === 'deploy.gateway.success' ||
                 topic === 'cicd.deploy.service.succeeded' ||
                 topic === 'cicd.github.safe_merge.executed';
        });

        const hasDeployFailed = vtidEvents.some((e: any) => {
          const topic = (e.topic || '').toLowerCase();
          return topic === 'deploy.gateway.failed' ||
                 topic === 'cicd.deploy.service.failed';
        });

        if (hasDeploySuccess) {
          isTerminal = true;
          terminalOutcome = 'success';
          column = 'COMPLETED';
          derivedStatus = 'completed';
        } else if (hasDeployFailed) {
          isTerminal = true;
          terminalOutcome = 'failed';
          column = 'COMPLETED';
          derivedStatus = 'failed';
        }
      }

      // If still not terminal, check ledger status as fallback
      if (!isTerminal) {
        const ledgerStatus = (row.status || '').toLowerCase();

        if (['done', 'closed', 'deployed', 'merged', 'complete', 'completed'].includes(ledgerStatus)) {
          isTerminal = true;
          terminalOutcome = 'success';
          column = 'COMPLETED';
          derivedStatus = 'completed';
        } else if (['failed', 'error'].includes(ledgerStatus)) {
          isTerminal = true;
          terminalOutcome = 'failed';
          column = 'COMPLETED';
          derivedStatus = 'failed';
        } else if (['in_progress', 'running', 'active', 'todo', 'validating', 'blocked'].includes(ledgerStatus)) {
          column = 'IN_PROGRESS';
        } else {
          column = 'SCHEDULED';
        }
      }

      return {
        // Core fields from vtid_ledger
        vtid: row.vtid,
        layer: row.layer,
        module: row.module,
        status: derivedStatus, // VTID-01005: Use OASIS-derived status

        // Primary display fields
        title: row.title,
        description: row.summary ?? row.title,
        summary: row.summary,

        // TEMPORARY compatibility fields for existing Task Board UI
        task_family: row.module,
        task_type: row.module,

        // VTID-01005: Terminal state fields (OASIS-derived)
        is_terminal: isTerminal,
        terminal_outcome: terminalOutcome,
        column: column,

        // Metadata
        assigned_to: row.assigned_to ?? null,
        metadata: row.metadata ?? null,

        // Timestamps
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    return res.json({
      data: tasks,
      meta: {
        count: tasks.length,
        limit: parseInt(limit as string),
        has_more: false
      }
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/vtid/:vtid
 *
 * VTID-0527: Returns detail for a specific VTID with stageTimeline.
 * Includes stage timeline built from telemetry events.
 */
router.get('/api/v1/vtid/:vtid', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: "Misconfigured" });

    // Fetch VTID from ledger
    const vtidResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!vtidResp.ok) return res.status(502).json({ error: "Query failed" });
    const vtidData = await vtidResp.json() as any[];
    if (vtidData.length === 0) return res.status(404).json({ error: "VTID not found", vtid });

    const row = vtidData[0];

    // VTID-0527-B: Fetch telemetry events for this VTID to build stage timeline
    // ALWAYS return 4 entries (PLANNER, WORKER, VALIDATOR, DEPLOY), never null or empty
    let stageTimeline: StageTimelineEntry[] = defaultStageTimeline();
    let eventsFound = 0;

    try {
      console.log(`[VTID-0527-B] Fetching events for VTID: ${vtid}`);
      const eventsResp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${vtid}&select=id,created_at,vtid,kind,status,title,task_stage,source,layer&order=created_at.asc&limit=100`,
        {
          headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
        }
      );

      if (eventsResp.ok) {
        const events = await eventsResp.json() as TimelineEvent[];
        eventsFound = events.length;
        console.log(`[VTID-0527-B] Found ${eventsFound} events for ${vtid}`);

        if (events.length > 0) {
          // Build timeline from actual events
          stageTimeline = buildStageTimeline(events);
          console.log(`[VTID-0527-B] Built stage timeline for ${vtid}:`, stageTimeline.map(s => `${s.stage}:${s.status}`).join(', '));
        } else {
          // No events found - keep default (all PENDING)
          console.log(`[VTID-0527-B] No events found for ${vtid}, using default timeline (all PENDING)`);
        }
      } else {
        const errText = await eventsResp.text();
        console.warn(`[VTID-0527-B] Events query failed for ${vtid}: ${eventsResp.status} - ${errText}`);
        // Keep default timeline
      }
    } catch (err) {
      console.warn(`[VTID-0527-B] Failed to fetch events for ${vtid}:`, err);
      // Keep default timeline - not a critical failure
    }

    // Ensure stageTimeline always has 4 entries
    if (!stageTimeline || stageTimeline.length !== 4) {
      console.warn(`[VTID-0527-B] Invalid stageTimeline, using default`);
      stageTimeline = defaultStageTimeline();
    }

    return res.json({
      ok: true,
      data: {
        // Core fields
        vtid: row.vtid,
        layer: row.layer,
        module: row.module,
        status: row.status,

        // Primary display fields
        title: row.title,
        description: row.summary ?? row.title,
        summary: row.summary,

        // TEMPORARY compatibility fields
        task_family: row.module,  // TEMP: mirror module
        task_type: row.module,    // TEMP: mirror module

        // Metadata
        assigned_to: row.assigned_to ?? null,
        metadata: row.metadata ?? null,

        // Timestamps
        created_at: row.created_at,
        updated_at: row.updated_at,

        // VTID-0527-B: Stage timeline (always 4 entries, never null)
        stageTimeline: stageTimeline,
        _stageTimelineEventsFound: eventsFound, // Debug: number of events found for this VTID
      }
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/vtid/:vtid/execution-status
 *
 * VTID-01209: Real-time execution status for pipeline tracking.
 * Returns current step, total steps, stage, and recent events for live monitoring.
 *
 * Response:
 * - vtid: The task identifier
 * - status: Current task status (scheduled, in_progress, completed, failed)
 * - isActive: true if task is currently executing
 * - totalSteps: Total number of events/steps recorded
 * - currentStep: Current step number (1-indexed)
 * - currentStepName: Description of current step (from latest event)
 * - currentStage: Current macro stage (PLANNER, WORKER, VALIDATOR, DEPLOY)
 * - stageTimeline: 4-stage status array
 * - startedAt: Execution start timestamp
 * - elapsedMs: Milliseconds since execution started
 * - recentEvents: Last 5 events (newest first)
 */
router.get('/api/v1/vtid/:vtid/execution-status', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: "Misconfigured" });

    // Fetch VTID from ledger to get status
    const vtidResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}&select=vtid,status,title,updated_at`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!vtidResp.ok) return res.status(502).json({ error: "Query failed" });
    const vtidData = await vtidResp.json() as any[];
    if (vtidData.length === 0) return res.status(404).json({ error: "VTID not found", vtid });

    const row = vtidData[0];
    const taskStatus = (row.status || '').toLowerCase();

    // Determine if task is actively executing
    const activeStatuses = ['in_progress', 'running', 'active', 'allocated', 'validating'];
    const isActive = activeStatuses.includes(taskStatus);

    // VTID-01227: Add LIMIT to prevent disk IO exhaustion on busy VTIDs
    const eventsResp = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${vtid}&select=id,created_at,vtid,kind,status,title,task_stage,source,layer,message&order=created_at.asc&limit=500`,
      {
        headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
      }
    );

    if (!eventsResp.ok) {
      return res.status(502).json({ error: "Events query failed" });
    }

    const events = await eventsResp.json() as (TimelineEvent & { message?: string })[];
    const totalSteps = events.length;

    // Build stage timeline
    const stageTimeline = totalSteps > 0 ? buildStageTimeline(events) : defaultStageTimeline();

    // Find current stage (latest non-PENDING stage, or first RUNNING)
    let currentStage: string = 'PLANNER';
    for (const entry of stageTimeline) {
      if (entry.status === 'RUNNING') {
        currentStage = entry.stage;
        break;
      }
      if (entry.status === 'SUCCESS' || entry.status === 'ERROR') {
        currentStage = entry.stage;
      }
    }

    // Get latest event for current step info
    const latestEvent = events.length > 0 ? events[events.length - 1] : null;
    const currentStep = totalSteps;
    const currentStepName = latestEvent
      ? (latestEvent.title || latestEvent.kind || latestEvent.message || 'Processing...')
      : 'Waiting to start...';

    // Calculate execution timing
    const firstEvent = events.length > 0 ? events[0] : null;
    const startedAt = firstEvent?.created_at || null;
    const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;

    // Get recent events (last 5, newest first)
    const recentEvents = events.slice(-5).reverse().map(e => ({
      id: e.id,
      timestamp: e.created_at,
      stage: e.task_stage || mapRawToStage(e.kind, e.title, e.status) || 'UNKNOWN',
      name: e.title || e.kind || e.message || 'Event',
      status: e.status || 'info'
    }));

    return res.json({
      ok: true,
      data: {
        vtid,
        title: row.title,
        status: taskStatus,
        isActive,

        // Step tracking
        totalSteps,
        currentStep,
        currentStepName,
        currentStage,

        // Timeline
        stageTimeline,

        // Timing
        startedAt,
        elapsedMs,
        lastUpdated: latestEvent?.created_at || row.updated_at,

        // Recent activity
        recentEvents
      }
    });
  } catch (e: any) {
    console.error('[VTID-01209] Execution status error:', e);
    return res.status(500).json({ error: e.message });
  }
});
