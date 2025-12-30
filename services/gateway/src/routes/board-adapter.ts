import { Router, Request, Response } from 'express';
import cors from 'cors';

const router = Router();

/**
 * VTID-01005: Board Column Derivation (OASIS-based)
 * VTID-01058: Exclude deleted/voided tasks, treat 'completed' as terminal success
 * VTID-01079: Deterministic status→column mapping, one-row-per-VTID, DEV filter
 *
 * OASIS is the SINGLE SOURCE OF TRUTH for task completion.
 * Column placement is derived from OASIS events, NOT local ledger status.
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
 * This is the SINGLE source of truth for status-to-column conversion.
 * Hard invariants:
 *   - `completed` → `COMPLETED`
 *   - `in_progress` → `IN_PROGRESS`
 *   - `pending` → `SCHEDULED`
 *   - `scheduled` → `SCHEDULED`
 */
function mapStatusToColumn(status: string): BoardColumn {
  const s = (status || '').toLowerCase();
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
 *   - limit: max items to return (default 50, max 200)
 *   - include_dev: include DEV-* items (default true for backward compatibility)
 */
router.get('/', cors(corsOptions), async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  // VTID-01079: Default true to avoid breaking existing UI
  const includeDev = req.query.include_dev !== 'false';

  try {
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!supaUrl || !supaKey) {
      return res.status(500).json({ error: 'Missing Supabase configuration' });
    }

    console.log(`[VTID-01079] Board adapter request, limit=${limit}, include_dev=${includeDev}`);

    // VTID-01058: Step 1: Fetch VTIDs from ledger
    // Note: PostgREST not.in filter is unreliable, so we fetch all and filter in post-fetch
    const vtidResp = await fetch(
      `${supaUrl}/rest/v1/vtid_ledger?order=updated_at.desc&limit=${limit * 2}`,
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

    // VTID-01058: Post-fetch filter: exclude rows with deleted/voided status or metadata flags
    const vtidRows = vtidRowsRaw.filter((row: any) => {
      const status = (row.status || '').toLowerCase();
      const isDeleted = status === 'deleted' || status === 'voided';
      const hasDeletedAt = !!row.deleted_at;
      const hasVoidedAt = !!row.voided_at;
      const meta = row.metadata || {};
      const metaDeleted = meta.deleted === true || meta.voided === true;

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

    // Limit to requested amount after filtering
    const limitedRows = vtidRows.slice(0, limit);

    // Step 2: Fetch recent OASIS events for terminal state detection
    const eventsResp = await fetch(
      `${supaUrl}/rest/v1/oasis_events?order=created_at.desc&limit=500`,
      { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
    );

    let allEvents: any[] = [];
    if (eventsResp.ok) {
      allEvents = await eventsResp.json() as any[];
    }

    // Step 3: Build board items with OASIS-derived column placement
    const boardItems: BoardItem[] = limitedRows.map((row: any) => {
      const vtid = row.vtid;
      const vtidEvents = allEvents.filter((e: any) => e.vtid === vtid);

      let isTerminal = false;
      let terminalOutcome: 'success' | 'failed' | null = null;
      let column: BoardColumn = 'SCHEDULED';
      let derivedStatus = 'scheduled';

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
    });

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

    console.log(`[VTID-01079] Board adapter built ${boardItems.length} items, deduped to ${dedupedItems.length}, include_dev=${includeDev}`);
    res.json(dedupedItems);
  } catch (err) {
    console.error('[VTID-01079] Board adapter error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

export default router;
