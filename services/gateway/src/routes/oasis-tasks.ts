import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

export const oasisTasksRouter = Router();

// ===========================================================================
// VTID-01158: OASIS-Only Task Discovery
// ===========================================================================

// 2.3 Accepted VTID Format: VTID-\d{4,5}
const VTID_PATTERN = /^VTID-\d{4,5}$/;

// Hard reject patterns (legacy formats)
const LEGACY_PATTERNS = [
  /^DEV-/,
  /^ADM-/,
  /^AICOR-/,
  /^OASIS-TASK-/,
];

/**
 * Check if an ID matches a legacy pattern that should be ignored
 */
function isLegacyId(id: string): { isLegacy: boolean; pattern?: string } {
  for (const pattern of LEGACY_PATTERNS) {
    if (pattern.test(id)) {
      return { isLegacy: true, pattern: pattern.source };
    }
  }
  return { isLegacy: false };
}

/**
 * GET /api/v1/oasis/tasks/discover
 * VTID-01158 / VTID-01161: OASIS-Only Task Discovery
 *
 * HARD GOVERNANCE:
 * 1. OASIS is the ONLY source of truth for tasks
 * 2. NO fallback to repo scans, spec files, memory summaries, or cached lists
 * 3. DEV-* items appear in ignored[] only, never in pending[]
 * 4. VTID format must be VTID-\d{4,5}
 *
 * Query params:
 * - tenant: string (default: 'vitana')
 * - environment: string (default: 'dev_sandbox')
 * - statuses: comma-separated (default: 'scheduled,allocated,in_progress')
 * - limit: number (1-200, default: 50)
 */
oasisTasksRouter.get('/api/v1/oasis/tasks/discover', async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) {
      return res.status(500).json({
        ok: false,
        source_of_truth: 'OASIS',
        error: 'Gateway misconfigured',
        pending: [],
        ignored: [],
        counts: { pending: 0, ignored: 0 }
      });
    }

    // Parse query parameters
    const tenant = (req.query.tenant as string) || 'vitana';
    const environment = (req.query.environment as string) || 'dev_sandbox';
    const statusesParam = (req.query.statuses as string) || 'scheduled,allocated,in_progress';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);

    const validStatuses = statusesParam.split(',').filter(s =>
      ['scheduled', 'allocated', 'in_progress'].includes(s.trim())
    );

    // Build query for pending statuses (NOT deleted, NOT completed)
    // Use PostgREST 'in' operator for multiple status filter
    const statusFilter = validStatuses.map(s => `status.eq.${s}`).join(',');
    const queryParams = `limit=${limit}&order=updated_at.desc&or=(${statusFilter})&status=neq.deleted&status=neq.completed`;

    console.log(`[VTID-01158] Discovering tasks: tenant=${tenant}, env=${environment}, statuses=${validStatuses.join(',')}, limit=${limit}`);

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?${queryParams}`, {
      headers: {
        'Content-Type': 'application/json',
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`
      },
    });

    if (!resp.ok) {
      console.error(`[VTID-01158] Database query failed: ${resp.status}`);
      return res.status(502).json({
        ok: false,
        source_of_truth: 'OASIS',
        error: 'Database query failed',
        pending: [],
        ignored: [],
        counts: { pending: 0, ignored: 0 }
      });
    }

    const data = await resp.json() as any[];

    // Separate valid VTIDs from legacy/invalid IDs
    const pending: any[] = [];
    const ignored: any[] = [];

    for (const row of data) {
      const vtid = row.vtid;

      // Check for legacy ID patterns
      const { isLegacy, pattern } = isLegacyId(vtid);
      if (isLegacy) {
        ignored.push({
          id: vtid,
          reason: 'ignored_by_contract',
          details: `Non-numeric VTID format (matches ${pattern}); repo artifacts are not task truth.`
        });
        continue;
      }

      // Validate VTID format
      if (!VTID_PATTERN.test(vtid)) {
        ignored.push({
          id: vtid,
          reason: 'ignored_by_contract',
          details: `VTID format invalid. Expected VTID-\\d{4,5}, got: ${vtid}`
        });
        continue;
      }

      // Task passes validation - add to pending
      pending.push({
        vtid: row.vtid,
        title: row.title || 'Pending Title',
        status: row.status,
        task_family: 'VTID',
        task_type: row.module || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        links: {
          task: `/api/v1/oasis/tasks/${row.vtid}`,
          events: `/api/v1/oasis/events?vtid=${row.vtid}`
        },
        evidence: {
          oasis_task_present: true,
          status_is_pending: validStatuses.includes(row.status),
          vtid_format_valid: true
        }
      });
    }

    console.log(`[VTID-01158] Discovery complete: ${pending.length} pending, ${ignored.length} ignored`);

    return res.status(200).json({
      ok: true,
      source_of_truth: 'OASIS',
      queried: {
        tenant,
        environment,
        statuses: validStatuses,
        limit
      },
      pending,
      ignored,
      counts: {
        pending: pending.length,
        ignored: ignored.length
      },
      compatibility: {
        command_hub_board_expected: true,
        board_source_view: 'commandhub_board_visible',
        note: 'Pending tasks are defined to match board visibility logic (OASIS-driven).'
      }
    });
  } catch (e: any) {
    console.error(`[VTID-01158] Discovery error:`, e);
    return res.status(500).json({
      ok: false,
      source_of_truth: 'OASIS',
      error: e.message || 'Internal server error',
      pending: [],
      ignored: [],
      counts: { pending: 0, ignored: 0 }
    });
  }
});

