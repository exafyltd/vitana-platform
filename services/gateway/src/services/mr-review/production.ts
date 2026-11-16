/**
 * Production wiring of the review endpoint: the real Bedrock partner pass (runPartnerPass through the real
 * LLM router), the GitLab read tools, the GitLab MR reader and the AWS KMS signer. Built lazily from the
 * environment. If a required setting is missing, the factory returns null and the route answers 503.
 */
import { randomUUID } from 'node:crypto';
import { callViaRouter } from '../llm-router';
import { runPartnerPass } from '../plan-sparring/partner';
import { callerAuthorizer } from '../../routes/mr-review';
import { gitlabMrReader, gitlabToolExecutor, type FetchLike } from './gitlab-reader';
import { KmsEcdsaSigner } from './kms-signer';
import { createKmsSend } from './kms-client';
import type { ReviewEndpointDeps } from './endpoint';
import type { RunPass } from './bedrock-reviewer';

export interface ProductionEnv {
  MR_REVIEW_CALLER_TOKEN?: string;
  MR_REVIEW_GITLAB_API?: string;
  MR_REVIEW_GITLAB_READ_TOKEN?: string;
  MR_REVIEW_GITLAB_PROJECT?: string;
  MR_REVIEW_KMS_KEY_ID?: string;
  MR_REVIEW_REVIEWER?: string;
  AWS_REGION?: string;
}

export async function buildProductionReviewDeps(env: ProductionEnv, fetchImpl: FetchLike): Promise<ReviewEndpointDeps | null> {
  const required = ['MR_REVIEW_CALLER_TOKEN', 'MR_REVIEW_GITLAB_API', 'MR_REVIEW_GITLAB_READ_TOKEN', 'MR_REVIEW_GITLAB_PROJECT', 'MR_REVIEW_KMS_KEY_ID'] as const;
  if (required.some((k) => !env[k])) return null;
  const cfg = { apiBase: env.MR_REVIEW_GITLAB_API as string, token: env.MR_REVIEW_GITLAB_READ_TOKEN as string, projectPath: env.MR_REVIEW_GITLAB_PROJECT as string, fetch: fetchImpl };
  const kms = await createKmsSend({ region: env.AWS_REGION ?? 'eu-central-1' });
  const runPass: RunPass = (input) => runPartnerPass({
    round: input.round,
    prompt: input.prompt,
    callLlm: callViaRouter,
    executeTool: gitlabToolExecutor({ ...cfg, projectPath: input.project }, input.headSha),
    deadlineMs: input.deadlineMs,
  }).then((r) => (r.ok ? { ok: true as const, review: r.review as never } : { ok: false as const, reason: r.reason, error: r.error }));
  return {
    authorize: callerAuthorizer(env.MR_REVIEW_CALLER_TOKEN),
    readerFor: () => gitlabMrReader(cfg),
    runPass,
    signer: new KmsEcdsaSigner({ kms, keyId: env.MR_REVIEW_KMS_KEY_ID as string }),
    project: cfg.projectPath,
    reviewer: env.MR_REVIEW_REVIEWER ?? 'bedrock-plan-sparring',
    model: 'bedrock-plan-sparring',
    now: () => new Date(),
  };
}

void randomUUID;
