import { Router, Request, Response } from 'express';
import cors from 'cors';

const router = Router();

/**
 * VTID-01005: Board Column Derivation (OASIS-based)
 * VTID-01058: Exclude deleted/voided tasks, treat 'completed' as terminal success
 * VTID-01079: Deterministic status→column mapping, one-row-per-VTID, DEV filter
 * VTID-01169: vtid_ledger.is_terminal is the PRIMARY AUTHORITY for terminal state
 *
 * Command Hub Reliability Rule (VTID-01169):
 * - If vtid_ledger.is_terminal = true → Completed/Failed determined by terminal_outcome
 * - Else → use active status (from ledger or events as fallback)
 * - No inference from events alone. Events are supporting evidence; ledger is authoritative.
 */
type BoardColumn = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED';
type IdNamespace = 'VTID' | 'DEV' | 'OTHER';

interface BoardItem {
  vtid: string;
  title: string;
  status: string;
  column: BoardColumn;
  is_terminal: boolean;
  terminal_outcome: 'success' | 'failed' | null;
  updated_at: string;
  id_namespace: IdNamespace;
}

/**
 * VTID-01079: Canonical status→column mapping (LOCKED)
 * VTID-01111: Added 'allocated' handling - shell entries excluded from board
 * This is the SINGLE source of truth for status-to-column conversion.
 * Hard invariants:
 *   - `completed` → `COMPLETED`
 *   - `in_progress` → `IN_PROGRESS`
 *   - `pending` → `SCHEDULED`
 *   - `scheduled` → `SCHEDULED`
 *   - `allocated` → `SCHEDULED` (VTID-01150: show allocated tasks so users can trigger execution)
 */
function mapStatusToColumn(status: string): BoardColumn | null {
  const s = (status || '').toLowerCase();
  // VTID-01150: 'allocated' tasks should appear in SCHEDULED column (not filtered out)
  // These are placeholder entries that need to be visible so users can trigger execution
  if (s === 'allocated') {
    return 'SCHEDULED';
  }
  if (s === 'completed' || s === 'done' || s === 'closed' || s === 'deployed' || s === 'merged' || s === 'complete' || s === 'failed' || s === 'error') {
    return 'COMPLETED';
  }
  if (s === 'in_progress' || s === 'running' || s === 'active' || s === 'todo' || s === 'validating' || s === 'blocked') {
    return 'IN_PROGRESS';
  }
  // pending, scheduled, or anything else → SCHEDULED
  return 'SCHEDULED';
}

/**
 * VTID-01079: Derive namespace from VTID prefix
 */
function deriveNamespace(vtid: string): IdNamespace {
  if (vtid.startsWith('VTID-')) return 'VTID';
  if (vtid.startsWith('DEV-')) return 'DEV';
  return 'OTHER';
}

