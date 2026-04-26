/**
 * Routines API
 *
 * Persistent record of every Claude Code daily routine — a remote agent that
 * runs on a cron schedule in an isolated sandbox, calls Vitana gateway APIs
 * read-only, and posts findings back to the Command Hub Routines screen.
 *
 * Endpoints:
 *   GET   /api/v1/routines                          — catalog (all routines + last-run summary)
 *   GET   /api/v1/routines/:name                    — single routine + last 30 runs
 *   GET   /api/v1/routines/:name/runs/:id           — full run detail with findings JSON
 *   POST  /api/v1/routines/:name/runs               — create new run (called by routine at start)
 *   PATCH /api/v1/routines/:name/runs/:id           — update run (called by routine at finish)
 *
 * Auth:
 *   GET endpoints are open to authenticated Command Hub callers.
 *   POST/PATCH require X-Routine-Token header matching ROUTINE_INGEST_TOKEN env var.
 *   This keeps the ingest path simple (a routine running in a remote sandbox can
 *   authenticate with one shared secret) without coupling to user-session JWTs.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const routinesRouter = Router();

const LOG_PREFIX = '[routines]';

// =============================================================================
// Supabase helper (matches agents-registry.ts pattern)
// =============================================================================

async function supabaseRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    const response = await fetch(`${supabaseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const text = await response.text();
    const data = (text ? JSON.parse(text) : null) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// Types
// =============================================================================

interface RoutineRow {
  name: string;
  display_name: string;
  description: string | null;
  cron_schedule: string;
  enabled: boolean;
  last_run_id: string | null;
  last_run_at: string | null;
  last_run_status: 'running' | 'success' | 'failure' | 'partial' | null;
  last_run_summary: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

interface RoutineRunRow {
  id: string;
  routine_name: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'failure' | 'partial';
  trigger: 'cron' | 'manual';
  summary: string | null;
  findings: unknown | null;
  artifacts: unknown | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

// =============================================================================
// Ingest auth middleware
// =============================================================================

function requireRoutineToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ROUTINE_INGEST_TOKEN;
  if (!expected) {
    res.status(503).json({
      ok: false,
      error: 'ROUTINE_INGEST_TOKEN env var is not configured on the gateway',
    });
    return;
  }
  const provided = req.header('x-routine-token');
  if (provided !== expected) {
    res.status(401).json({ ok: false, error: 'Invalid or missing X-Routine-Token header' });
    return;
  }
  next();
}

// =============================================================================
// GET /api/v1/routines — catalog
// =============================================================================

routinesRouter.get('/api/v1/routines', async (_req: Request, res: Response) => {
  try {
    const result = await supabaseRequest<RoutineRow[]>(
      '/rest/v1/routines?select=*&order=name.asc'
    );

    if (!result.ok || !result.data) {
      return res.status(500).json({
        ok: false,
        error: result.error || 'Failed to load routines catalog',
      });
    }

    const counts = {
      total: result.data.length,
      enabled: result.data.filter((r) => r.enabled).length,
      by_status: {
        success: result.data.filter((r) => r.last_run_status === 'success').length,
        failure: result.data.filter((r) => r.last_run_status === 'failure').length,
        partial: result.data.filter((r) => r.last_run_status === 'partial').length,
        running: result.data.filter((r) => r.last_run_status === 'running').length,
        never_run: result.data.filter((r) => r.last_run_status === null).length,
      },
    };

    return res.status(200).json({
      ok: true,
      counts,
      routines: result.data,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} list error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /api/v1/routines/:name — single routine + last 30 runs
// =============================================================================

routinesRouter.get('/api/v1/routines/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    const [routineResult, runsResult] = await Promise.all([
      supabaseRequest<RoutineRow[]>(
        `/rest/v1/routines?name=eq.${encodeURIComponent(name)}&select=*`
      ),
      supabaseRequest<RoutineRunRow[]>(
        `/rest/v1/routine_runs?routine_name=eq.${encodeURIComponent(name)}` +
          '&select=id,routine_name,started_at,finished_at,status,trigger,summary,error,duration_ms,created_at' +
          '&order=started_at.desc&limit=30'
      ),
    ]);

    if (!routineResult.ok || !routineResult.data) {
      return res
        .status(500)
        .json({ ok: false, error: routineResult.error || 'Lookup failed' });
    }
    if (routineResult.data.length === 0) {
      return res.status(404).json({ ok: false, error: `Routine '${name}' not found` });
    }
    if (!runsResult.ok) {
      return res.status(500).json({ ok: false, error: runsResult.error || 'Runs lookup failed' });
    }

    return res.status(200).json({
      ok: true,
      routine: routineResult.data[0],
      runs: runsResult.data ?? [],
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} get error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /api/v1/routines/:name/runs/:id — full run detail
// =============================================================================

routinesRouter.get('/api/v1/routines/:name/runs/:id', async (req: Request, res: Response) => {
  try {
    const { name, id } = req.params;
    const result = await supabaseRequest<RoutineRunRow[]>(
      `/rest/v1/routine_runs?id=eq.${encodeURIComponent(id)}` +
        `&routine_name=eq.${encodeURIComponent(name)}&select=*`
    );

    if (!result.ok || !result.data) {
      return res.status(500).json({ ok: false, error: result.error || 'Lookup failed' });
    }
    if (result.data.length === 0) {
      return res
        .status(404)
        .json({ ok: false, error: `Run '${id}' for routine '${name}' not found` });
    }

    return res.status(200).json({ ok: true, run: result.data[0] });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} get run error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// POST /api/v1/routines/:name/runs — create new run (ingest)
// =============================================================================

const createRunSchema = z.object({
  trigger: z.enum(['cron', 'manual']).optional(),
});

routinesRouter.post(
  '/api/v1/routines/:name/runs',
  requireRoutineToken,
  async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const parsed = createRunSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
      }

      // Confirm the routine exists in the catalog (FK would block insert anyway,
      // but a clear 404 is friendlier than a Postgres FK error string).
      const catalogCheck = await supabaseRequest<RoutineRow[]>(
        `/rest/v1/routines?name=eq.${encodeURIComponent(name)}&select=name`
      );
      if (!catalogCheck.ok || !catalogCheck.data || catalogCheck.data.length === 0) {
        return res
          .status(404)
          .json({ ok: false, error: `Routine '${name}' not in catalog — seed it first` });
      }

      const now = new Date().toISOString();
      const insertResult = await supabaseRequest<RoutineRunRow[]>('/rest/v1/routine_runs', {
        method: 'POST',
        body: {
          routine_name: name,
          started_at: now,
          status: 'running',
          trigger: parsed.data.trigger ?? 'cron',
        },
      });

      if (!insertResult.ok || !insertResult.data || insertResult.data.length === 0) {
        return res.status(500).json({
          ok: false,
          error: insertResult.error || 'Insert failed',
        });
      }

      const run = insertResult.data[0];

      // Mark the parent catalog row as currently running.
      await supabaseRequest(
        `/rest/v1/routines?name=eq.${encodeURIComponent(name)}`,
        {
          method: 'PATCH',
          body: {
            last_run_id: run.id,
            last_run_at: now,
            last_run_status: 'running',
            last_run_summary: null,
            updated_at: now,
          },
        }
      );

      return res.status(201).json({ ok: true, run });
    } catch (error: any) {
      console.error(`${LOG_PREFIX} create run error:`, error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }
);

// =============================================================================
// PATCH /api/v1/routines/:name/runs/:id — finalize run (ingest)
// =============================================================================

const updateRunSchema = z.object({
  status: z.enum(['success', 'failure', 'partial']),
  summary: z.string().max(2000).nullable().optional(),
  findings: z.unknown().optional(),
  artifacts: z.unknown().optional(),
  error: z.string().nullable().optional(),
});

routinesRouter.patch(
  '/api/v1/routines/:name/runs/:id',
  requireRoutineToken,
  async (req: Request, res: Response) => {
    try {
      const { name, id } = req.params;
      const parsed = updateRunSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
      }

      // Load the run to compute duration and confirm ownership.
      const runLookup = await supabaseRequest<RoutineRunRow[]>(
        `/rest/v1/routine_runs?id=eq.${encodeURIComponent(id)}` +
          `&routine_name=eq.${encodeURIComponent(name)}&select=id,started_at,status`
      );
      if (!runLookup.ok || !runLookup.data || runLookup.data.length === 0) {
        return res
          .status(404)
          .json({ ok: false, error: `Run '${id}' for routine '${name}' not found` });
      }

      const existing = runLookup.data[0];
      const now = new Date();
      const finishedAt = now.toISOString();
      const durationMs = Math.max(
        0,
        now.getTime() - new Date(existing.started_at).getTime()
      );

      const updateBody: Record<string, unknown> = {
        status: parsed.data.status,
        finished_at: finishedAt,
        duration_ms: durationMs,
      };
      if (parsed.data.summary !== undefined) updateBody.summary = parsed.data.summary;
      if (parsed.data.findings !== undefined) updateBody.findings = parsed.data.findings;
      if (parsed.data.artifacts !== undefined) updateBody.artifacts = parsed.data.artifacts;
      if (parsed.data.error !== undefined) updateBody.error = parsed.data.error;

      const updateResult = await supabaseRequest<RoutineRunRow[]>(
        `/rest/v1/routine_runs?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', body: updateBody }
      );

      if (!updateResult.ok || !updateResult.data || updateResult.data.length === 0) {
        return res
          .status(500)
          .json({ ok: false, error: updateResult.error || 'Update failed' });
      }

      // Bump the parent catalog row.
      const catalogPatch: Record<string, unknown> = {
        last_run_id: id,
        last_run_at: finishedAt,
        last_run_status: parsed.data.status,
        last_run_summary: parsed.data.summary ?? null,
        updated_at: finishedAt,
      };
      if (parsed.data.status === 'success') {
        catalogPatch.consecutive_failures = 0;
      }
      await supabaseRequest(
        `/rest/v1/routines?name=eq.${encodeURIComponent(name)}`,
        { method: 'PATCH', body: catalogPatch }
      );

      // Increment failure counter via a separate read+write because PostgREST
      // doesn't expose an atomic increment for arbitrary columns. Best-effort.
      if (parsed.data.status === 'failure') {
        const cur = await supabaseRequest<{ consecutive_failures: number }[]>(
          `/rest/v1/routines?name=eq.${encodeURIComponent(name)}&select=consecutive_failures`
        );
        if (cur.ok && cur.data && cur.data.length > 0) {
          await supabaseRequest(
            `/rest/v1/routines?name=eq.${encodeURIComponent(name)}`,
            {
              method: 'PATCH',
              body: { consecutive_failures: (cur.data[0].consecutive_failures ?? 0) + 1 },
            }
          );
        }
      }

      return res.status(200).json({ ok: true, run: updateResult.data[0] });
    } catch (error: any) {
      console.error(`${LOG_PREFIX} update run error:`, error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }
);
