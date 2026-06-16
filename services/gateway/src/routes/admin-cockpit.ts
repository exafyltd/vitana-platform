/**
 * Intelligence Cockpit spine — Phase 1 W3-D1 PR 5 (VTID-03247).
 *
 * Read-only admin endpoint that backs the single-page Intelligence
 * Cockpit at /command-hub/intelligence-cockpit.html. Pulls the most
 * recent runs of the cron workflows that drive Phase 1 W3 (dataset
 * extraction, trainer submission, context source inventory, context
 * quality score, etc.) so the operator can see, on one page, whether
 * the assistant intelligence loop's input pipeline is healthy.
 *
 * GET /api/v1/admin/cockpit/training-status
 *   → { ok, generated_at, workflows: WorkflowRunSummary[] }
 *
 * No mutation. No production behavior change. requireAdminAuth.
 *
 * Follow-up PRs will add:
 *   - GET /api/v1/admin/cockpit/context-quality       (consumes PR 2 artifact)
 *   - GET /api/v1/admin/cockpit/role-registry-shadow  (consumes PR 4 emits)
 *   - GET /api/v1/admin/cockpit/self-healing          (consumes self-heal feed)
 * Each panel on the cockpit page already has a placeholder pointing at
 * the planned endpoint id.
 */

import { Router, Request, Response } from 'express';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getWorkflowRuns } from '../services/github-service';

const router = Router();

const REPO = 'exafyltd/vitana-platform';

interface WorkflowDescriptor {
  id: string;         // workflow file name (e.g. 'CRON-FINETUNE-TRAINER.yml')
  label: string;
  category: 'dataset' | 'training' | 'context';
}

const WORKFLOWS: WorkflowDescriptor[] = [
  { id: 'CRON-DATASET-EXTRACTION.yml',       label: 'Consented dataset extraction', category: 'dataset' },
  { id: 'CRON-FINETUNE-TRAINER.yml',         label: 'Vertex trainer submission',    category: 'training' },
  { id: 'DESCRIBE-VERTEX-CUSTOMJOB.yml',     label: 'Vertex CustomJob describe',    category: 'training' },
  { id: 'CRON-CONTEXT-SOURCE-INVENTORY.yml', label: 'Context source inventory',     category: 'context' },
  { id: 'CRON-CONTEXT-QUALITY-SCORE.yml',    label: 'Context quality score',        category: 'context' },
];

interface WorkflowRunSummary {
  id: string;
  label: string;
  category: WorkflowDescriptor['category'];
  available: boolean;
  latest_run_id: number | null;
  status: string | null;
  conclusion: string | null;
  created_at: string | null;
  html_url: string | null;
  error: string | null;
}

async function fetchWorkflowSummary(wf: WorkflowDescriptor): Promise<WorkflowRunSummary> {
  try {
    const runs = await getWorkflowRuns(REPO, wf.id);
    const latest = runs.workflow_runs?.[0];
    if (!latest) {
      return {
        id: wf.id,
        label: wf.label,
        category: wf.category,
        available: true,
        latest_run_id: null,
        status: null,
        conclusion: null,
        created_at: null,
        html_url: null,
        error: 'no_runs_yet',
      };
    }
    return {
      id: wf.id,
      label: wf.label,
      category: wf.category,
      available: true,
      latest_run_id: latest.id,
      status: latest.status,
      conclusion: latest.conclusion,
      created_at: latest.created_at,
      html_url: latest.html_url,
      error: null,
    };
  } catch (err) {
    return {
      id: wf.id,
      label: wf.label,
      category: wf.category,
      available: false,
      latest_run_id: null,
      status: null,
      conclusion: null,
      created_at: null,
      html_url: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

router.get('/training-status', requireAdminAuth, async (req: Request, res: Response) => {
  const _auth = req as AuthenticatedRequest; // requireAdminAuth has validated identity
  void _auth;
  try {
    const workflows = await Promise.all(WORKFLOWS.map(fetchWorkflowSummary));
    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      workflows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: 'training_status_failed', message });
  }
});

export default router;
