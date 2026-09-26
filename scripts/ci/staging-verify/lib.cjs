'use strict';
// VTID-04613 — STAGING-VERIFY: pure logic, no I/O.
//
// Everything that decides WHAT is tested, WHETHER a test is allowed, and
// WHAT the ready message says lives here, so it can be unit-tested
// (services/gateway/test/scripts/staging-verify-lib.test.ts). run.mjs does
// the I/O. Process: docs/DEPLOYMENT-PIPELINE.md, CLAUDE.md Part 1 rules 46–50.

// ── Hosts ────────────────────────────────────────────────────────────────
// Production hosts. No test ever targets these (CLAUDE.md rule 48). The only
// production read STAGING-VERIFY makes is the version stamp used to compute
// "what would ship" — see PRODUCTION_VERSION_SOURCES.
const PRODUCTION_HOSTS = new Set([
  'vitanaland.com',
  'www.vitanaland.com',
  'gateway.vitanaland.com',
  'dr-app.vitanaland.com',
  'dr-gateway.vitanaland.com',
]);

const STAGING_TARGETS = {
  gateway: 'https://preview-aws-gateway.vitanaland.com',
  frontend: 'https://preview-aws.vitanaland.com',
};

const PRODUCTION_VERSION_SOURCES = {
  gateway: 'https://gateway.vitanaland.com/api/v1/admin/build-info',
  'community-app': 'https://vitanaland.com/',
};

// ── Services ─────────────────────────────────────────────────────────────
// Deploy paths mirror the `paths:` of each service's staging deploy
// workflow. A commit that touches none of them is not part of that
// service's deployed build and needs no change suite for it.
const SERVICES = {
  gateway: {
    repo: 'exafyltd/vitana-platform',
    target: 'gateway',
    deployPaths: [
      'services/gateway/**',
      '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
    ],
  },
  'community-app': {
    repo: 'exafyltd/vitana-v1',
    target: 'frontend',
    deployPaths: [
      'src/**',
      'public/**',
      'index.html',
      'Dockerfile',
      'nginx.conf',
      'package.json',
      'package-lock.json',
      'bun.lock',
      'vite.config.ts',
      '.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml',
    ],
  },
};

// Commits at or after this instant must carry a change suite; older commits
// predate the rule and are reported as "not covered (predates the rule)"
// without failing the run — otherwise the first verification after the rule
// lands would fail on every commit already waiting for production.
const ENFORCE_SINCE = '2026-09-27T00:00:00Z';

function isProductionHost(url) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return PRODUCTION_HOSTS.has(host);
}

function assertStagingTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`staging target must be https: ${url}`);
  if (isProductionHost(url)) {
    throw new Error(`refusing to test against production host ${parsed.host} (CLAUDE.md rule 48)`);
  }
  return parsed.origin;
}

