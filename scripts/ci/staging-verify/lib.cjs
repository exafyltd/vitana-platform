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
    // VTID-05144: the staging deploy workflow whose runs bound T_cut.
    stageDeployWorkflow: 'AWS-STAGE-DEPLOY-GATEWAY.yml',
    deployPaths: [
      'services/gateway/**',
      '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
    ],
  },
  'community-app': {
    repo: 'exafyltd/vitana-v1',
    target: 'frontend',
    stageDeployWorkflow: 'AWS-STAGE-DEPLOY-FRONTEND.yml',
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
    // hostname, not host: a port (vitanaland.com:8443) or a trailing dot must
    // not slip a production host past the check.
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
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
    throw new Error(`refusing to test against production host ${parsed.hostname} (CLAUDE.md rule 48)`);
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
// staging-verify-runner-fix — the only variables an `existing` suite may set,
// each with the only values it may take. The native bundle needs a build
// profile (apps/mobile/app.config.ts refuses to run without one, and there is
// no production profile). Never a secret, never a loader hook like NODE_OPTIONS.
const EXISTING_ENV_ALLOW = { APP_PROFILE: /^(development|test-g1)$/ };

function existingEnvErrors(env, where) {
  if (env === undefined) return [];
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [`${where}: env must be an object`];
  const errors = [];
  for (const [k, v] of Object.entries(env)) {
    const allow = EXISTING_ENV_ALLOW[k];
    if (!allow) errors.push(`${where}: env ${k} is not allowed (allowed: ${Object.keys(EXISTING_ENV_ALLOW).join(', ')})`);
    else if (typeof v !== 'string' || !allow.test(v)) errors.push(`${where}: env ${k}=${JSON.stringify(v)} is not an allowed value`);
  }
  return errors;
}

/** The validated env of an `existing` suite; `{}` when it has none or it is invalid. */
function existingEnv(t) {
  if (!t || existingEnvErrors(t.env, 'env').length) return {};
  return { ...(t.env || {}) };
}

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
      errors.push(...existingEnvErrors(t.env, where));
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

// ── Lockfile-only commits (VTID-05075) ───────────────────────────────────
// A dependency-lockfile sync that follows a package.json change is that
// change's own bookkeeping, and its subject cannot be fixed after the fact (a
// later "tag" commit does not change it). So a commit whose only build-relevant
// change is `pnpm-lock.yaml` needs no change suite of its own. Deliberately
// narrow: one filename, files outside the service's build are ignored (docs
// evidence rides along), any other build file makes it an ordinary commit, and
// the community app's package-lock.json / bun.lock are not covered. It is never
// hidden: planRange returns it in `lockfileOnly` and the message names it.
const LOCKFILE_ONLY_NAME = 'pnpm-lock.yaml';

function isLockfileOnlyCommit(files, service) {
  const inBuild = (files || []).filter((f) => touchesService([f], service));
  return inBuild.length > 0 && inBuild.every((f) => String(f).split('/').pop() === LOCKFILE_ONLY_NAME);
}

// ── Range (VTID-05076) ───────────────────────────────────────────────────
// Every change that landed on main between production and the verified commit,
// one entry each: a squash commit, a direct push, or a PR merge commit. Walking
// the first-parent chain keeps a merge-committed PR's own branch commits out of
// the list — the PR is judged by its merge commit, whose subject carries the PR
// title and VTID (validate-pr enforces it) — while a direct push without a VTID
// is still a first-parent commit and still fails rule 47. Files come from the
// first-parent diff, so a merge commit lists everything it brought into main
// (git show's combined diff would list only conflict-resolved files).
// `git(args)` runs git in the checkout and returns stdout, or null on failure.
function commitsBetween(git, fromSha, toSha) {
  const range = fromSha ? `${fromSha}..${toSha}` : `${toSha}~1..${toSha}`;
  const out = git(['log', '--first-parent', '--reverse', '--format=%H%x1f%cI%x1f%an%x1f%P%x1f%s', range]) || '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, author, parentField, ...subjectParts] = line.split('\x1f');
      const subject = subjectParts.join('\x1f');
      const parents = (parentField || '').split(' ').filter(Boolean);
      const fileOut = parents.length
        ? git(['diff', '--name-only', `${sha}^1`, sha])
        : git(['show', '--name-only', '--format=', sha]);
      const files = (fileOut || '').split('\n').filter(Boolean);
      let branchCommits = 0;
      if (parents.length > 1) {
        const n = Number(git(['rev-list', '--count', `${sha}^1..${sha}`]));
        branchCommits = Number.isFinite(n) && n > 1 ? n - 1 : 0;
      }
      return { sha, date, author, subject, files, branchCommits };
    });
}

