import { Router, Request, Response } from 'express';
import cors from 'cors';

const router = Router();

/**
 * VTID-01005: Board Column Derivation (OASIS-based)
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

    // Step 1: Fetch VTIDs from ledger
    const vtidResp = await fetch(
      `${supaUrl}/rest/v1/vtid_ledger?order=updated_at.desc&limit=${limit}`,
      { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
    );

    if (!vtidResp.ok) {
      const errText = await vtidResp.text();
      console.error(`[VTID-01005] Ledger query failed: ${vtidResp.status} - ${errText}`);
      return res.status(500).json({ error: 'Database query failed', details: errText });
    }

    const vtidRows = await vtidResp.json() as any[];

    if (vtidRows.length === 0) {
      return res.json([]);
    }

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
    const boardItems: BoardItem[] = vtidRows.map((row: any) => {
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

        if (['done', 'closed', 'deployed', 'merged', 'complete'].includes(ledgerStatus)) {
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