function pathMatches(file, pattern) {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

function touchesService(files, service) {
  const cfg = SERVICES[service];
  if (!cfg) throw new Error(`unknown service ${service}`);
  return files.some((f) => cfg.deployPaths.some((p) => pathMatches(f, p)));
}

function extractVtids(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\bVTID-(\d{4,5})\b/g)) {
    const v = `VTID-${m[1].padStart(5, '0')}`;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// ── Manifest ─────────────────────────────────────────────────────────────
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_METHODS = new Set(['GET', 'HEAD']);
// `existing` suites run CI-level tests (jest / vitest / an npm script); they
// never touch staging. Restricted to those shapes — a manifest is not a
// place for arbitrary shell.
const EXISTING_REF = /^(npm run [\w:.-]+|npx (jest|vitest run)( [\w./@:=-]+)*)$/;
const SAFE_PATH = /^(?!\/)(?!.*\.\.)[\w./@-]+$/;

function validateHttpTest(t, where) {
  const errors = [];
  const method = String(t.method || 'GET').toUpperCase();
  if (typeof t.path !== 'string' || !t.path.startsWith('/')) {
    errors.push(`${where}: path must start with "/"`);
  }
  if (t.target && !['gateway', 'frontend'].includes(t.target)) {
    errors.push(`${where}: target must be "gateway" or "frontend"`);
  }
  if (t.expect_status !== undefined && !Number.isInteger(t.expect_status)) {
    errors.push(`${where}: expect_status must be an integer`);
  }
  if (READ_METHODS.has(method)) return errors;
  if (!WRITE_METHODS.has(method)) {
    errors.push(`${where}: method ${method} not allowed`);
    return errors;
  }
  // A non-GET is allowed only as a probe the auth gate rejects before any
  // handler runs — the §15 "route exists" check. Staging writes land in the
  // production database (rule 48), so anything else is refused here.
  if (t.rejected_probe !== true || ![401, 403].includes(t.expect_status)) {
    errors.push(
      `${where}: ${method} is only allowed as {"rejected_probe": true, "expect_status": 401|403} — staging writes reach production data`,
    );
  }
  return errors;
}

function validateTest(t, i) {
  const where = `tests[${i}]`;
  if (!t || typeof t !== 'object') return [`${where}: not an object`];
  switch (t.kind) {
    case 'http':
      return validateHttpTest(t, where);
    case 'playwright': {
      const errors = [];
      if (typeof t.spec !== 'string' || !SAFE_PATH.test(t.spec)) errors.push(`${where}: spec must be a repo-relative path`);
      else if (!/\.staging\.spec\.ts$/.test(t.spec)) errors.push(`${where}: spec must end in .staging.spec.ts`);
      if (t.cwd !== undefined && (typeof t.cwd !== 'string' || !(t.cwd === '.' || SAFE_PATH.test(t.cwd)))) {
        errors.push(`${where}: cwd must be a repo-relative directory`);
      }
      return errors;
    }
    case 'existing': {
      const errors = [];
      if (typeof t.ref !== 'string' || !EXISTING_REF.test(t.ref)) {
        errors.push(`${where}: ref must be "npm run <script>", "npx jest <paths>" or "npx vitest run <paths>"`);
      }
      if (t.cwd !== undefined && (typeof t.cwd !== 'string' || !(t.cwd === '.' || SAFE_PATH.test(t.cwd)))) {
        errors.push(`${where}: cwd must be a repo-relative directory`);
      }
      if (typeof t.reason !== 'string' || t.reason.trim().length < 10) {
        errors.push(`${where}: reason must say why this suite covers the change`);
      }
      return errors;
    }
    default:
      return [`${where}: kind must be http, playwright or existing`];
  }
}

function validateManifest(m, { vtid, service } = {}) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest is not a JSON object'] };
  if (vtid && m.vtid !== vtid) errors.push(`vtid is ${JSON.stringify(m.vtid)}, expected ${vtid}`);
  if (!SERVICES[m.service]) errors.push(`service must be one of ${Object.keys(SERVICES).join(', ')}`);
  else if (service && m.service !== service) errors.push(`service is ${m.service}, expected ${service}`);
  if (!Array.isArray(m.tests) || m.tests.length === 0) errors.push('tests must be a non-empty array');
  else m.tests.forEach((t, i) => errors.push(...validateTest(t, i)));
  return { ok: errors.length === 0, errors };
}

// ── Plan ─────────────────────────────────────────────────────────────────
// commits: [{ sha, date, subject, files }] — every commit between production
// and the verified commit (exclusive/inclusive). manifests: { [vtid]: obj|null }.
function planRange({ service, commits, manifests, enforceSince = ENFORCE_SINCE }) {
  const relevant = [];
  const suites = [];
  const missing = [];
  const legacy = [];
  const invalid = [];
  for (const c of commits) {
    if (!touchesService(c.files || [], service)) continue;
    const vtids = extractVtids(c.subject);
    const enforced = new Date(c.date).getTime() >= new Date(enforceSince).getTime();
    relevant.push({ sha: c.sha, subject: c.subject, vtids, enforced });
    if (vtids.length === 0) {
      (enforced ? missing : legacy).push({ sha: c.sha, subject: c.subject, vtid: null });
      continue;
    }
    for (const vtid of vtids) {
      if (suites.some((s) => s.vtid === vtid)) continue;
      const m = manifests[vtid];
      if (!m) {
        const bucket = enforced ? missing : legacy;
        if (!bucket.some((x) => x.vtid === vtid)) bucket.push({ sha: c.sha, subject: c.subject, vtid });
        continue;
      }
      const v = validateManifest(m, { vtid, service });
      if (!v.ok) {
        invalid.push({ vtid, errors: v.errors });
        continue;
      }
      suites.push({ vtid, tests: m.tests });
    }
  }
  return { relevant, suites, missing, legacy, invalid };
}

// ── Live commit ──────────────────────────────────────────────────────────
function commitMatches(service, liveStamp, sha) {
  if (!liveStamp || !sha) return false;
  if (service === 'gateway') return liveStamp === sha;
  // community-app stamps a 12-char short sha (VITE_APP_VERSION).
  return liveStamp.length >= 7 && sha.startsWith(liveStamp);
}

function parseFrontendVersion(html) {
  const m = /<meta name="vitana-app-version" content="([0-9a-f]{7,40})"/.exec(String(html || ''));
  return m ? m[1] : null;
}

