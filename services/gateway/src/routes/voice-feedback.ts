/**
 * Voice Feedback Reports — Test user bug reports & UX improvement suggestions
 *
 * Endpoints:
 * - POST /api/v1/voice-feedback/submit          - Submit a feedback report
 * - GET  /api/v1/voice-feedback/reports          - List user's own reports
 * - GET  /api/v1/voice-feedback/reports/:id      - Single report detail
 * - POST /api/v1/voice-feedback/reports/:id/approve  - Admin: approve → create Command Hub task
 * - POST /api/v1/voice-feedback/reports/:id/reject   - Admin: reject with reason
 * - GET  /api/v1/voice-feedback/health           - Health check
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// Constants
// =============================================================================

const REPORT_TYPES = ['bug_report', 'ux_improvement'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const STATUSES = ['received', 'under_review', 'in_progress', 'fixed', 'wont_fix', 'duplicate'] as const;

// =============================================================================
// Schemas
// =============================================================================

const SubmitReportSchema = z.object({
  transcript: z.string().min(1).max(5000),
  report_type: z.enum(REPORT_TYPES).default('bug_report'),
  severity: z.enum(SEVERITIES).default('medium'),
  affected_screen: z.string().max(200).optional(),
  attachments: z.array(z.string().url()).max(10).default([]),
});

const ListReportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(STATUSES).optional(),
});

const RejectReportSchema = z.object({
  reason: z.string().min(1).max(1000),
});

// =============================================================================
// Helpers
// =============================================================================

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key);
}

function getUserClient(token: string) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function emitFeedbackEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VOICE-FEEDBACK',
    type: type as any,
    source: 'voice-feedback-gateway',
    status,
    message,
    payload,
  }).catch(err => console.warn(`[voice-feedback] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /submit — Submit a feedback report
 */
router.post('/submit', async (req: Request, res: Response) => {
  console.log('[voice-feedback] POST /submit');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', message: 'Bearer token required' });
  }

  const parsed = SubmitReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
  }

  const userClient = getUserClient(token);
  if (!userClient) {
    return res.status(503).json({ ok: false, error: 'GATEWAY_MISCONFIGURED' });
  }

  // Get user identity
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }

  const { transcript, report_type, severity, affected_screen, attachments } = parsed.data;

  const { data, error } = await userClient
    .from('user_feedback_reports')
    .insert({
      user_id: user.id,
      transcript,
      report_type,
      severity,
      affected_screen: affected_screen || null,
      attachments,
    })
    .select('id, created_at')
    .single();

  if (error) {
    console.error('[voice-feedback] Insert error:', error);
    return res.status(500).json({ ok: false, error: 'INSERT_FAILED', message: error.message });
  }

  await emitFeedbackEvent(
    'voice.feedback.submitted',
    'info',
    `Feedback report submitted: ${report_type} (${severity})`,
    { report_id: data.id, report_type, severity, affected_screen, user_id: user.id }
  );

  return res.status(201).json({
    ok: true,
    report_id: data.id,
    created_at: data.created_at,
    message: 'The Exafy team appreciates your support to make Vitanaland a better experience every day.',
  });
});

/**
 * GET /reports — List user's own reports
 */
router.get('/reports', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const parsed = ListReportsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
  }

  const userClient = getUserClient(token);
  if (!userClient) {
    return res.status(503).json({ ok: false, error: 'GATEWAY_MISCONFIGURED' });
  }

  const { limit, offset, status } = parsed.data;

  let query = userClient
    .from('user_feedback_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[voice-feedback] List error:', error);
    return res.status(500).json({ ok: false, error: 'QUERY_FAILED', message: error.message });
  }

  return res.json({ ok: true, reports: data || [], count: (data || []).length });
});

/**
 * GET /reports/:id — Single report detail
 */
router.get('/reports/:id', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const userClient = getUserClient(token);
  if (!userClient) {
    return res.status(503).json({ ok: false, error: 'GATEWAY_MISCONFIGURED' });
  }

  const { data, error } = await userClient
    .from('user_feedback_reports')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }

  return res.json({ ok: true, report: data });
});

