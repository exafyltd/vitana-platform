// Preview build for one exact PR head (gateway only). Pure decisions live here so they can be tested without
// a registry or a runner. The CI job (infra/gitlab-engineering/ci/preview-build.gitlab-ci.yml) calls this script.
//
// Rules this module enforces:
//   - the source SHA must be a full 40-hex commit, and the checked-out HEAD must equal it exactly;
//   - the only tag ever published is shadow-<sha12> (the shadow family deploys never read);
//   - publication is refused when that tag already exists (no-clobber);
//   - nothing here names a deploy, an ECS service, a task definition or staging-latest.
//
//   preview-build.mjs tag --sha <sha>
//   preview-build.mjs verify-manifest --manifest <file> --expected <sha> --archive-sha256 <hex> --pipeline-id <id>
//   preview-build.mjs check-account --account <id>
//   preview-build.mjs verify-digest --pushed <digest> --now <digest>
//   preview-build.mjs check-source --expected <sha> --head <sha>
//   preview-build.mjs check-tag --sha <sha> --describe-exit <n> --describe-stderr <text>
//
// Exit 0 = allowed; exit 2 = refused (message on stderr).
import { pathToFileURL } from 'node:url';
import { parseArgs, DeployError, REGISTRY } from './lib.mjs';

export const PREVIEW_REPOSITORY = 'vitana/gateway';
export const PREVIEW_TAG_PREFIX = 'shadow-';
export const FORBIDDEN_TAGS = Object.freeze(['staging-latest', 'latest', 'production']);

const FULL_SHA = /^[0-9a-f]{40}$/;

export function requireFullSha(sha, label) {
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) {
    throw new DeployError(`${label} must be a full lowercase 40-hex commit SHA, got '${sha}'`, 2);
  }
  return sha;
}

// The exact source check: the built HEAD must be the intended PR head. No substitution, no fallback.
export function checkSource({ expected, head }) {
  requireFullSha(expected, 'PREVIEW_SOURCE_SHA');
  requireFullSha(head, 'checked-out HEAD');
  if (expected !== head) {
    throw new DeployError(`checked-out HEAD ${head} is not the requested source ${expected}: refusing to build a substitute`, 2);
  }
  return { source: head };
}

export function previewTag(sha) {
  requireFullSha(sha, 'source SHA');
  const tag = `${PREVIEW_TAG_PREFIX}${sha.slice(0, 12)}`;
  if (FORBIDDEN_TAGS.includes(tag) || !tag.startsWith(PREVIEW_TAG_PREFIX)) {
    throw new DeployError(`tag '${tag}' is outside the preview family`, 2);
  }
  return tag;
}

// Decide from the outcome of `aws ecr describe-images --image-ids imageTag=<tag>`.
// Exit 0 means the tag exists. A "not found" error means it is free. Any other failure is treated as unknown
// and refused, because a publish must never proceed on an answer that might be wrong.
export function noClobberDecision({ tag, describeExit, describeStderr = '' }) {
  if (describeExit === 0) {
    throw new DeployError(`tag ${PREVIEW_REPOSITORY}:${tag} already exists: refusing to overwrite`, 2);
  }
  if (/ImageNotFound|The image requested does not exist|requested image not found/i.test(describeStderr)) {
    return { publish: true, tag };
  }
  throw new DeployError(`cannot verify that ${tag} is free (describe-images failed: ${describeStderr.trim().split('\n').pop() || 'no detail'}): refusing to publish`, 2);
}

export function publishTarget(tag) {
  if (!tag.startsWith(PREVIEW_TAG_PREFIX)) throw new DeployError(`refusing to publish '${tag}' outside ${PREVIEW_TAG_PREFIX}`, 2);
  return `${REGISTRY}/${PREVIEW_REPOSITORY}:${tag}`;
}

// ---- artifact binding, account pin and digest checks (publish side, trusted code) -------------------------------

export const PREVIEW_ACCOUNT = '472838866351';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ECR_DIGEST = /^sha256:[0-9a-f]{64}$/;

// The manifest is written by the build job. The build job runs unmerged code, so the manifest is a binding for
// the publisher's checks, not a trust anchor: the publisher trusts only that the artifact came from this pipeline
// and this exact source, and that its bytes are the bytes it hashed.
export function verifyManifest({ manifest, expectedSource, archiveSha256, pipelineId }) {
  requireFullSha(expectedSource, 'PREVIEW_SOURCE_SHA');
  if (!SHA256_HEX.test(String(archiveSha256 || ''))) throw new DeployError('archive sha256 must be 64 lowercase hex', 2);
  if (!manifest || typeof manifest !== 'object') throw new DeployError('preview manifest is missing or not an object', 2);
  if (manifest.source_sha !== expectedSource) {
    throw new DeployError(`manifest source ${manifest.source_sha} is not the requested source ${expectedSource}: refusing to publish`, 2);
  }
  if (manifest.archive_sha256 !== archiveSha256) {
    throw new DeployError('archive sha256 does not match the manifest: the artifact was altered between build and publish', 2);
  }
  if (String(manifest.pipeline_id) !== String(pipelineId)) {
    throw new DeployError(`manifest pipeline ${manifest.pipeline_id} is not this pipeline ${pipelineId}: refusing foreign artifact`, 2);
  }
  return { source: expectedSource, archive_sha256: archiveSha256 };
}

export function checkAccount(account) {
  if (account !== PREVIEW_ACCOUNT) {
    throw new DeployError(`caller account ${account} is not ${PREVIEW_ACCOUNT}: refusing to publish`, 2);
  }
  return account;
}

// After the push, the tag must point at the digest the push reported. A different digest means someone else wrote
// the tag in the window between the no-clobber check and the push, so the publish is a failure, not a success.
export function verifyPublishedDigest({ pushed, now }) {
  if (!ECR_DIGEST.test(String(pushed || ''))) throw new DeployError('pushed digest is not a sha256 digest', 2);
  if (pushed !== now) throw new DeployError(`tag digest is now ${now}, not the pushed ${pushed}: the tag was overwritten during publish`, 1);
  return { digest: pushed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  try {
    if (cmd === 'verify-manifest') {
      const { readFileSync } = await import('node:fs');
      const manifest = JSON.parse(readFileSync(a.manifest, 'utf8'));
      verifyManifest({ manifest, expectedSource: a.expected, archiveSha256: a['archive-sha256'], pipelineId: a['pipeline-id'] });
      console.log(`manifest ok: ${a.expected}`);
    } else if (cmd === 'check-account') {
      checkAccount(a.account);
      console.log(`account ok: ${a.account}`);
    } else if (cmd === 'verify-digest') {
      verifyPublishedDigest({ pushed: a.pushed, now: a.now });
      console.log(`digest ok: ${a.now}`);
    } else if (cmd === 'tag') {
      console.log(previewTag(a.sha));
    } else if (cmd === 'check-source') {
      checkSource({ expected: a.expected, head: a.head });
      console.log(`source ok: ${a.head}`);
    } else if (cmd === 'check-tag') {
      const tag = previewTag(a.sha);
      const d = noClobberDecision({ tag, describeExit: Number(a['describe-exit']), describeStderr: a['describe-stderr'] || '' });
      console.log(`publish allowed: ${publishTarget(d.tag)}`);
    } else {
      throw new DeployError(`unknown command '${cmd}'`, 2);
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(e instanceof DeployError ? e.exitCode : 1);
  }
}