// ── HTTP evaluation ──────────────────────────────────────────────────────
function getJsonPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function evaluateHttp(t, res) {
  const want = t.expect_status ?? 200;
  const problems = [];
  if (res.status !== want) problems.push(`status ${res.status}, expected ${want}`);
  if (t.rejected_probe && res.status >= 200 && res.status < 300) {
    problems.push('WRITE PROBE WAS ACCEPTED — the route did not reject an unauthenticated write; investigate immediately');
  }
  const wantType = t.expect_content_type ?? (t.target !== 'frontend' && String(t.path).startsWith('/api') ? 'application/json' : null);
  if (wantType && !String(res.contentType || '').includes(wantType)) {
    problems.push(`content-type ${res.contentType || '(none)'}, expected ${wantType}`);
  }
  if (t.expect_json) {
    for (const [p, v] of Object.entries(t.expect_json)) {
      const got = getJsonPath(res.json, p);
      if (JSON.stringify(got) !== JSON.stringify(v)) {
        problems.push(`${p} = ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`);
      }
    }
  }
  if (t.expect_body_contains) {
    for (const s of [].concat(t.expect_body_contains)) {
      if (!String(res.body || '').includes(s)) problems.push(`body does not contain ${JSON.stringify(s)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── Outcome + message ────────────────────────────────────────────────────
function decideOutcome({ superseded, results, plan }) {
  if (superseded) return 'superseded';
  const failed = results.some((r) => !r.ok);
  if (failed || plan.missing.length > 0 || plan.invalid.length > 0) return 'failed';
  return 'passed';
}

function short(sha) {
  return String(sha || '').slice(0, 12);
}

function buildReadyMessage({ service, sha, outcome, results, plan, shipping, prodStamp, runUrl }) {
  const passed = results.filter((r) => r.ok).length;
  const lines = [];
  if (outcome === 'passed') {
    lines.push('**Staging verified — ready for deployment to production?**');
  } else if (outcome === 'superseded') {
    lines.push(`**Staging verification superseded** — staging moved past \`${short(sha)}\` during the run; the newer deploy gets its own verification. No production prompt.`);
  } else {
    lines.push('**Staging verification FAILED — not ready for production.** Nothing will be offered for PUBLISH until this is green.');
  }
  lines.push('');
  lines.push(`- Service: \`${service}\``);
  lines.push(`- Verified commit: \`${sha}\``);
  lines.push(`- Tests: ${passed}/${results.length} passed`);
  if (runUrl) lines.push(`- Run: ${runUrl}`);
  const vtids = plan.suites.map((s) => s.vtid);
  if (vtids.length) lines.push(`- Change suites run: ${vtids.join(', ')}`);
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    lines.push('');
    lines.push('Failed:');
    for (const f of failures) lines.push(`- ${f.suite} › ${f.name}: ${f.problems.join('; ')}`);
  }
  if (plan.missing.length) {
    lines.push('');
    lines.push('Missing change suite (rule 47 — no suite, no merge):');
    for (const m of plan.missing) lines.push(`- \`${short(m.sha)}\` ${m.vtid || '(no VTID)'} — ${m.subject}`);
  }
  if (plan.invalid.length) {
    lines.push('');
    lines.push('Invalid change suite:');
    for (const m of plan.invalid) lines.push(`- ${m.vtid}: ${m.errors.join('; ')}`);
  }
  if (plan.legacy.length) {
    lines.push('');
    lines.push(`Changes without a change suite, merged before the rule took effect (${ENFORCE_SINCE}) — smoke only: ${plan.legacy.map((m) => m.vtid || short(m.sha)).join(', ')}`);
  }
  lines.push('');
  lines.push(`What would ship (production \`${short(prodStamp) || 'unknown'}\` → \`${short(sha)}\`, ${shipping.length} commit(s)):`);
  if (shipping.length === 0) lines.push('- (none — production already serves this commit, or its version could not be read)');
  for (const c of shipping.slice(0, 60)) {
    const v = extractVtids(c.subject);
    lines.push(`- \`${short(c.sha)}\` ${v.length ? v.join(', ') + ' — ' : ''}${c.subject}${c.author ? ` (${c.author})` : ''}`);
  }
  if (shipping.length > 60) lines.push(`- … and ${shipping.length - 60} more (full list in the run summary)`);
  if (outcome === 'passed') {
    lines.push('');
    lines.push('A "yes" promotes exactly this commit via PUBLISH (CLAUDE.md rule 50).');
  }
  return lines.join('\n');
}

module.exports = {
  PRODUCTION_HOSTS,
  STAGING_TARGETS,
  PRODUCTION_VERSION_SOURCES,
  SERVICES,
  ENFORCE_SINCE,
  isProductionHost,
  assertStagingTarget,
  pathMatches,
  touchesService,
  extractVtids,
  validateManifest,
  planRange,
  commitMatches,
  parseFrontendVersion,
  evaluateHttp,
  decideOutcome,
  buildReadyMessage,
};
