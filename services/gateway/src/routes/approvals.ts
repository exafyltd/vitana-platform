/**
 * VTID-01148: Approvals API v1 — Pending Queue + Count + Approve/Reject
 * VTID-01154: GitHub-Authoritative Feed (SPEC-02)
 *
 * Gateway-only routes for human approval layer activation.
 * Derives approval items from vtid_ledger + OASIS events (existing signals).
 *
 * Endpoints:
 * - GET /api/v1/approvals/count → { ok: true, pending_count: number }
 * - GET /api/v1/approvals/pending?limit=50 → { ok: true, items: ApprovalItem[] }
 * - GET /api/v1/approvals/feed?limit=50 → { ok: true, items: GitHubFeedItem[] } (VTID-01154)
 * - POST /api/v1/approvals/:approval_id/approve → triggers safe merge, returns { ok, result }
 * - POST /api/v1/approvals/:approval_id/reject → records rejection, returns { ok }
 *
 * The list/count/approve/reject logic itself lives in
 * services/approvals-service.ts (VTID-04279) — see that file's header for
 * why (the Operator Console's Developer Assistant tools call it in-process
 * instead of over HTTP).
 */

import { Router, Request, Response } from 'express';
import { listOpenPrsWithStatus } from '../services/github-service';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  getPendingApprovalCount,
  getPendingApprovals,
  approveApprovalById,
  rejectApprovalById,
  emitApprovalDecision,
} from '../services/approvals-service';

const router = Router();

// SECURITY (VTID-04279): every route below can either read cross-VTID
// approval/PR state or, on the write routes, trigger a real GitHub PR merge
// (POST /:approval_id/approve calls the internal autonomous-pr-merge
// endpoint with automerge:true — the ONLY input from the caller is the
// approval_id in the URL, and the trailing hash suffix was never validated,
// so any caller who could guess/enumerate a VTID number could merge its PR).
// This router previously had NO auth at all. requireAdminAuth verifies the
// JWT signature and requires app_metadata.exafy_admin, matching the pattern
// admin-navigator.ts / feedback-admin.ts / specialists-admin.ts already use.
router.use(requireAdminAuth);

/**
 * GET /count
 * Returns the count of pending approval items
 */
router.get('/count', async (_req: Request, res: Response) => {
  const { status, body } = await getPendingApprovalCount();
  return res.status(status).json(body);
});

/**
 * GET /pending
 * Returns the list of pending approval items
 * Query params:
 * - limit: number (default 50, max 100)
 */
router.get('/pending', async (req: Request, res: Response) => {
  const limitParam = req.query.limit as string | undefined;
  let limit = 50;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed >= 1) {
      limit = Math.min(parsed, 100);
    }
  }
  const { status, body } = await getPendingApprovals(limit);
  return res.status(status).json(body);
});

/**
 * VTID-01154: GET /feed
 * GitHub-Authoritative Feed (SPEC-02)
 *
 * Returns live PR data pulled directly from GitHub.
 * This is the source of truth for approvals - no internal state invention.
 *
 * Query params:
 * - limit: number (default 50, max 100)
 * - repo: string (default 'exafyltd/vitana-platform')
 *
 * Response:
 * - repo: string
 * - pr_number: number
 * - branch: string
 * - commit_sha: string
 * - ci_state: 'pass' | 'fail' | 'running'
 * - mergeable: boolean
 * - vtid: string | null (parsed from branch or PR title, null if not found)
 * - updated_at: string (ISO timestamp)
 */
router.get('/feed', async (req: Request, res: Response) => {
  try {
    // Parse query parameters
    const limitParam = req.query.limit as string | undefined;
    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        limit = Math.min(parsed, 100);
      }
    }

    const repo = (req.query.repo as string) || 'exafyltd/vitana-platform';

    console.log(`[VTID-01154] /feed: fetching GitHub PRs (repo=${repo}, limit=${limit})`);

    // Fetch live data from GitHub - this is the authoritative source
    const items = await listOpenPrsWithStatus(repo, limit);

    console.log(`[VTID-01154] /feed: returning ${items.length} items from GitHub`);

    return res.status(200).json({
      ok: true,
      items,
      source: 'github', // Indicate this is GitHub-authoritative
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01154] /feed error: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: errorMessage,
      items: [],
    });
  }
});