// ── Plan ─────────────────────────────────────────────────────────────────
// commits: [{ sha, date, subject, files }] — every commit between production
// and the verified commit (exclusive/inclusive). manifests: { [vtid]: obj|null }.
// VTID-05236: a commit that already landed on main WITHOUT a VTID in its
// subject cannot get a suite after the fact (history is never rewritten).
// docs/validation/commit-coverage.json names such a commit by its FULL sha and
// the VTID whose change suite covers it, with an owner-approved reason. Only a
// commit with no VTID of its own can be covered; the covering suite must exist
// and is run like any other. Covered commits are listed in the summary.
function parseCommitCoverage(json) {
  const out = {};
  const errors = [];
  const entries = (json && Array.isArray(json.covers)) ? json.covers : [];
  for (const [i, e] of entries.entries()) {
    const where = `commit-coverage.json covers[${i}]`;
    if (!e || !/^[0-9a-f]{40}$/.test(String(e.sha || ''))) { errors.push(`${where}: sha must be a full 40-char commit sha`); continue; }
    if (!/^VTID-\d{4,5}$/.test(String(e.vtid || ''))) { errors.push(`${where}: vtid must be VTID-XXXXX`); continue; }
    if (!String(e.reason || '').trim() || !String(e.approved_by || '').trim()) { errors.push(`${where}: reason and approved_by are required`); continue; }
    out[e.sha] = e.vtid;
  }
  return { coverage: out, errors };
}

