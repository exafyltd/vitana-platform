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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  try {
    if (cmd === 'tag') {
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