const allowedOriginRegex = /^https:\/\/vitana-app-[a-z0-9-]+\.web\.app$/;
const corsOptions = {
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    const allowList = [
      'http://localhost:5173',
      'http://localhost:3000',
      'https://id-preview--vitana-v1.lovable.app'
    ];
    if (allowList.includes(origin) || allowedOriginRegex.test(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 86400
};

router.options('/', cors(corsOptions));

/**
 * VTID-01005: Board adapter endpoint - derives from OASIS events (single source of truth)
 * VTID-01058: Excludes deleted/voided tasks, treats 'completed' as terminal success
 * VTID-01079: Deterministic status→column mapping, one-row-per-VTID, DEV filter
 * Does NOT use commandhub_board_v1 view which reads from local ledger.
 *
 * Query params:
 *   - limit: max COMPLETED items to return (default 20, max 100). SCHEDULED/IN_PROGRESS are unlimited.
 *   - include_dev: include DEV-* items (default true for backward compatibility)
 */
router.get('/', cors(corsOptions), async (req: Request, res: Response) => {
  // VTID-01079: Limit only applies to COMPLETED column. SCHEDULED/IN_PROGRESS are always unlimited.
  const completedLimit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  // VTID-01079: Default true to avoid breaking existing UI
  const includeDev = req.query.include_dev !== 'false';

  try {
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!supaUrl || !supaKey) {
      return res.status(500).json({ error: 'Missing Supabase configuration' });
    }

    console.log(`[VTID-01079] Board adapter request, completedLimit=${completedLimit}, include_dev=${includeDev}`);

    // VTID-01058: Step 1: Fetch ALL VTIDs from ledger (no limit - we filter by column later)
    // Note: PostgREST not.in filter is unreliable, so we fetch all and filter in post-fetch
    const vtidResp = await fetch(
      `${supaUrl}/rest/v1/vtid_ledger?order=updated_at.desc&limit=1000`,
      { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
    );

    if (!vtidResp.ok) {
      const errText = await vtidResp.text();
      console.error(`[VTID-01005] Ledger query failed: ${vtidResp.status} - ${errText}`);
      return res.status(500).json({ error: 'Database query failed', details: errText });
    }

    const vtidRowsRaw = await vtidResp.json() as any[];

    // VTID-01058: DEBUG - log raw data for investigation
    const debugVtids = ['VTID-01059', 'VTID-01060', 'VTID-01061'];
    vtidRowsRaw.forEach((row: any) => {
      if (debugVtids.includes(row.vtid)) {
        console.log(`[VTID-01058-DEBUG] Raw row ${row.vtid}: status="${row.status}", deleted_at=${row.deleted_at}, voided_at=${row.voided_at}`);
      }
    });

    // VTID-01058: Post-fetch filter: exclude rows with deleted/voided/cancelled status or metadata flags
    const vtidRows = vtidRowsRaw.filter((row: any) => {
      const status = (row.status || '').toLowerCase();
      const isDeleted = status === 'deleted' || status === 'voided' || status === 'cancelled';
      const hasDeletedAt = !!row.deleted_at;
      const hasVoidedAt = !!row.voided_at;
      const meta = row.metadata || {};
      const metaDeleted = meta.deleted === true || meta.voided === true || meta.cancelled === true;

      if (isDeleted || hasDeletedAt || hasVoidedAt || metaDeleted) {
        console.log(`[VTID-01058] Filtering out ${row.vtid}: status=${status}, deleted_at=${row.deleted_at}, voided_at=${row.voided_at}`);
        return false;
      }
      return true;
    });

    console.log(`[VTID-01058] Fetched ${vtidRowsRaw.length} rows, filtered to ${vtidRows.length} after removing deleted/voided`);

    if (vtidRows.length === 0) {
      return res.json([]);
    }

    // VTID-01079: No limit here - we process all rows and limit COMPLETED at the end
    const allRows = vtidRows;

    // VTID-01079: Extract VTIDs we need events for
    const vtidList = allRows.map((row: any) => row.vtid).filter(Boolean);

    // Step 2: Fetch OASIS events ONLY for the VTIDs we're displaying
    // CRITICAL FIX: Previously we fetched limit=500 globally, which caused old events
    // to fall off when new events were created. Now we query specifically for our VTIDs.
    let allEvents: any[] = [];
    if (vtidList.length > 0) {
      // PostgREST IN filter: vtid=in.(VTID-01020,VTID-01021,...)
      const vtidFilter = `vtid=in.(${vtidList.join(',')})`;
      const eventsResp = await fetch(
        `${supaUrl}/rest/v1/oasis_events?${vtidFilter}&order=created_at.desc`,
        { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
      );
      if (eventsResp.ok) {
        allEvents = await eventsResp.json() as any[];
        console.log(`[VTID-01079] Fetched ${allEvents.length} OASIS events for ${vtidList.length} VTIDs`);
      }
    }

    // Step 3: Build board items with OASIS-derived column placement
    // VTID-01111: Debug list to track problematic VTIDs
    const debugVtidList = ['VTID-01007', 'VTID-01008', 'VTID-01009', 'VTID-01010', 'VTID-01011', 'VTID-0516'];

    const boardItems: BoardItem[] = allRows.map((row: any) => {
      const vtid = row.vtid;
      const vtidEvents = allEvents.filter((e: any) => e.vtid === vtid);

      // VTID-01111: Debug logging for problematic VTIDs
      if (debugVtidList.includes(vtid)) {
        const topics = vtidEvents.map((e: any) => e.topic).join(', ');
        console.log(`[VTID-01111-DEBUG] ${vtid}: ${vtidEvents.length} events, topics=[${topics}], ledger_status=${row.status}, is_terminal=${row.is_terminal}, terminal_outcome=${row.terminal_outcome}`);
      }

      let isTerminal = false;
      let terminalOutcome: 'success' | 'failed' | null = null;
      let column: BoardColumn = 'SCHEDULED';
      let derivedStatus = 'scheduled';

      // ==========================================================================
      // VTID-01169: vtid_ledger.is_terminal is the PRIMARY AUTHORITY
      // Command Hub Reliability Rule:
      // - If vtid_ledger.is_terminal = true → Completed/Failed determined by terminal_outcome
      // - Else → use active status (from ledger or events as fallback)
      // - No inference from events alone. Events are supporting evidence; ledger is authoritative.
      // ==========================================================================
      if (row.is_terminal === true) {
        isTerminal = true;
        if (row.terminal_outcome === 'success') {
          terminalOutcome = 'success';
          column = 'COMPLETED';
          derivedStatus = 'completed';
        } else if (row.terminal_outcome === 'failed') {
          terminalOutcome = 'failed';
          column = 'COMPLETED';
          derivedStatus = 'failed';
        } else if (row.terminal_outcome === 'cancelled') {
          terminalOutcome = 'failed'; // Treat cancelled as failed for column placement
          column = 'COMPLETED';
          derivedStatus = 'cancelled';
        } else {
          // is_terminal=true but no outcome - default to success
          terminalOutcome = 'success';
          column = 'COMPLETED';
          derivedStatus = 'completed';
        }
      }

      // ==========================================================================
      // FALLBACK: If ledger doesn't have is_terminal=true, check events and status
      // This handles legacy VTIDs and provides backward compatibility
      // ==========================================================================
      if (!isTerminal) {
        // Check for terminal lifecycle events (secondary authority)
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
      }

      // VTID-01009: Check for lifecycle.started event → IN_PROGRESS
      // This is authoritative: if OASIS has a started event and no terminal event,
      // the task is IN_PROGRESS regardless of ledger status or local overrides
      if (!isTerminal) {
        const lifecycleStartedEvent = vtidEvents.find((e: any) =>
          (e.topic || '').toLowerCase() === 'vtid.lifecycle.started'
        );
        if (lifecycleStartedEvent) {
          column = 'IN_PROGRESS';
          derivedStatus = 'in_progress';
        }
      }

      // VTID-01111: If not terminal from lifecycle events, check other OASIS patterns
      // Check deploy events BEFORE checking lifecycle.started so deploy success
      // takes priority over started status
      if (!isTerminal) {
        const hasDeploySuccess = vtidEvents.some((e: any) => {
          const topic = (e.topic || '').toLowerCase();
          // VTID-01111: Added 'deploy.success' which is emitted by CI/CD telemetry action
          return topic === 'deploy.gateway.success' ||
                 topic === 'deploy.success' ||
                 topic === 'cicd.deploy.service.succeeded' ||
                 topic === 'cicd.github.safe_merge.executed' ||
                 topic === 'cicd.merge.success';
        });

        const hasDeployFailed = vtidEvents.some((e: any) => {
          const topic = (e.topic || '').toLowerCase();
          // VTID-01111: Added 'deploy.failed' which is emitted by CI/CD telemetry action
          return topic === 'deploy.gateway.failed' ||
                 topic === 'deploy.failed' ||
                 topic === 'cicd.deploy.service.failed' ||
                 topic === 'cicd.merge.failed';
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

        // VTID-01058: Added 'completed' to terminal success statuses
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
          derivedStatus = ledgerStatus;
        } else {
          column = 'SCHEDULED';
          derivedStatus = ledgerStatus || 'scheduled';
        }
      }

      // VTID-01079: Use canonical mapping function for deterministic column placement
      // The derivedStatus may come from OASIS events, but column MUST use mapStatusToColumn
      const finalColumn = mapStatusToColumn(derivedStatus);

      // VTID-01111: Debug logging for final decision
      if (debugVtidList.includes(vtid)) {
        console.log(`[VTID-01111-DEBUG] ${vtid}: FINAL → column=${finalColumn}, derivedStatus=${derivedStatus}, isTerminal=${isTerminal}`);
      }

      // VTID-01111: If mapStatusToColumn returns null, this is a shell entry to exclude
      if (finalColumn === null) {
        return null;
      }

      return {
        vtid,
        title: row.title || '',
        status: derivedStatus,
        column: finalColumn,
        is_terminal: isTerminal,
        terminal_outcome: terminalOutcome,
        updated_at: row.updated_at || row.created_at,
        id_namespace: deriveNamespace(vtid),
      };
    }).filter((item): item is BoardItem => item !== null);  // VTID-01111: Filter out null entries

    // VTID-01079: Deduplicate - keep only one row per VTID (latest updated_at)
    const vtidMap = new Map<string, BoardItem>();
    for (const item of boardItems) {
      const existing = vtidMap.get(item.vtid);
      if (!existing || new Date(item.updated_at) > new Date(existing.updated_at)) {
        vtidMap.set(item.vtid, item);
      }
    }
    let dedupedItems = Array.from(vtidMap.values());

    // VTID-01079: Apply DEV filter if include_dev=false
    if (!includeDev) {
      dedupedItems = dedupedItems.filter(item => item.id_namespace !== 'DEV');
    }

    // Sort by updated_at descending (maintain original order)
    dedupedItems.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    // VTID-01079: Separate by column - SCHEDULED/IN_PROGRESS unlimited, COMPLETED limited
    const scheduledItems = dedupedItems.filter(item => item.column === 'SCHEDULED');
    const inProgressItems = dedupedItems.filter(item => item.column === 'IN_PROGRESS');
    const completedItems = dedupedItems.filter(item => item.column === 'COMPLETED');

    // Apply limit only to COMPLETED items
    const limitedCompletedItems = completedItems.slice(0, completedLimit);
    const totalCompleted = completedItems.length;
    const hasMoreCompleted = totalCompleted > completedLimit;

    // Combine: all SCHEDULED + all IN_PROGRESS + limited COMPLETED
    const finalItems = [...scheduledItems, ...inProgressItems, ...limitedCompletedItems];

    console.log(`[VTID-01079] Board: scheduled=${scheduledItems.length}, in_progress=${inProgressItems.length}, completed=${limitedCompletedItems.length}/${totalCompleted}, include_dev=${includeDev}`);

    // Return with metadata about completed pagination
    res.json({
      items: finalItems,
      meta: {
        scheduled_count: scheduledItems.length,
        in_progress_count: inProgressItems.length,
        completed_count: limitedCompletedItems.length,
        completed_total: totalCompleted,
        has_more_completed: hasMoreCompleted
      }
    });
  } catch (err) {
    console.error('[VTID-01079] Board adapter error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

export default router;
