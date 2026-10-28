/**
 * Email Intake API — Receives emails forwarded from Cloudflare Email Worker
 * and creates scheduled tasks in the Command Hub.
 *
 * Endpoint: POST /api/v1/intake/email
 *
 * Flow:
 * 1. Validate sender against allowlist
 * 2. Rate limit (max 10 tasks per sender per hour)
 * 3. Classify intent from subject (BUG / FEATURE / IMPROVEMENT / IDEA)
 * 4. Allocate VTID
 * 5. Create vtid_ledger entry (status: 'scheduled')
 * 6. Auto-generate spec (fire-and-forget)
 * 7. Emit OASIS event
 */

import { Router, Request, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import { allocateVtid } from '../services/operator-service';
import { ensureScheduledDevTask } from '../services/task-intake-service';
import { guessAreaFromText, buildTitle } from '../utils/task-title';

const router = Router();

// =============================================================================
// Configuration
// =============================================================================

const LOG_PREFIX = '[email-intake]';

// Sender allowlist — only these addresses can create tasks via email
// Add authorized senders here or load from env/DB
const SENDER_ALLOWLIST: string[] = (process.env.EMAIL_INTAKE_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(s => s.length > 0);

// If no allowlist configured, allow all senders from exacy.io domain
const ALLOW_DOMAIN = process.env.EMAIL_INTAKE_ALLOW_DOMAIN || 'exacy.io';

// Rate limit: track recent submissions per sender
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;

// Worker secret for authentication
const EMAIL_WORKER_SECRET = process.env.EMAIL_WORKER_SECRET || '';

// =============================================================================
// Helpers
// =============================================================================

function isSenderAllowed(from: string): boolean {
  const email = from.toLowerCase().trim();

  // Check explicit allowlist first
  if (SENDER_ALLOWLIST.length > 0) {
    return SENDER_ALLOWLIST.includes(email);
  }

  // Fallback: allow any sender from the configured domain
  if (ALLOW_DOMAIN) {
    return email.endsWith(`@${ALLOW_DOMAIN}`);
  }

  return false;
}

function isRateLimited(from: string): boolean {
  const email = from.toLowerCase().trim();
  const now = Date.now();
  const timestamps = rateLimitMap.get(email) || [];

  // Remove entries outside the window
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(email, recent);

  return recent.length >= RATE_LIMIT_MAX;
}

function recordSubmission(from: string): void {
  const email = from.toLowerCase().trim();
  const timestamps = rateLimitMap.get(email) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(email, timestamps);
}

/**
 * Classify email intent from subject line
 */
function classifyIntent(subject: string): { task_type: string; layer: string } {
  const s = subject.toLowerCase();

  if (/\b(bug|error|broken|crash|fail|fix|issue|problem)\b/.test(s)) {
    return { task_type: 'BUG', layer: 'DEV' };
  }
  if (/\b(feature|add|new|request|create|build)\b/.test(s)) {
    return { task_type: 'FEATURE', layer: 'DEV' };
  }
  if (/\b(improve|enhance|update|change|refactor|optimize)\b/.test(s)) {
    return { task_type: 'IMPROVEMENT', layer: 'DEV' };
  }

  return { task_type: 'IDEA', layer: 'DEV' };
}

/**
 * Auto-generate and validate spec (fire-and-forget)
 * Reuses the same spec pipeline as task-intake-service
 */
async function autoGenerateSpec(vtid: string, seedNotes: string): Promise<void> {
  const gatewayUrl = process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;

  try {
    const genResp = await fetch(`${gatewayUrl}/api/v1/specs/${vtid}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed_notes: seedNotes, source: 'email-intake-auto' })
    });

    if (!genResp.ok) {
      console.warn(`${LOG_PREFIX} Auto-generate spec failed for ${vtid}: ${genResp.status}`);
      return;
    }

    const valResp = await fetch(`${gatewayUrl}/api/v1/specs/${vtid}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!valResp.ok) {
      console.warn(`${LOG_PREFIX} Auto-validate spec failed for ${vtid}: ${valResp.status}`);
      return;
    }

    console.log(`${LOG_PREFIX} Auto-spec complete for ${vtid} (awaiting human approval)`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Auto-spec error for ${vtid}:`, err);
  }
}

// =============================================================================
// Routes
// =============================================================================

/**
 * POST /email
 * Receives email from Cloudflare Email Worker and creates a scheduled task
 */
router.post('/email', async (req: Request, res: Response) => {
  try {
    const { from, to, subject, text, received_at } = req.body || {};

    // Validate required fields
    if (!from || !subject) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_FIELDS',
        message: 'from and subject are required',
      });
    }

    // Authenticate worker (if secret configured)
    if (EMAIL_WORKER_SECRET) {
      const workerSecret = req.headers['x-email-worker-secret'] as string;
      if (workerSecret !== EMAIL_WORKER_SECRET) {
        console.warn(`${LOG_PREFIX} Unauthorized request (invalid worker secret)`);
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
    }

    // Check sender allowlist
    if (!isSenderAllowed(from)) {
      console.warn(`${LOG_PREFIX} Sender not allowed: ${from}`);
      return res.status(403).json({
        ok: false,
        error: 'SENDER_NOT_ALLOWED',
        message: `Sender ${from} is not authorized to create tasks via email`,
      });
    }

    // Check rate limit
    if (isRateLimited(from)) {
      console.warn(`${LOG_PREFIX} Rate limited: ${from}`);
      return res.status(429).json({
        ok: false,
        error: 'RATE_LIMITED',
        message: `Too many submissions from ${from}. Max ${RATE_LIMIT_MAX} per hour.`,
      });
    }

    // Classify intent
    const { task_type, layer } = classifyIntent(subject);

    // Build task title with system area prefix
    const rawSubject = subject.replace(/^(Re:|Fwd?:|Bug:|Feature:|Improvement:)\s*/gi, '').trim();
    const area = guessAreaFromText(rawSubject + ' ' + (text || ''));
    const taskTitle = buildTitle(area, rawSubject);
    const taskDescription = text
      ? `${taskTitle}\n\n${text}`
      : taskTitle;

    console.log(`${LOG_PREFIX} Processing email: from=${from} type=${task_type} subject="${taskTitle}"`);

    // Allocate VTID
    const allocResult = await allocateVtid('email-intake', layer, 'COMHU');
    let vtid: string;

    if (!allocResult.ok || !allocResult.vtid) {
      vtid = `VTID-${Date.now().toString().slice(-5)}`;
      console.warn(`${LOG_PREFIX} Allocator failed, using fallback: ${vtid}`);
    } else {
      vtid = allocResult.vtid;
    }

    // Create task in vtid_ledger
    const scheduleResult = await ensureScheduledDevTask({
      vtid,
      header: taskTitle,
      spec_text: taskDescription,
      tenant: 'vitana',
    });

    if (!scheduleResult.ok) {
      console.error(`${LOG_PREFIX} Task creation failed for ${vtid}: ${scheduleResult.error}`);
      return res.status(500).json({
        ok: false,
        error: 'TASK_CREATION_FAILED',
        message: scheduleResult.error,
      });
    }

    // Record submission for rate limiting
    recordSubmission(from);

    // Auto-generate spec (fire-and-forget)
    autoGenerateSpec(vtid, taskDescription).catch(err => {
      console.warn(`${LOG_PREFIX} Auto-spec failed for ${vtid} (non-blocking): ${err}`);
    });

    // Emit OASIS event
    await emitOasisEvent({
      vtid,
      type: 'email.intake.task_created' as any,
      source: 'email-intake',
      status: 'success',
      message: `Task created from email: ${taskTitle}`,
      payload: {
        vtid,
        task_type,
        sender: from,
        recipient: to,
        subject: subject,
        received_at: received_at || new Date().toISOString(),
        classification: { task_type, layer },
      },
    });

    console.log(`${LOG_PREFIX} Task created: ${vtid} (type=${task_type}) from ${from}`);

    return res.status(201).json({
      ok: true,
      vtid,
      task_type,
      title: taskTitle,
      message: `Task ${vtid} created from email (type: ${task_type})`,
    });

  } catch (err: any) {
    console.error(`${LOG_PREFIX} Unexpected error:`, err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

/**
 * GET /email/health
 * Health check for email intake
 */
router.get('/email/health', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'email-intake',
    allowlist_configured: SENDER_ALLOWLIST.length > 0,
    allow_domain: ALLOW_DOMAIN || null,
    worker_secret_configured: !!EMAIL_WORKER_SECRET,
  });
});

export { router as emailIntakeRouter };
