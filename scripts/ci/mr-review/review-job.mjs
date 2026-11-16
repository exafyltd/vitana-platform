// GitLab review job. It asks the gateway for a Bedrock review of one exact MR head, verifies the
// returned attestation itself with the pinned reviewer public key, and records the signed result as an
// MR note. The job never creates an accept of its own: an unverifiable response is a failure.
// Exit codes: 0 = verified ACCEPT, 1 = verified CHANGES_REQUESTED, 2 = failed (nothing to merge on).
import { verifyAttestation, ATTESTATION_MARKER, findingsDigest } from '../../eng/attested-review.mjs';

export const EXIT = Object.freeze({ accept: 0, changes: 1, failed: 2 });

export function attestationNote(att, findings) {
  const wrapped = { ...att, findings };
  return `${ATTESTATION_MARKER} ${Buffer.from(JSON.stringify(wrapped)).toString('base64')} -->\n` +
    `Bedrock reviewer: ${att.payload.decision} for head \`${att.payload.head_sha}\`.`;
}

export async function runMrReviewJob({ cfg, fetchFn, now = () => new Date() }) {
  const log = [];
  const say = (m) => log.push(m);
  const requestBody = { mr_iid: cfg.mrIid, expected_head_sha: cfg.headSha };
  const res = await fetchFn(`${cfg.gatewayUrl}/api/v1/mr-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.gatewayToken}`, 'x-correlation-id': cfg.correlationId },
    body: JSON.stringify(requestBody),
  });
  if (res.status !== 200) return { exit: EXIT.failed, log: [...log, `gateway answered ${res.status}`] };
  const json = await res.json();
  const att = json.attestation;
  const findings = json.verdict?.findings ?? [];
  if (!att || !att.payload) return { exit: EXIT.failed, log: [...log, 'gateway response has no attestation'] };
  // Verify the attestation ourselves, with the pinned key, for the exact MR, project and head.
  const check = verifyAttestation(att, {
    project: cfg.project,
    mr_iid: cfg.mrIid,
    head_sha: cfg.headSha,
    publicKeyPem: cfg.publicKeyPem,
    keyId: cfg.keyId,
    reviewer: cfg.reviewer,
    findings,
    now: now(),
    maxAgeMs: cfg.maxAgeMs ?? 30 * 60 * 1000,
    expectDecision: att.payload.decision,
  });
  if (!check.ok) return { exit: EXIT.failed, log: [...log, `attestation rejected: ${check.reasons.join('; ')}`] };
  if (findings.length && findingsDigest(findings) !== att.payload.findings_sha256) {
    return { exit: EXIT.failed, log: [...log, 'findings do not match the attested digest'] };
  }
  const note = await fetchFn(`${cfg.gitlabApi}/projects/${encodeURIComponent(cfg.projectId)}/merge_requests/${cfg.mrIid}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'private-token': cfg.gitlabToken },
    body: JSON.stringify({ body: attestationNote(att, findings) }),
  });
  if (note.status !== 201) return { exit: EXIT.failed, log: [...log, `could not record the attestation note (${note.status})`] };
  say(`recorded ${att.payload.decision} for ${cfg.headSha}`);
  return { exit: att.payload.decision === 'ACCEPT' ? EXIT.accept : EXIT.changes, log };
}

function configFromEnv(env) {
  const need = (k) => { if (!env[k]) throw new Error(`${k} is not set`); return env[k]; };
  return {
    gatewayUrl: need('MR_REVIEW_GATEWAY_URL'),
    gatewayToken: need('MR_REVIEW_CALLER_TOKEN'),
    gitlabApi: need('CI_API_V4_URL'),
    gitlabToken: need('MR_REVIEW_GITLAB_TOKEN'),
    projectId: need('CI_PROJECT_ID'),
    project: need('CI_PROJECT_PATH'),
    mrIid: Number(need('CI_MERGE_REQUEST_IID')),
    headSha: need('CI_COMMIT_SHA'),
    publicKeyPem: need('MR_REVIEW_PUBLIC_KEY_PEM'),
    keyId: need('MR_REVIEW_KEY_ID'),
    reviewer: need('MR_REVIEW_REVIEWER'),
    correlationId: `${env.CI_PIPELINE_ID || 'local'}-${env.CI_JOB_ID || 'local'}`,
  };
}

// CLI entry: only when run directly, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = configFromEnv(process.env);
  const r = await runMrReviewJob({ cfg, fetchFn: fetch });
  for (const line of r.log) console.log(`[mr-review] ${line}`);
  process.exit(r.exit);
}