// ===========================================================================
// VTID-0542: Global VTID Allocator Feature Flags
// ===========================================================================

// When enabled, manual VTID creation is blocked - must use allocator
const VTID_ALLOCATOR_ENABLED = process.env.VTID_ALLOCATOR_ENABLED === 'true';

const TaskCreateSchema = z.object({
  title: z.string().min(1, "Title is required"),
  vtid: z.string().optional(),
  layer: z.string().default("oasis"),
  module: z.string().default("tasks"),
  status: z.enum(["scheduled", "in_progress", "completed", "pending", "blocked", "cancelled"]).default("scheduled"),
  summary: z.string().optional(),
  assigned_to: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const TaskUpdateSchema = z.object({
  title: z.string().optional(),
  status: z.enum(["scheduled", "in_progress", "completed", "pending", "blocked", "cancelled"]).optional(),
  summary: z.string().optional(),
  assigned_to: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

oasisTasksRouter.get('/api/v1/oasis/tasks', async (req: Request, res: Response) => {
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string;
    const layer = req.query.layer as string;

    // VTID-01052: Exclude deleted tasks by default
    let queryParams = `limit=${limit}&offset=${offset}&order=updated_at.desc&status=neq.deleted`;
    if (status) queryParams += `&status=eq.${status}`;
    if (layer) queryParams += `&layer=eq.${layer}`;

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?${queryParams}`, {
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database query failed' });

    const data = await resp.json() as any[];
    const tasks = data.map(row => ({
      id: row.vtid, vtid: row.vtid, title: row.title, description: row.summary ?? row.title,
      status: row.status, layer: row.layer, module: row.module, assigned_to: row.assigned_to,
      metadata: row.metadata, created_at: row.created_at, updated_at: row.updated_at,
      // VTID-01080: Terminal completion fields
      is_terminal: row.is_terminal ?? false,
      terminal_outcome: row.terminal_outcome ?? null,
      completed_at: row.completed_at ?? null,
    }));

    return res.status(200).json(tasks);
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

oasisTasksRouter.post('/api/v1/oasis/tasks', async (req: Request, res: Response) => {
  try {
    const validation = TaskCreateSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: 'Validation failed', detail: validation.error.errors });

    const body = validation.data;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    // ===========================================================================
    // VTID-0542 D5: Manual/CTO path rule enforcement guard
    // When allocator is enabled, VTIDs MUST be allocated via /api/v1/vtid/allocate
    // Manual VTID creation is blocked to prevent split-brain
    // ===========================================================================
    if (VTID_ALLOCATOR_ENABLED) {
      console.log('[VTID-0542] D5 Guard: Allocator enabled, blocking manual task creation');
      return res.status(403).json({
        error: 'manual_vtid_blocked',
        message: 'VTID must be allocated via POST /api/v1/vtid/allocate. Manual VTID creation is disabled when allocator is active.',
        vtid: 'VTID-0542',
        help: 'Use the Command Hub "+Task" button or Operator Console /task command to create tasks with auto-allocated VTIDs.'
      });
    }

    // Legacy path: Only available when allocator is disabled
    console.log('[VTID-0542] D5 Guard: Allocator disabled, allowing legacy manual creation');

    const vtid = body.vtid || `OASIS-TASK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const payload = { vtid, title: body.title, summary: body.summary ?? null, layer: body.layer, module: body.module, status: body.status, assigned_to: body.assigned_to ?? null, metadata: body.metadata ?? null };

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database insert failed' });

    const data = await resp.json();
    const created = Array.isArray(data) ? data[0] : data;
    return res.status(201).json({ id: created.vtid, vtid: created.vtid, title: created.title, status: created.status, created_at: created.created_at });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

oasisTasksRouter.get('/api/v1/oasis/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${id}`, {
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database query failed' });
    const data = await resp.json() as any[];
    if (data.length === 0) return res.status(404).json({ error: 'Task not found', id });

    const row = data[0];
    return res.status(200).json({
      id: row.vtid, vtid: row.vtid, title: row.title, status: row.status, layer: row.layer, module: row.module,
      created_at: row.created_at, updated_at: row.updated_at,
      // VTID-01080: Terminal completion fields
      is_terminal: row.is_terminal ?? false,
      terminal_outcome: row.terminal_outcome ?? null,
      completed_at: row.completed_at ?? null,
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

oasisTasksRouter.patch('/api/v1/oasis/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const validation = TaskUpdateSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: 'Validation failed' });

    const body = validation.data;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    const payload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.title !== undefined) payload.title = body.title;
    if (body.status !== undefined) payload.status = body.status;
    if (body.summary !== undefined) payload.summary = body.summary;
    // VTID-01010: Support metadata update (including target_roles)
    if (body.metadata !== undefined) payload.metadata = body.metadata;

    const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) return res.status(502).json({ error: 'Database update failed' });
    const data = await resp.json() as any[];
    if (data.length === 0) return res.status(404).json({ error: 'Task not found', id });

    return res.status(200).json({ id: data[0].vtid, vtid: data[0].vtid, title: data[0].title, status: data[0].status });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', detail: e.message });
  }
});

/**
 * DELETE /api/v1/oasis/tasks/:id
 * VTID-01052: Soft delete scheduled tasks only
 *
 * Rules:
 * - If task not found → 404
 * - If task.status !== 'scheduled' → 409 INVALID_STATE
 * - If scheduled → soft delete (void task and VTID, log OASIS event)
 *
 * Never allows deletion of in_progress or completed tasks.
 */
oasisTasksRouter.delete('/api/v1/oasis/tasks/:id', async (req: Request, res: Response) => {
  try {
    const { id: vtid } = req.params;
    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) return res.status(500).json({ error: 'Gateway misconfigured' });

    // Step 1: Fetch the task to check if it exists and its status
    const fetchResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!fetchResp.ok) {
      console.error(`[VTID-01052] Failed to fetch task ${vtid}: ${fetchResp.status}`);
      return res.status(502).json({ ok: false, error: 'Database query failed' });
    }

    const tasks = await fetchResp.json() as any[];
    if (tasks.length === 0) {
      console.log(`[VTID-01052] Task not found: ${vtid}`);
      return res.status(404).json({ ok: false, error: 'Task not found', vtid });
    }

    const task = tasks[0];
    const currentStatus = (task.status || '').toLowerCase();

    // Step 2: Check if task is in a pre-start status - ONLY pre-start tasks can be deleted
    // Explicitly reject in_progress, completed, and any other active/terminal status
    const deletableStatuses = ['scheduled', 'allocated', 'pending'];
    if (!deletableStatuses.includes(currentStatus)) {
      console.log(`[VTID-01052] Cannot delete task ${vtid}: status is '${currentStatus}', not 'scheduled'`);

      // Log rejection event to OASIS
      const rejectEventId = randomUUID();
      const rejectTimestamp = new Date().toISOString();
      await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
        body: JSON.stringify({
          id: rejectEventId,
          created_at: rejectTimestamp,
          vtid: vtid,
          topic: 'vtid.lifecycle.delete_rejected',
          service: 'vtid-lifecycle-command-hub',
          role: 'GOVERNANCE',
          model: 'vtid-01052-delete-scheduled',
          status: 'warning',
          message: `Delete rejected: Task ${vtid} has status '${currentStatus}', not 'scheduled'`,
          metadata: {
            action: 'delete_scheduled_task_rejected',
            current_status: currentStatus,
            rejected_at: rejectTimestamp,
            reason: 'INVALID_STATE'
          }
        }),
      });

      return res.status(409).json({
        ok: false,
        error: 'INVALID_STATE',
        message: `Cannot delete task with status '${currentStatus}'. Only scheduled tasks can be deleted.`,
        vtid
      });
    }

    // Step 3: Perform soft delete transaction
    const timestamp = new Date().toISOString();
    const deletedBy = req.headers['x-vitana-user-email'] as string || 'command-hub';

    // Update vtid_ledger: set status='deleted', deleted_at, deleted_by, delete_reason, voided_at, voided_reason
    const updatePayload = {
      status: 'deleted',
      deleted_at: timestamp,
      deleted_by: deletedBy,
      delete_reason: 'user_cancelled',
      voided_at: timestamp,
      voided_reason: 'task_deleted',
      updated_at: timestamp
    };

    const updateResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(updatePayload),
    });

    if (!updateResp.ok) {
      const text = await updateResp.text();
      console.error(`[VTID-01052] Failed to soft delete task ${vtid}: ${updateResp.status} - ${text}`);
      return res.status(502).json({ ok: false, error: 'Database update failed' });
    }

    // Step 4: Insert OASIS event for successful deletion
    const eventId = randomUUID();
    const eventPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: vtid,
      topic: 'vtid.lifecycle.deleted',
      service: 'vtid-lifecycle-command-hub',
      role: 'GOVERNANCE',
      model: 'vtid-01052-delete-scheduled',
      status: 'success',
      message: `Scheduled task deleted by user`,
      link: null,
      metadata: {
        action: 'delete_scheduled_task',
        previous_status: currentStatus,
        new_status: 'deleted',
        deleted_by: deletedBy,
        deleted_at: timestamp,
        vtid: vtid,
        voided: true
      }
    };

    const eventResp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(eventPayload),
    });

    if (!eventResp.ok) {
      console.warn(`[VTID-01052] Task ${vtid} deleted but failed to log OASIS event: ${eventResp.status}`);
    } else {
      console.log(`[VTID-01052] Task ${vtid} deleted successfully. OASIS event: ${eventId}`);
    }

    return res.status(200).json({
      ok: true,
      data: {
        vtid: vtid,
        status: 'deleted'
      }
    });
  } catch (e: any) {
    console.error(`[VTID-01052] Unexpected error:`, e);
    return res.status(500).json({ ok: false, error: 'Internal server error', detail: e.message });
  }
});