/**
 * POST /reports/:id/approve — Admin: approve report and create Command Hub task
 */
router.post('/reports/:id/approve', async (req: Request, res: Response) => {
  console.log('[voice-feedback] POST /reports/:id/approve');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const serviceClient = getServiceClient();
  if (!serviceClient) {
    return res.status(503).json({ ok: false, error: 'GATEWAY_MISCONFIGURED' });
  }

  // Fetch the report
  const { data: report, error: fetchErr } = await serviceClient
    .from('user_feedback_reports')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (fetchErr || !report) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }

  if (report.status !== 'received' && report.status !== 'under_review') {
    return res.status(409).json({ ok: false, error: 'ALREADY_PROCESSED', status: report.status });
  }

  // Create a VTID task in vtid_ledger
  const typePrefix = report.report_type === 'bug_report' ? '[Bug]' : '[UX]';
  const taskHeader = `${typePrefix} ${report.transcript.slice(0, 120)}`;
  const specText = [
    `**Type:** ${report.report_type}`,
    `**Severity:** ${report.severity}`,
    `**Affected Screen:** ${report.affected_screen || 'Not specified'}`,
    `**Reporter Transcript:**\n${report.transcript}`,
    report.attachments.length > 0 ? `**Attachments:** ${report.attachments.length} file(s)` : '',
  ].filter(Boolean).join('\n\n');

  // Allocate next VTID
  const { data: maxVtid } = await serviceClient
    .from('vtid_ledger')
    .select('vtid')
    .order('vtid', { ascending: false })
    .limit(1)
    .single();

  let nextNum = 1300;
  if (maxVtid?.vtid) {
    const match = maxVtid.vtid.match(/VTID-(\d+)/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }
  const vtid = `VTID-${String(nextNum).padStart(5, '0')}`;

  // Insert task into vtid_ledger
  const { error: ledgerErr } = await serviceClient
    .from('vtid_ledger')
    .insert({
      vtid,
      header: taskHeader,
      spec_text: specText,
      status: 'pending',
      spec_status: 'draft',
      is_terminal: false,
      target_role: 'DEV',
      task_family: 'DEV',
      source: 'voice-feedback',
    });

  if (ledgerErr) {
    console.error('[voice-feedback] Ledger insert error:', ledgerErr);
    return res.status(500).json({ ok: false, error: 'TASK_CREATION_FAILED', message: ledgerErr.message });
  }

  // Update report status
  await serviceClient
    .from('user_feedback_reports')
    .update({ status: 'in_progress', vtid })
    .eq('id', report.id);

  await emitFeedbackEvent(
    'voice.feedback.approved',
    'success',
    `Feedback approved and converted to task ${vtid}`,
    { report_id: report.id, vtid, report_type: report.report_type }
  );

  return res.json({ ok: true, vtid, task_header: taskHeader });
});

/**
 * POST /reports/:id/reject — Admin: reject report with reason
 */
router.post('/reports/:id/reject', async (req: Request, res: Response) => {
  console.log('[voice-feedback] POST /reports/:id/reject');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const parsed = RejectReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
  }

  const serviceClient = getServiceClient();
  if (!serviceClient) {
    return res.status(503).json({ ok: false, error: 'GATEWAY_MISCONFIGURED' });
  }

  const { data: report, error: fetchErr } = await serviceClient
    .from('user_feedback_reports')
    .select('id, status')
    .eq('id', req.params.id)
    .single();

  if (fetchErr || !report) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }

  await serviceClient
    .from('user_feedback_reports')
    .update({ status: 'wont_fix', admin_notes: parsed.data.reason })
    .eq('id', report.id);

  await emitFeedbackEvent(
    'voice.feedback.rejected',
    'info',
    `Feedback report rejected: ${parsed.data.reason}`,
    { report_id: report.id }
  );

  return res.json({ ok: true, status: 'wont_fix' });
});

/**
 * GET /health — Health check
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'voice-feedback', timestamp: new Date().toISOString() });
});

export default router;
