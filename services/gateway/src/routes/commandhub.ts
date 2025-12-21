import { Router } from "express";

export const commandhub = Router();

/**
 * VTID-01005: Board Column Derivation (OASIS-based)
 *
 * OASIS is the SINGLE SOURCE OF TRUTH for task completion.
 * Column placement is derived from OASIS events, NOT local ledger status.
 *
 * Column Mapping:
 * - COMPLETED: is_terminal=true AND terminal_outcome='success'
 * - COMPLETED (with FAILED badge): is_terminal=true AND terminal_outcome='failed'
 * - IN PROGRESS: status='Moving' (active work, not terminal)
 * - SCHEDULED: status='Pending' or newly allocated
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

/**
 * GET /api/v1/commandhub/board?limit=5
 *
 * VTID-01005: Derives board from OASIS events (single source of truth)
 * Does NOT use commandhub_board_v1 view which reads from local ledger.
 *
 * Returns tasks with proper column placement based on OASIS terminal states.
 */
commandhub.get("/board", async (req, res) => {
  try {
    const { limit = "50" } = req.query as { limit?: string };
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supaUrl || !supaKey) {
      return res.status(500).json({ error: "Missing Supabase env (SUPABASE_URL / SERVICE_ROLE)." });
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 200);

    console.log(`[VTID-01005] Command Hub board request, limit=${parsedLimit}`);

    // Step 1: Fetch VTIDs from ledger
    const vtidResp = await fetch(
      `${supaUrl}/rest/v1/vtid_ledger?order=updated_at.desc&limit=${parsedLimit}`,
      { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
    );

    if (!vtidResp.ok) {
      const errText = await vtidResp.text();
      console.error(`[VTID-01005] Ledger query failed: ${vtidResp.status} - ${errText}`);
      return res.status(502).json({ error: "database_query_failed" });
    }

    const vtidRows = await vtidResp.json() as any[];
    console.log(`[VTID-01005] Fetched ${vtidRows.length} VTIDs from ledger`);

    if (vtidRows.length === 0) {
      return res.status(200).json([]);
    }

    // Step 2: Fetch recent OASIS events for terminal state detection
    const eventsResp = await fetch(
      `${supaUrl}/rest/v1/oasis_events?order=created_at.desc&limit=500`,
      { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
    );

    let allEvents: any[] = [];
    if (eventsResp.ok) {
      allEvents = await eventsResp.json() as any[];
      console.log(`[VTID-01005] Fetched ${allEvents.length} events for board derivation`);
    } else {
      console.warn(`[VTID-01005] Events query failed, proceeding with ledger status only`);
    }

    // Step 3: Build board items with OASIS-derived column placement
    const boardItems: BoardItem[] = vtidRows.map((row: any) => {
      const vtid = row.vtid;
      const vtidEvents = allEvents.filter((e: any) => e.vtid === vtid);

      // VTID-01005: Derive terminal state from OASIS events (AUTHORITATIVE)
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
        column = 'COMPLETED'; // Failed tasks also go to COMPLETED column with badge
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

        // Terminal success states in ledger
        if (['done', 'closed', 'deployed', 'merged', 'complete'].includes(ledgerStatus)) {
          isTerminal = true;
          terminalOutcome = 'success';
          column = 'COMPLETED';
          derivedStatus = 'completed';
        }
        // Terminal failure states in ledger
        else if (['failed', 'error'].includes(ledgerStatus)) {
          isTerminal = true;
          terminalOutcome = 'failed';
          column = 'COMPLETED';
          derivedStatus = 'failed';
        }
        // In progress states
        else if (['in_progress', 'running', 'active', 'todo', 'validating'].includes(ledgerStatus)) {
          column = 'IN_PROGRESS';
          derivedStatus = 'in_progress';
        }
        // Blocked (not terminal, requires attention)
        else if (['blocked'].includes(ledgerStatus)) {
          column = 'IN_PROGRESS'; // Blocked tasks stay in progress, need resolution
          derivedStatus = 'blocked';
        }
        // Scheduled/allocated states
        else {
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

    console.log(`[VTID-01005] Built board with ${boardItems.length} items`);

    // Log column distribution for debugging
    const columnCounts = {
      SCHEDULED: boardItems.filter(i => i.column === 'SCHEDULED').length,
      IN_PROGRESS: boardItems.filter(i => i.column === 'IN_PROGRESS').length,
      COMPLETED: boardItems.filter(i => i.column === 'COMPLETED').length,
    };
    console.log(`[VTID-01005] Column distribution:`, columnCounts);

    return res.status(200).json(boardItems);
  } catch (e: any) {
    console.error("[VTID-01005] commandhub_board failed:", e);
    res.status(500).json({ error: "commandhub_board failed", detail: String(e?.message || e) });
  }
});