// ===========================================================================
// VTID-01080: Terminal Completion Endpoint (CI/CD Hard Gate)
// ===========================================================================
// POST /api/v1/oasis/tasks/:vtid/complete
//
// A task is ONLY "done" if the CI/CD pipeline writes a terminal completion
// update via this endpoint. This is the hard gate for deployment success.
//
// Request body:
//   { "terminal_outcome": "success" | "failed" | "cancelled" }
//
// Behavior:
//   - Validates VTID format (VTID-\d{4,})
//   - Updates vtid_ledger: status=completed/rejected based on outcome, is_terminal=true, terminal_outcome, completed_at
//   - Idempotent: if already completed+terminal, returns ok with already_completed: true
//   - Emits OASIS event: vtid.lifecycle.terminal_completion
// ===========================================================================

const TerminalCompletionSchema = z.object({
  terminal_outcome: z.enum(['success', 'failed', 'cancelled']).default('success'),
});

oasisTasksRouter.post('/api/v1/oasis/tasks/:vtid/complete', async (req: Request, res: Response) => {
  try {
    const { vtid } = req.params;

    // Validate VTID format: VTID-XXXXX (4+ digits)
    if (!vtid || !/^VTID-\d{4,}$/.test(vtid)) {
      console.log(`[VTID-01080] Invalid VTID format: ${vtid}`);
      return res.status(400).json({
        ok: false,
        error: 'INVALID_VTID_FORMAT',
        message: 'VTID must match format VTID-XXXXX (4+ digits)',
        vtid
      });
    }

    // Parse request body
    const validation = TerminalCompletionSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        ok: false,
        error: 'VALIDATION_FAILED',
        message: 'Invalid request body',
        details: validation.error.errors
      });
    }

    const { terminal_outcome } = validation.data;

    const svcKey = process.env.SUPABASE_SERVICE_ROLE;
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!svcKey || !supabaseUrl) {
      console.error('[VTID-01080] Gateway misconfigured - missing Supabase credentials');
      return res.status(500).json({ ok: false, error: 'Gateway misconfigured' });
    }

    // Step 1: Fetch the task to check current state
    const fetchResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
    });

    if (!fetchResp.ok) {
      console.error(`[VTID-01080] Failed to fetch task ${vtid}: ${fetchResp.status}`);
      return res.status(502).json({ ok: false, error: 'DATABASE_ERROR', message: 'Failed to query database' });
    }

    const tasks = await fetchResp.json() as any[];
    if (tasks.length === 0) {
      console.log(`[VTID-01080] Task not found: ${vtid}`);
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: `VTID ${vtid} not found in ledger`, vtid });
    }

    const task = tasks[0];

    // Step 2: Check if already terminal (idempotent)
    if (task.is_terminal === true && task.status === 'completed') {
      console.log(`[VTID-01080] Task ${vtid} already completed+terminal (idempotent response)`);
      return res.status(200).json({
        ok: true,
        vtid,
        already_completed: true,
        status: task.status,
        is_terminal: task.is_terminal,
        terminal_outcome: task.terminal_outcome,
        completed_at: task.completed_at
      });
    }

    // Step 3: Update task to terminal completion state
    // VTID-01206: Set status based on outcome - 'rejected' for failed (shows red), 'completed' for success (shows green)
    const timestamp = new Date().toISOString();
    const newStatus = terminal_outcome === 'success' ? 'completed' : terminal_outcome === 'failed' ? 'rejected' : 'cancelled';
    const updatePayload = {
      status: newStatus,
      is_terminal: true,
      terminal_outcome: terminal_outcome,
      completed_at: timestamp,
      updated_at: timestamp
    };

    const updateResp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(updatePayload),
    });

    if (!updateResp.ok) {
      const text = await updateResp.text();
      console.error(`[VTID-01080] Failed to update task ${vtid}: ${updateResp.status} - ${text}`);
      return res.status(502).json({ ok: false, error: 'DATABASE_ERROR', message: 'Failed to update task' });
    }

    const updatedTasks = await updateResp.json() as any[];
    const updated = updatedTasks[0];

    // Step 4: Emit OASIS event for terminal completion
    // VTID-01122-FIX: Use correct topic so board-adapter recognizes completion
    // Previously used 'vtid.lifecycle.terminal_completion' which was not recognized
    const eventId = randomUUID();
    const completionTopic = terminal_outcome === 'success'
      ? 'vtid.lifecycle.completed'
      : 'vtid.lifecycle.failed';
    const eventPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: vtid,
      topic: completionTopic,
      service: 'cicd-terminal-gate',
      role: 'DEPLOY',
      model: 'vtid-01080-terminal-gate',
      status: terminal_outcome === 'success' ? 'success' : 'error',
      message: `Task ${vtid} marked as terminal with outcome: ${terminal_outcome}`,
      link: null,
      metadata: {
        action: 'terminal_completion',
        previous_status: task.status,
        previous_is_terminal: task.is_terminal,
        new_status: newStatus,
        is_terminal: true,
        terminal_outcome: terminal_outcome,
        completed_at: timestamp,
        vtid: vtid
      }
    };

    const eventResp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: svcKey, Authorization: `Bearer ${svcKey}` },
      body: JSON.stringify(eventPayload),
    });

    if (!eventResp.ok) {
      console.warn(`[VTID-01080] Task ${vtid} completed but failed to log OASIS event: ${eventResp.status}`);
    } else {
      console.log(`[VTID-01080] Task ${vtid} terminal completion recorded. Event: ${eventId}`);
    }

    return res.status(200).json({
      ok: true,
      vtid,
      already_completed: false,
      status: updated.status,
      is_terminal: updated.is_terminal,
      terminal_outcome: updated.terminal_outcome,
      completed_at: updated.completed_at
    });
  } catch (e: any) {
    console.error(`[VTID-01080] Unexpected error:`, e);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});
