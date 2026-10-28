#!/usr/bin/env node
/**
 * VTID-04324 / VTID-04327 — the exhaustive allowlist for
 * AWS-OPS-ECS-SCALE-UNGOVERNED.yml, and the input validation that runs
 * BEFORE any AWS call.
 *
 * The 23 services are the 2026-07-09 bulk-provisioning orphans named in
 * docs/AURORA-MIGRATION-STATUS-2026-09-10.md (2026-09-11 roster addendum):
 * no source of record, no ALB target group, no Cloud Map, no deploy
 * pipeline. vitana-worker-runner is retired by VTID-04327.
 *
 * Deliberately absent, and refused if asked for: every service that serves
 * traffic or is governed — vitana-gateway(-awsdr), vitana-community-app-awsdr,
 * vitana-community-app-staging, vitana-oasis-operator-awsdr,
 * vitana-oasis-projector, vitana-orb-agent, vitana-erp-bridge,
 * vitana-postgrest-aurora-proxy, vitana-vitana-verification-engine.
 * Note the name trap: bare `vitana-community-app` and `vitana-oasis-operator`
 * ARE orphans; their `-awsdr` / `-staging` namesakes are production.
 */

'use strict';

const UNGOVERNED_JULY9 = Object.freeze([
  'vitana-auth-proxy',
  'vitana-conductor',
  'vitana-planner-core',
  'vitana-validator-core',
  'vitana-qa-agent',
  'vitana-worker-core',
  'vitana-cognee-extractor',
  'vitana-oasis-approval',
  'vitana-test-agent',
  'vitana-dev-console-ui',
  'vitana-github-sync-service',
  'vitana-cloudshell-relay',
  'vitana-mcp-gateway',
  'vitana-oasis-mcp-v2',
  'vitana-vitana-dev-gateway',
  'vitana-memory-indexer',
  'vitana-vitana-memory-indexer',
  'vitana-openclaw-bridge',
  'vitana-crewai-kb-agent',
  'vitana-crewai-prompt-synth',
  'vitana-lifetime-context-crew',
  'vitana-community-app',
  'vitana-oasis-operator',
]);

const RETIRED = Object.freeze(['vitana-worker-runner']);

const ALLOWLIST = Object.freeze([...UNGOVERNED_JULY9, ...RETIRED]);

function resolveTargets(servicesInput, desiredInput) {
  const desired = String(desiredInput ?? '').trim();
  if (desired !== '0' && desired !== '1') {
    return { ok: false, error: `desired_count must be 0 or 1, got "${desired}"` };
  }
  const raw = String(servicesInput ?? '').trim();
  if (!raw) return { ok: false, error: 'services is empty' };
  const requested = raw === 'all'
    ? [...ALLOWLIST]
    : raw.split(',').map((s) => s.trim()).filter(Boolean);
  const refused = requested.filter((s) => !ALLOWLIST.includes(s));
  if (refused.length) {
    return { ok: false, error: `not in the allowlist, refused: ${refused.join(', ')}` };
  }
  return { ok: true, targets: [...new Set(requested)], desired: Number(desired) };
}

module.exports = { ALLOWLIST, UNGOVERNED_JULY9, RETIRED, resolveTargets };

if (require.main === module) {
  const r = resolveTargets(process.env.SERVICES_INPUT, process.env.DESIRED);
  if (!r.ok) {
    console.error(`REFUSED: ${r.error}`);
    process.exit(1);
  }
  console.log(`targets (${r.targets.length}): ${r.targets.join(' ')}`);
  if (process.env.GITHUB_OUTPUT) {
    require('fs').appendFileSync(process.env.GITHUB_OUTPUT, `targets=${r.targets.join(' ')}\n`);
  }
}