function planRange({ service, commits, manifests, enforceSince = ENFORCE_SINCE, coverage = {} }) {
  const relevant = [];
  const suites = [];
  const missing = [];
  const legacy = [];
  const invalid = [];
  const lockfileOnly = [];
  const covered = [];
  for (const c of commits) {
    if (!touchesService(c.files || [], service)) continue;
    let vtids = extractVtids(c.subject);
    if (vtids.length === 0 && coverage[c.sha]) {
      vtids = [coverage[c.sha]];
      covered.push({ sha: c.sha, subject: c.subject, vtid: coverage[c.sha] });
    }
    const enforced = new Date(c.date).getTime() >= new Date(enforceSince).getTime();
    relevant.push({ sha: c.sha, subject: c.subject, vtids, enforced });
    if (vtids.length === 0 && isLockfileOnlyCommit(c.files, service)) {
      lockfileOnly.push({ sha: c.sha, subject: c.subject });
      continue;
    }
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
  return { relevant, suites, missing, legacy, invalid, lockfileOnly, covered };
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

// VTID-04688: a response body is read in full up to this many characters.
// The old 1,000,000 cut-off silently hid everything past the first MB of
// the 2.5 MB Command Hub app.js, so a check for code that really is served
// failed as "body does not contain". The cap only guards against a runaway
// response; a check that meets it says so instead of reporting a miss.
const MAX_HTTP_BODY_CHARS = 16_000_000;

function clipBody(text) {
  const s = String(text ?? '');
  return s.length > MAX_HTTP_BODY_CHARS
    ? { body: s.slice(0, MAX_HTTP_BODY_CHARS), truncated: true }
    : { body: s, truncated: false };
}

// VTID-05083: the request init for one http test. A rejected probe carries a
// deliberately invalid bearer; only a write method also gets a JSON body —
// fetch refuses a GET/HEAD with a body before anything is sent.
function httpRequestInit(t) {
  const method = String(t.method || 'GET').toUpperCase();
  const init = { method, headers: { accept: 'application/json, text/html;q=0.9' } };
  if (t.rejected_probe) {
    init.headers.authorization = 'Bearer staging-verify.invalid.probe';
    if (!READ_METHODS.has(method)) {
      init.headers['content-type'] = 'application/json';
      init.body = '{}';
    }
  }
  return init;
}

function evaluateHttp(t, res) {
  const want = t.expect_status ?? 200;
  const problems = [];
  if (res.status !== want) problems.push(`status ${res.status}, expected ${want}`);
  if (t.rejected_probe && res.status >= 200 && res.status < 300) {
    const method = String(t.method || 'GET').toUpperCase();
    problems.push(
      READ_METHODS.has(method)
        ? `REJECTED PROBE WAS ACCEPTED — ${method} with an invalid bearer was served; investigate immediately`
        : 'WRITE PROBE WAS ACCEPTED — the route did not reject an unauthenticated write; investigate immediately',
    );
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
      if (!String(res.body || '').includes(s)) {
        problems.push(
          `body does not contain ${JSON.stringify(s)}` +
            (res.truncated ? ` (only the first ${MAX_HTTP_BODY_CHARS} characters were read)` : ''),
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── Production baseline ──────────────────────────────────────────────────
// Where production stands relative to the verified commit. Only 'same' and
// 'behind' let the run say what a PUBLISH would ship; every other state is a
// failed check. 'ahead' is its own state (VTID-04715): production already
// contains the commit, so there is nothing to ship and promoting it would
// roll production back — not a divergence.
function describeBaseline({ sha, prodStamp, prodSha, prodIsAncestor, shaIsAncestorOfProd }) {
  if (!prodStamp) {
    return { state: 'unknown', rangeFrom: null, check: 'production baseline known', problem: 'the production version stamp could not be read — cannot list what would ship, so nothing can be approved' };
  }
  if (!prodSha) {
    return { state: 'missing', rangeFrom: null, check: 'production baseline known', problem: `production commit ${prodStamp} is not in this repository's history — cannot list what would ship, so nothing can be approved` };
  }
  if (prodSha === sha) return { state: 'same', rangeFrom: null, check: null, problem: null };
  if (prodIsAncestor) return { state: 'behind', rangeFrom: prodSha, check: null, problem: null };
  if (shaIsAncestorOfProd) {
    return {
      state: 'ahead',
      rangeFrom: null,
      check: 'production is behind the verified commit',
      problem: `production already runs ${short(prodSha)}, which contains ${short(sha)} — nothing to ship, and promoting ${short(sha)} would roll production back`,
    };
  }
  return { state: 'diverged', rangeFrom: null, check: 'production baseline known', problem: `production commit ${prodStamp} and ${short(sha)} are on diverged histories — cannot list what would ship, so nothing can be approved` };
}

// ── Mid-run redeploy (VTID-05144) ────────────────────────────────────────
// A full run takes 22–45 min; a merge in that window redeploys staging. When
// the after-run check finds staging on a DESCENDANT of the commit under test
// (superseded), each result is attributed to the commit only if it ended
// before the earliest instant a newer image could have served: T_cut.
const DEPLOY_LOOKBACK_MS = 6 * 60 * 60_000;
// An ECS rollout and target-group deregistration can outlast its deploy
// workflow run by 30–120 s, so a deploy that completed shortly before the
// run started still counts. With T_cut clamped to runStart this only ever
// under-attributes — the fail-safe direction.
const DEPLOY_COMPLETED_MARGIN_MS = 5 * 60_000;

function toMs(t) {
  if (typeof t === 'number') return t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : NaN;
}

// runs: the service's staging deploy workflow runs [{ created_at, updated_at,
// status, conclusion }], or null when the lookup failed. Returns T_cut (ms).
// No new image can serve before its deploy run exists (deploys only via CI),
// so T_cut is a provable lower bound. Failed/cancelled deploy runs count —
// they may have rolled tasks. Lookup failure or no runs → runStart (fail
// closed: nothing attributed).
function deployCutoff(runs, runStart) {
  const start = toMs(runStart);
  if (!Array.isArray(runs)) return start;
  let cut = Infinity;
  for (const r of runs) {
    if (!r || r.conclusion === 'skipped') continue;
    const created = toMs(r.created_at);
    if (!Number.isFinite(created) || created < start - DEPLOY_LOOKBACK_MS) continue;
    const updated = toMs(r.updated_at);
    if (r.status === 'completed' && Number.isFinite(updated) && updated < start - DEPLOY_COMPLETED_MARGIN_MS) continue;
    cut = Math.min(cut, Math.max(created, start));
  }
  return Number.isFinite(cut) ? cut : start;
}

// Each row: attributed = static || ended_at < T_cut. A row that ended exactly
// at T_cut, or carries no end time, is not attributed.
function attributeResults(results, tCut) {
  const cut = toMs(tCut);
  return results.map((r) => {
    const ended = r.ended_at ? toMs(r.ended_at) : NaN;
    return { ...r, attributed: r.static === true || (Number.isFinite(ended) && Number.isFinite(cut) && ended < cut) };
  });
}

// ── Outcome + message ────────────────────────────────────────────────────
// VTID-05144: superseded no longer hides a real failure. Superseded →
// `failed` when a failure is attributed to the commit (it ran while staging
// still served it), else `superseded`. Unattributed rows never count, pass
// or fail. `superseded` is never a pass for any consumer.
function decideOutcome({ superseded, results, plan }) {
  if (superseded) return results.some((r) => !r.ok && r.attributed === true) ? 'failed' : 'superseded';
  const failed = results.some((r) => !r.ok);
  if (failed || plan.missing.length > 0 || plan.invalid.length > 0) return 'failed';
  return 'passed';
}

// VTID-05272 (plan kiro-autonomy-fallback §5 H): which lane a failed run is
// about. `smoke` covers the service smoke suite and the static deploy rows;
// when it failed, every VTID is `failed` (nothing in the build can be
// trusted). Otherwise a VTID is `failed` when one of its own rows failed,
// `passed` when all ran green, `not_attributed` when none of its rows count
// (no suite ran for it, or the rows ran after a newer image took over).
// Information only: decideOutcome stays the single outcome rule (rule 50).
const VTID_SUITE_RE = /^VTID-\d{4,5}$/;
function summarizeByVtid(results, vtids = []) {
  const counted = (results || []).filter((r) => r && r.attributed !== false);
  const smokeRows = counted.filter((r) => r.suite === 'smoke' || r.suite === 'deploy');
  const smoke = smokeRows.length === 0 ? 'not_run' : smokeRows.every((r) => r.ok) ? 'passed' : 'failed';
  const ids = new Set((vtids || []).filter((v) => VTID_SUITE_RE.test(v)));
  for (const r of results || []) if (r && VTID_SUITE_RE.test(r.suite)) ids.add(r.suite);
  const out = { smoke };
  for (const v of [...ids].sort()) {
    const rows = counted.filter((r) => r.suite === v);
    if (smoke === 'failed') out[v] = 'failed';
    else if (rows.length === 0) out[v] = 'not_attributed';
    else out[v] = rows.every((r) => r.ok) ? 'passed' : 'failed';
  }
  return out;
}
function short(sha) {
  return String(sha || '').slice(0, 12);
}

// VTID-05146 (autonomy plan C4): commits the Dev Autopilot landed by itself —
// its squash merges ("Dev Autopilot auto-merge: execution <id>", the commit
// title dev-autopilot-watcher.ts gives every merge of a dev-autopilot/* PR) and
// its revert PRs ("Revert: auto-fix <id> failed <stage> verification", from a
// revert/auto-* branch, dev-autopilot-bridge.ts). The ready message lists them
// in their own section so a "yes" sees exactly what no person wrote.
const AUTOPILOT_SUBJECT_RES = [/^Dev Autopilot auto-merge:/i, /^Revert: auto-fix [0-9a-f]{8} failed /i];

function isAutopilotCommit(subject) {
  const s = String(subject || '');
  return AUTOPILOT_SUBJECT_RES.some((re) => re.test(s));
}

function shippingLine(c) {
  const v = extractVtids(c.subject);
  const via = c.branchCommits ? ` (${c.branchCommits} branch commit${c.branchCommits === 1 ? '' : 's'})` : '';
  return `- \`${short(c.sha)}\` ${v.length ? v.join(', ') + ' — ' : ''}${c.subject}${c.author ? ` (${c.author})` : ''}${via}`;
}

function buildReadyMessage({ service, sha, outcome, results, plan, shipping, prodStamp, runUrl, supersededBy = null, attributionCutoff = null }) {
  const passed = results.filter((r) => r.ok).length;
  const lines = [];
  if (outcome === 'passed') {
    lines.push('**Staging verified — ready for deployment to production?**');
  } else if (outcome === 'superseded') {
    lines.push(`**Staging verification superseded** — staging moved from \`${short(sha)}\` to \`${supersededBy ? short(supersededBy) : 'a newer commit'}\` during the run; nothing failed while staging still served \`${short(sha)}\`, but it is not verified. The newer commit gets its own verification. No production prompt.`);
  } else {
    lines.push('**Staging verification FAILED — not ready for production.** Nothing will be offered for PUBLISH until this is green.');
  }
  lines.push('');
  lines.push(`- Service: \`${service}\``);
  lines.push(`- Verified commit: \`${sha}\``);
  lines.push(`- Tests: ${passed}/${results.length} passed`);
  // VTID-05144: after a mid-run redeploy only results that ended before the
  // deploy cutoff are attributed to the commit.
  const attributedKnown = results.some((r) => typeof r.attributed === 'boolean');
  if (supersededBy) {
    lines.push(`- Staging moved to: \`${supersededBy}\``);
    lines.push(`- Attribution cutoff: ${attributionCutoff || '(none — staging had moved before the tests ran)'}`);
  }
  if (attributedKnown) {
    const att = results.filter((r) => r.attributed === true);
    const un = results.filter((r) => r.attributed !== true);
    lines.push(`- Attributed to \`${short(sha)}\`: ${att.filter((r) => r.ok).length} passed, ${att.filter((r) => !r.ok).length} failed; not attributed: ${un.length}`);
  }
  if (runUrl) lines.push(`- Run: ${runUrl}`);
  const vtids = plan.suites.map((s) => s.vtid);
  if (vtids.length) lines.push(`- Change suites run: ${vtids.join(', ')}`);
  const failures = results.filter((r) => !r.ok && (!attributedKnown || r.attributed === true));
  if (failures.length) {
    lines.push('');
    lines.push('Failed:');
    for (const f of failures) lines.push(`- ${f.suite} › ${f.name}: ${f.problems.join('; ')}`);
  }
  const unattributedFailures = attributedKnown ? results.filter((r) => !r.ok && r.attributed !== true) : [];
  if (unattributedFailures.length) {
    lines.push('');
    lines.push('Not attributed — staging was redeploying:');
    for (const f of unattributedFailures) lines.push(`- ${f.suite} › ${f.name}: ${f.problems.join('; ')}`);
  }
  if (plan.missing.length) {
    lines.push('');
    lines.push('Missing change suite (rule 47 — no suite, no merge):');
    for (const m of plan.missing) lines.push(`- \`${short(m.sha)}\` ${m.vtid || '(no VTID)'} — ${m.subject}`);
  }
  const coveredList = plan.covered || [];
  if (coveredList.length) {
    lines.push('');
    lines.push('Covered by another change suite (docs/validation/commit-coverage.json, owner-approved):');
    for (const m of coveredList) lines.push(`- \`${short(m.sha)}\` → ${m.vtid} — ${m.subject}`);
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
  const lockfileOnly = plan.lockfileOnly || [];
  if (lockfileOnly.length) {
    lines.push('');
    lines.push('Lockfile-only changes (no change suite; smoke tests only):');
    for (const m of lockfileOnly) lines.push(`- \`${short(m.sha)}\` ${m.subject}`);
  }
  lines.push('');
  lines.push(`What would ship (production \`${short(prodStamp) || 'unknown'}\` → \`${short(sha)}\`, ${shipping.length} commit(s)):`);
  if (shipping.length === 0) lines.push('- (none — production already serves or contains this commit, or its version could not be read)');
  const autopilot = shipping.filter((c) => isAutopilotCommit(c.subject));
  const byPeople = shipping.filter((c) => !isAutopilotCommit(c.subject));
  for (const c of byPeople.slice(0, 60)) lines.push(shippingLine(c));
  if (byPeople.length > 60) lines.push(`- … and ${byPeople.length - 60} more (full list in the run summary)`);
  if (autopilot.length) {
    lines.push('');
    lines.push(`Dev Autopilot changes in this range (${autopilot.length}, merged or reverted by the autopilot, not by a person):`);
    for (const c of autopilot.slice(0, 60)) lines.push(shippingLine(c));
    if (autopilot.length > 60) lines.push(`- … and ${autopilot.length - 60} more (full list in the run summary)`);
  }
  if (outcome === 'passed') {
    lines.push('');
    lines.push('A "yes" promotes exactly this commit via PUBLISH (CLAUDE.md rule 50).');
  }
  return lines.join('\n');
}

// VTID-04949 (plan C2): the nightly full run. Every change suite ever merged for
// the service runs again (not just the prod..commit range), so a later change
// that breaks an older feature is caught within a day even if no new commit
// touches it. `alreadyRun` = the VTIDs the normal range run already covered.
function planFullRun({ service, manifests, alreadyRun = [] }) {
  const done = new Set(alreadyRun);
  const suites = [];
  const invalid = [];
  for (const [vtid, m] of Object.entries(manifests).sort(([a], [b]) => a.localeCompare(b))) {
    if (done.has(vtid) || !m) continue;
    if (m.__parseError) { invalid.push({ vtid, errors: [m.__parseError] }); continue; }
    if (m.service !== service) continue;
    const v = validateManifest(m, { service });
    if (!v.ok) { invalid.push({ vtid, errors: v.errors }); continue; }
    suites.push({ vtid, tests: m.tests });
  }
  return { suites, invalid };
}

// ── VTID-05129: robustness of the run itself ─────────────────────────────

// One sample round of version stamps. A null sample (the fetch threw, or the
// page had no stamp) is unknown, never a mismatch: a single dropped request
// must not read as "staging serves another commit". Match needs at least half
// the samples readable and every readable one on <sha>.
function evaluateStampSamples(service, stamps, sha) {
  const seen = stamps.filter(Boolean);
  const other = seen.find((st) => !commitMatches(service, st, sha)) || null;
  if (other) return { state: 'mismatch', other };
  if (seen.length > 0 && seen.length >= Math.ceil(stamps.length / 2)) return { state: 'match' };
  return { state: 'unknown' };
}

// A GET that THROWS with one of these is a dropped connection worth one more
// try. HTTP statuses, TLS/certificate errors and DNS misses are never retried.
const RETRIABLE_FETCH_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  // VTID-05129 (proof run 38363989362): a bare "fetch failed" on a GET that
  // passed a second later carried none of the codes above. Node 20 connects
  // with happy eyeballs (IPv6 + IPv4), so a dropped connect surfaces as an
  // AggregateError of per-address errors, and an idle keep-alive socket the
  // CDN closed surfaces as UND_ERR_CLOSED / EPIPE / a headers timeout.
  'UND_ERR_CLOSED', 'UND_ERR_HEADERS_TIMEOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
]);
function retriableCause(c) {
  if (!c) return false;
  if (RETRIABLE_FETCH_CODES.has(c.code)) return true;
  return Array.isArray(c.errors) && c.errors.length > 0 && c.errors.every((x) => RETRIABLE_FETCH_CODES.has(x && x.code));
}
function isRetriableFetchError(e) {
  return !!e && e.name === 'TypeError' && retriableCause(e.cause);
}
// "fetch failed" alone says nothing; name the underlying cause in the evidence.
function describeFetchError(e) {
  const c = e && e.cause;
  if (!c) return String((e && e.message) || e);
  const inner = Array.isArray(c.errors) && c.errors.length ? ` [${c.errors.map((x) => (x && (x.code || x.message)) || '?').join(', ')}]` : '';
  return `${e.message} (${c.code || c.name || 'cause'}: ${c.message || ''}${inner})`;
}

// The one-line evidence for a failed spec. Keeps the error lines and, after a
// staging-guard abort, the requests it names (the guard prints one
// "METHOD URL" per line), so OASIS and the PR comment say WHICH requests.
function summarizeFailure(output) {
  const lines = String(output || '').split('\n').map((l) => l.replace(/[║╔╗╚╝═]/g, '').trim()).filter(Boolean);
  const key = lines.filter((l) => /(✘|Error:|expect\(|Expected|Received|FAIL|failed)/.test(l));
  const head = (key.length ? key : lines.slice(-6)).slice(0, 8).join(' | ').slice(0, 1500);
  if (!/staging-guard aborted/.test(output || '')) return head;
  const blocked = [...new Set(lines.filter((l) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) https?:\/\//.test(l)))].slice(0, 20);
  return blocked.length ? `${head} | blocked: ${blocked.join(' ; ')}`.slice(0, 4000) : head;
}

// Requests the app fires on almost every page that the staging guard aborts,
// but that no spec should fail on. Each entry matches ONE guard record exactly
// ("METHOD URL", anchored), so a production-host record — which the guard
// suffixes with " (production host)" — never matches. The requests stay
// aborted: nothing new reaches production data. MIRRORED VERBATIM in
// staging-guard.ts (DEFAULT_ALLOWED_ABORTS); lib.test.cjs keeps the two equal.
const DEFAULT_ALLOWED_ABORTS = [
  // Telemetry beacons (fire-and-forget).
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/rum\/beacon(\?[^ ]*)?$/,
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/diag\/notif-tap(\?[^ ]*)?$/,
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/analytics\/events\/batch(\?[^ ]*)?$/,
  // Voice widget warm-up on load (useOrbVoiceWidget) — only this path.
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/orb\/live\/session\/prewarm(\?[^ ]*)?$/,
  // Chat presence and the activity log.
  /^(POST|PATCH) https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/thread_presence(\?[^ ]*)?$/,
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/user_activity_log(\?[^ ]*)?$/,
  // Read-only RPCs and functions (supabase-js sends rpc/invoke as POST).
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/rpc\/(get_role_preference|get_my_permitted_roles|list_roles_for_active_tenant|get_profile_health_summary|get_user_profile_by_identifier)(\?[^ ]*)?$/,
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/functions\/v1\/list_my_memberships(\?[^ ]*)?$/,
  // Real production writes fired app-wide on load, never a spec's subject:
  // the daily Vitana Index upsert and daily match generation. The guard
  // aborts them; specs only stop failing on that abort.
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/rpc\/health_compute_vitana_index(\?[^ ]*)?$/,
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/functions\/v1\/generate-daily-matches(\?[^ ]*)?$/,
];
const DEFAULT_ALLOWED_ABORTS_CAP = 16;

// quality-checks/staging-manifest-bom: Windows tools (PowerShell 5.1 `Set-Content -Encoding utf8`) write a UTF-8 BOM.
// It carries no data, so one leading U+FEFF is removed before JSON.parse; anything else is parsed unchanged.
function parseJsonText(text) {
  const s = String(text);
  return JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
}

function isToleratedAbort(record, specAllow = []) {
  return DEFAULT_ALLOWED_ABORTS.some((r) => r.test(record)) || specAllow.some((r) => r.test(record));
}

module.exports = {
  parseJsonText,
  existingEnv,
  evaluateStampSamples,
  isRetriableFetchError,
  describeFetchError,
  summarizeFailure,
  DEFAULT_ALLOWED_ABORTS,
  DEFAULT_ALLOWED_ABORTS_CAP,
  isToleratedAbort,
  planFullRun,
  PRODUCTION_HOSTS,
  STAGING_TARGETS,
  PRODUCTION_VERSION_SOURCES,
  SERVICES,
  ENFORCE_SINCE,
  isProductionHost,
  assertStagingTarget,
  pathMatches,
  touchesService,
  isLockfileOnlyCommit,
  commitsBetween,
  extractVtids,
  validateManifest,
  planRange,
  parseCommitCoverage,
  commitMatches,
  parseFrontendVersion,
  MAX_HTTP_BODY_CHARS,
  clipBody,
  evaluateHttp,
  httpRequestInit,
  describeBaseline,
  deployCutoff,
  attributeResults,
  DEPLOY_COMPLETED_MARGIN_MS,
  DEPLOY_LOOKBACK_MS,
  decideOutcome,
  summarizeByVtid,
  buildReadyMessage,
  isAutopilotCommit,
};
