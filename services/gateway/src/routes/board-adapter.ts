import { Router, Request, Response } from 'express';
import cors from 'cors';

const router = Router();

/**
 * VTID-01005: Board Column Derivation (OASIS-based)
 * VTID-01058: Exclude deleted/voided tasks, treat 'completed' as terminal success
 *
 * OASIS is the SINGLE SOURCE OF TRUTH for task completion.
 * Column placement is derived from OASIS events, NOT local ledger status.
 */
type BoardColumn = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED';

interface BoardItem {
  vtid: string;
  title: string;
  status: string;
  column: BoardColumn;
  is_terminal: boolean;
  terminal_outcome: 'success' | 'failed' | null;
  updated_at: string;
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
 * Does NOT use commandhub_board_v1 view which reads from local ledger.
 */
router.get('/', cors(corsOptions), async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  try {
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!supaUrl || !supaKey) {
      return res.status(500).json({ error: 'Missing Supabase configuration' });
    }

    console.log(`[VTID-01005] Board adapter request, limit=${limit}`);

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

      return {
        vtid,
        title: row.title || '',
        status: derivedStatus,
        column,
        is_terminal: isTerminal,
        terminal_outcome: terminalOutcome,
        updated_at: row.updated_at || row.created_at,
      };
    });

    console.log(`[VTID-01005] Board adapter built ${boardItems.length} items`);
    res.json(boardItems);
  } catch (err) {
    console.error('[VTID-01005] Board adapter error:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

export default router;
