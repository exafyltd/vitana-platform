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

// =============================================================================
// VTID-02032 — Routine → self-healing bridge
// =============================================================================
// When a routine detects a breach, calling this endpoint:
//   1. Emits an OASIS event (audit trail)
//   2. Forwards a synthetic HealthReport into POST /api/v1/self-healing/report
//      so the existing self-healing pipeline (LLM diagnosis + auto-fix-or-
//      escalate) actually runs on the breach.
//
// This closes the gap where routines emitted OASIS events with nothing
// listening. The autonomy contract: every breach activates self-healing.

const escalateSchema = z.object({
  routine_name: z.string().min(1).max(64),
  topic: z.string().min(1).max(128),
  source_endpoint: z.string().min(1).max(512).optional(),
  severity: z.enum(['warning', 'critical']).optional(),
  message: z.string().max(2000),
  payload: z.unknown().optional(),
  vtid_for_event: z.string().optional(),
});

routinesRouter.post(
  '/api/v1/routines/escalate-incident',
  requireRoutineToken,
  async (req: Request, res: Response) => {
    try {
      const parsed = escalateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ ok: false, error: 'Invalid body', details: parsed.error.flatten() });
      }
      const {
        routine_name,
        topic,
        source_endpoint,
        severity,
        message,
        payload,
        vtid_for_event,
      } = parsed.data;

      // 1. Emit OASIS event (audit trail) — same shape as /api/v1/events/ingest.
      const supabaseUrl = process.env.SUPABASE_URL;
      const svcKey = process.env.SUPABASE_SERVICE_ROLE;
      let oasisEventId: string | null = null;
      if (supabaseUrl && svcKey) {
        try {
          const eventResp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: svcKey,
              Authorization: `Bearer ${svcKey}`,
              Prefer: 'return=representation',
            },
            body: JSON.stringify({
              vtid: vtid_for_event ?? 'SYSTEM',
              topic,
              service: `routine.${routine_name}`,
              role: 'API',
              model: 'routine-escalate-incident',
              status: severity ?? 'warning',
              message,
              metadata: payload ?? {},
              created_at: new Date().toISOString(),
            }),
          });
          if (eventResp.ok) {
            const data = (await eventResp.json()) as Array<{ id?: string }>;
            oasisEventId = Array.isArray(data) && data[0]?.id ? data[0].id : null;
          }
        } catch (e) {
          console.warn(`${LOG_PREFIX} oasis ingest failed (non-fatal):`, e);
        }
      }

      // 2. Forward a synthetic HealthReport to /api/v1/self-healing/report so the
      //    full pipeline (diagnose, allocate VTID, auto-fix or escalate) runs.
      const syntheticEndpoint =
        source_endpoint && source_endpoint.startsWith('/')
          ? source_endpoint
          : `routine-incident://${routine_name}/${topic.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

      const port = process.env.PORT || '8080';
      const internalUrl = `http://localhost:${port}/api/v1/self-healing/report`;
      const healthReport = {
        timestamp: new Date().toISOString(),
        total: 1,
        live: 0,
        services: [
          {
            name: `routine.${routine_name}`,
            endpoint: syntheticEndpoint,
            status: 'down',
            http_status: null,
            response_body: '',
            response_time_ms: 0,
            error_message: `${message} | payload=${JSON.stringify(payload ?? {}).slice(0, 1500)}`,
          },
        ],
      };

      let selfHealingResult: any = null;
      let selfHealingError: string | null = null;
      try {
        const r = await fetch(internalUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(healthReport),
        });
        const text = await r.text();
        try {
          selfHealingResult = text ? JSON.parse(text) : null;
        } catch {
          selfHealingResult = { raw: text.slice(0, 500) };
        }
        if (!r.ok) {
          selfHealingError = `${r.status}: ${text.slice(0, 200)}`;
        }
      } catch (e: any) {
        selfHealingError = e.message;
      }

      return res.status(200).json({
        ok: true,
        oasis_event_id: oasisEventId,
        synthetic_endpoint: syntheticEndpoint,
        self_healing: selfHealingResult,
        self_healing_error: selfHealingError,
      });
    } catch (error: any) {
      console.error(`${LOG_PREFIX} escalate-incident error:`, error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }
);
