#!/usr/bin/env node
// VTID-05546 — push the OCI archive of `.build-image` to the service's staging ECR repository and record its digest
// (plan agentic-delivery §3.6 step 2: `push-image`, deploy class).
//
//   push-image.mjs --service <svc> --repository <ecr repo> --archive image.oci.tar --sha <sha>
//                  [--mode live|shadow] [--out push-image.json]
//
// Refuses a target outside the service's own ECR repository (plan §3.10, §7). The tag is the 12-character commit in
// live mode and `shadow-<sha12>` in shadow mode (plan §8.1 step 3), so a shadow run never writes a tag a staging
// deploy uses. The registry CLI is skopeo (no Docker daemon); the ECR password goes to it on stdin, never as an
// argument. Output: push-image.json {service, registry, repository, tag, digest, image, mode}; the deploy job deploys
// `image` (by digest).

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REGISTRY, DeployError, target, isFullSha, defaultRunner, aws, assertIdentity, writeJson, parseArgs } from './lib.mjs';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function imageTag(sha, mode) {
  const short = sha.slice(0, 12);
  return mode === 'live' ? short : `shadow-${short}`;
}

export function pushImage(o, deps = {}) {
  const run = deps.run || defaultRunner;
  const log = deps.log || ((m) => console.log(m));
  const t = target(o.service);
  const registry = o.registry || REGISTRY;
  if (registry !== REGISTRY || o.repository !== t.ecrRepository) {
    throw new DeployError(`push target ${registry}/${o.repository} is outside ${o.service}'s ECR repository ${REGISTRY}/${t.ecrRepository}: refused`, 2);
  }
  if (!isFullSha(o.sha)) throw new DeployError(`--sha must be a full commit SHA, got '${o.sha}'`, 2);
  if (!o.archive || !existsSync(o.archive)) throw new DeployError(`image archive not found: ${o.archive}`, 2);
  const mode = o.mode === 'live' ? 'live' : 'shadow';
  const tag = imageTag(o.sha, mode);
  const ref = `${REGISTRY}/${t.ecrRepository}:${tag}`;

  assertIdentity(run, t.role);
  const password = String(aws(run, ['ecr', 'get-login-password'], { json: false })).trim();
  if (!password) throw new DeployError('ecr get-login-password returned nothing');
  const login = run('skopeo', ['login', '--username', 'AWS', '--password-stdin', REGISTRY], { input: password });
  if (login.code !== 0) throw new DeployError(`skopeo login to ${REGISTRY} failed: ${String(login.stderr).trim().split('\n').pop()}`);

  const digestFile = join(o.workDir || mkdtempSync(join(tmpdir(), 'push-image-')), 'digest');
  const copy = run('skopeo', ['copy', '--retry-times', '2', '--digestfile', digestFile, `oci-archive:${o.archive}`, `docker://${ref}`]);
  if (copy.code !== 0) throw new DeployError(`skopeo copy to ${ref} failed: ${String(copy.stderr).trim().split('\n').pop()}`);
  const digest = existsSync(digestFile) ? readFileSync(digestFile, 'utf8').trim() : '';
  if (!DIGEST_RE.test(digest)) throw new DeployError(`skopeo reported no image digest for ${ref}`);

  const out = { service: o.service, registry: REGISTRY, repository: t.ecrRepository, tag, digest, image: `${REGISTRY}/${t.ecrRepository}@${digest}`, mode };
  if (o.out) writeJson(o.out, out);
  log(`pushed ${ref} digest=${digest}`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = parseArgs(process.argv.slice(2));
  const env = process.env;
  try {
    pushImage({
      service: a.service || env.DEPLOY_SERVICE,
      repository: a.repository || env.DEPLOY_ECR_REPOSITORY,
      archive: a.archive || 'image.oci.tar',
      sha: a.sha || env.CI_COMMIT_SHA,
      mode: a.mode || env.DELIVERY_MODE,
      out: a.out || 'push-image.json',
    });
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(e instanceof DeployError ? e.exitCode : 1);
  }
}
