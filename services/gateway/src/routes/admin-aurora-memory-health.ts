/**
 * VTID-03773 — Phase 0 — Aurora connectivity diagnostic for the memory rebuild.
 *
 * This session has no AWS CLI/console access, so the only way to verify the
 * gateway's ECS security group can actually reach `vitana-aurora-prod` (via
 * `vitana-rds-proxy-prod`) is a real network round trip from inside the
 * running task itself — a `SELECT 1` over `pg`, not a description of the
 * security group from outside. This route is that round trip, reachable over
 * plain HTTPS so it can be curled from anywhere with no AWS credentials at
 * all, including this session.
 *
 * Deliberately reuses `getAuroraPool`/`withAuroraClient` from
 * `db-i18n/aurora-client.ts` rather than a new connection module — that
 * module's connectivity/TLS logic is already generic (only its schema and
 * write-gate are i18n-specific), and CLAUDE.md's own rule is to prefer an
 * existing system over rebuilding one. Read-only: no schema is created and no
 * write is attempted here, so this needs neither `AURORA_I18N_WRITES` nor any
 * memory-specific write flag — it only proves the network path and
 * credentials work, nothing more.
 *
 * GET /api/v1/admin/aurora-memory/health
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { AuroraConfigError, resolveAuroraConfig, withAuroraClient } from '../services/db-i18n/aurora-client';

const router = Router();
router.use('/admin/aurora-memory', requireAuth);
router.use('/admin/aurora-memory', requireExafyAdmin);

router.get('/admin/aurora-memory/health', async (_req: AuthenticatedRequest, res: Response) => {
  const startedAt = Date.now();

  let describe: string;
  try {
    describe = resolveAuroraConfig().describe;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(503).json({
      ok: false,
      reachable: false,
      configured: false,
      error_type: err instanceof AuroraConfigError ? 'config' : 'unknown',
      error_message: message,
    });
  }

  try {
    const row = await withAuroraClient(async (client) => {
      const result = await client.query<{ ok: number; db_time: string }>(
        'SELECT 1 AS ok, now()::text AS db_time',
      );
      return result.rows[0];
    });
    return res.json({
      ok: true,
      reachable: true,
      configured: true,
      latency_ms: Date.now() - startedAt,
      db_time: row?.db_time ?? null,
      target: describe,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish "reached Aurora, credentials/SSL rejected" from "network
    // path is closed" as best effort — both are useful signals for Phase 0,
    // and conflating them would send whoever reads this chasing the wrong
    // fix (a security-group rule vs. a Secrets Manager value).
    const errorType = /timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(message)
      ? 'network'
      : /password|authentication|SSL|certificate/i.test(message)
        ? 'auth_or_tls'
        : 'unknown';
    return res.status(503).json({
      ok: false,
      reachable: false,
      configured: true,
      latency_ms: Date.now() - startedAt,
      error_type: errorType,
      error_message: message,
      target: describe,
    });
  }
});

export default router;
