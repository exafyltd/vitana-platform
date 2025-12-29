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
 * VTID-01058: REMOVED - Route was shadowing board-adapter.ts
 *
 * The /board route is now served ONLY by board-adapter.ts
 * which is mounted at /api/v1/commandhub/board in index.ts.
 *
 * This route was causing deleted/voided tasks to appear because
 * it lacked proper filtering. DO NOT RESTORE.
 *
 * See: services/gateway/src/routes/board-adapter.ts
 */
