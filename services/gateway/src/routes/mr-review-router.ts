/**
 * The mounted POST /api/v1/mr-review router (index.ts mounts it under /api/v1). Dependencies are built
 * once, on the first request, from the environment. A missing setting or a failed build answers 503.
 */
import { Router } from 'express';
import { createMrReviewRouter } from './mr-review';
import { buildProductionReviewDeps, type ProductionEnv } from '../services/mr-review/production';
import type { ReviewEndpointDeps } from '../services/mr-review/endpoint';

let cached: Promise<ReviewEndpointDeps | null> | null = null;

function deps(): Promise<ReviewEndpointDeps | null> {
  if (!cached) {
    cached = buildProductionReviewDeps(process.env as ProductionEnv, globalThis.fetch as never).catch(() => null);
  }
  return cached;
}

export default createMrReviewRouter(() => Router() as never, deps);
