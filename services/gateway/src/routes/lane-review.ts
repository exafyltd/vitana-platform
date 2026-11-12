/**
 * Bedrock lane reviewer — gateway route. Mounted at /api/v1/lane-review.
 *
 *   POST /   review one lane PR's diff; returns the verdict and the model that gave it
 *
 * Auth: GATEWAY_SERVICE_TOKEN or an exafy_admin JWT (requireServiceOrAdmin, same as /plans/spar).
 * Read-only: no database writes, no GitHub writes, no merge. The caller (CI) records the verdict.
 * impact-allow-no-oasis: the review result is returned to the caller; OASIS events are not used for lane reviews.
 */
import { Router, Request, Response } from 'express';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import { invokeBedrock } from '../providers/bedrock';
import { runLaneReview, type CallReviewModel, type LaneReviewInput } from '../services/lane-review/review-pass';
import { LANE_REVIEW_TOOL_NAME } from '../services/lane-review/prompt';

const MAX_DIFF_CHARS = 400_000;

/** Validate the request body. Returns the input, or a string naming the first problem. */
export function parseLaneReviewBody(body: unknown): LaneReviewInput | string {
  if (!body || typeof body !== 'object') return 'body_required';
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : null);
  const repo = str('repo');
  const headSha = str('head_sha');
  const laneKey = str('lane_key');
  const acceptance = str('acceptance');
  const diff = str('diff');
  const pr = typeof b.pr === 'number' && Number.isInteger(b.pr) && b.pr > 0 ? b.pr : null;
  const changedFiles = Array.isArray(b.changed_files) && b.changed_files.every((f) => typeof f === 'string') ? (b.changed_files as string[]) : null;
  if (!repo) return 'repo_required';
  if (pr === null) return 'pr_required';
  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) return 'head_sha_invalid';
  if (!laneKey) return 'lane_key_required';
  if (acceptance === null) return 'acceptance_required';
  if (diff === null) return 'diff_required';
  if (diff.length > MAX_DIFF_CHARS) return 'diff_too_large';
  if (!changedFiles) return 'changed_files_required';
  return { repo, pr, headSha, laneKey, acceptance, diff, changedFiles };
}

/** Production model call: one forced submit_lane_review tool call on Bedrock. */
export const bedrockCallReviewModel: CallReviewModel = async ({ model, system, userText, tool }) => {
  const r = await invokeBedrock({
    model: model.profile,
    system,
    messages: [{ role: 'user', content: userText }],
    tools: [tool],
    tool_choice: { type: 'tool', name: LANE_REVIEW_TOOL_NAME },
    max_tokens: 8000,
  });
  if (!r.ok) return { ok: false, error: `${r.error}: ${r.message}` };
  if (!r.toolCall || r.toolCall.name !== LANE_REVIEW_TOOL_NAME) return { ok: false, error: 'no submit_lane_review call' };
  return { ok: true, toolInput: r.toolCall.arguments };
};

export function createLaneReviewRouter(callModel: CallReviewModel = bedrockCallReviewModel): Router {
  const router = Router();
  router.post('/', requireServiceOrAdmin, async (req: Request, res: Response) => {
    const input = parseLaneReviewBody(req.body);
    if (typeof input === 'string') return res.status(400).json({ ok: false, error: input });
    try {
      const result = await runLaneReview(input, callModel);
      if (!result.ok) return res.status(503).json(result);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[lane-review] unexpected error:', err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });
  return router;
}

export const laneReviewRouter = createLaneReviewRouter();
export default laneReviewRouter;