/**
 * VTID-01154: POST /feed/approve
 * Approve a PR directly from the GitHub feed
 *
 * Request body:
 * - pr_number: number (required)
 * - repo: string (default 'exafyltd/vitana-platform')
 * - branch: string (required - head branch for merge)
 * - vtid: string | null (optional - for OASIS event logging)
 *
 * Pre-conditions enforced:
 * - CI must be passing (ci_state = 'pass')
 * - PR must be mergeable (mergeable = true)
 */
router.post('/feed/approve', async (req: Request, res: Response) => {
  try {
    const { pr_number, repo = 'exafyltd/vitana-platform', branch, vtid } = req.body;

    if (!pr_number || typeof pr_number !== 'number') {
      return res.status(400).json({
        ok: false,
        error: 'pr_number is required and must be a number',
      });
    }

    if (!branch || typeof branch !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'branch is required',
      });
    }

    console.log(`[VTID-01154] /feed/approve: PR #${pr_number} (branch=${branch}, repo=${repo})`);

    // Verify CI and mergeability by fetching fresh data from GitHub
    const feedItems = await listOpenPrsWithStatus(repo, 100);
    const prItem = feedItems.find(item => item.pr_number === pr_number);

    if (!prItem) {
      return res.status(404).json({
        ok: false,
        error: `PR #${pr_number} not found in open PRs`,
      });
    }

    // SPEC-02: Approve button only when CI = pass AND mergeable = true
    if (prItem.ci_state !== 'pass') {
      return res.status(400).json({
        ok: false,
        error: `Cannot approve: CI is ${prItem.ci_state}, must be 'pass'`,
      });
    }

    if (!prItem.mergeable) {
      return res.status(400).json({
        ok: false,
        error: 'Cannot approve: PR is not mergeable',
      });
    }

    // Call existing autonomous-pr-merge endpoint
    const gatewayUrl = process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
    const mergePayload = {
      vtid: vtid || prItem.vtid || `PR-${pr_number}`,
      head_branch: branch,
      base_branch: 'main',
      title: `Merge PR #${pr_number}`,
      body: `Approved via GitHub Feed (VTID-01154)`,
      merge_method: 'squash',
      automerge: true,
    };

    console.log(`[VTID-01154] Calling autonomous-pr-merge for PR #${pr_number}`);

    const mergeResponse = await fetch(`${gatewayUrl}/api/v1/github/autonomous-pr-merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mergePayload),
    });

    const mergeResult = await mergeResponse.json() as {
      ok: boolean;
      merged?: boolean;
      error?: string;
      [key: string]: unknown;
    };

    // Emit OASIS event if VTID is available
    if (vtid || prItem.vtid) {
      await emitApprovalDecision(
        vtid || prItem.vtid || `PR-${pr_number}`,
        `feed_pr_${pr_number}`,
        'approved',
        {
          pr_number,
          branch,
          repo,
          merge_result: mergeResult,
          source: 'github_feed',
        },
        (req as AuthenticatedRequest).identity?.user_id ?? null
      );
    }

    if (mergeResult.ok) {
      console.log(`[VTID-01154] Feed approval successful for PR #${pr_number}: merged=${mergeResult.merged}`);
      return res.status(200).json({
        ok: true,
        result: mergeResult,
      });
    } else {
      console.error(`[VTID-01154] Feed approval merge failed for PR #${pr_number}: ${mergeResult.error}`);
      return res.status(mergeResponse.status).json({
        ok: false,
        error: mergeResult.error || 'Merge failed',
        result: mergeResult,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01154] /feed/approve error: ${errorMessage}`);
    return res.status(500).json({
      ok: false,
      error: errorMessage,
    });
  }
});

/**
 * POST /:approval_id/approve
 * Triggers safe merge for the approval item
 * Uses existing autonomous-pr-merge endpoint
 */
router.post('/:approval_id/approve', async (req: Request, res: Response) => {
  const { approval_id } = req.params;
  const decidedBy = (req as AuthenticatedRequest).identity?.user_id ?? null;
  const { status, body } = await approveApprovalById(approval_id, decidedBy);
  return res.status(status).json(body);
});

/**
 * POST /:approval_id/reject
 * Records rejection for the approval item
 */
router.post('/:approval_id/reject', async (req: Request, res: Response) => {
  const { approval_id } = req.params;
  const { reason } = req.body || {};
  const decidedBy = (req as AuthenticatedRequest).identity?.user_id ?? null;
  const { status, body } = await rejectApprovalById(approval_id, reason, decidedBy);
  return res.status(status).json(body);
});

export default router;
