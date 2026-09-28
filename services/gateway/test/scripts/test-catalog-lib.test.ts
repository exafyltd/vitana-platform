// VTID-04637 — the generated test catalog (scripts/test-catalog/lib.cjs).
//
// The Testing & QA module's catalog replaces a table that was typed in by hand
// and went stale within weeks. These tests pin what the generator decides:
// which files are tests, which suite they belong to, which workflow runs them,
// and which environment (dev_pr / nightly / staging / production) each touches.
// The last block runs the generator over this repository itself, so a new
// workflow or suite that the rules cannot place fails here, not in the UI.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require('../../../../scripts/test-catalog/lib.cjs');
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = join(__dirname, '../../../..');

describe('classifyTestFile', () => {
  it('groups gateway Jest files by area', () => {
    expect(lib.classifyTestFile('platform', 'services/gateway/test/routes/testing.test.ts').suite.id).toBe('platform:gateway:routes');
    expect(lib.classifyTestFile('platform', 'services/gateway/test/orb/live/x.test.ts').suite.id).toBe('platform:gateway:orb/live');
    expect(lib.classifyTestFile('platform', 'services/gateway/test/vtid-04465-operator.test.ts').suite).toMatchObject({
      id: 'platform:gateway:regression', kind: 'regression',
    });
  });

  it('marks gateway tests outside the Jest roots as their own (never run) suite', () => {
    expect(lib.classifyTestFile('platform', 'services/gateway/tests/d51.test.ts').suite.id).toBe('platform:gateway:uncollected');
    expect(lib.classifyTestFile('platform', 'services/gateway/src/routes/admin-autopilot.test.ts').suite.id).toBe('platform:gateway:uncollected');
  });

  it('recognises Playwright, sibling services, Python and frontend files', () => {
    expect(lib.classifyTestFile('platform', 'e2e/community-desktop/login-flow.spec.ts')).toMatchObject({ runner: 'playwright' });
    expect(lib.classifyTestFile('platform', 'services/vcaop/test/api/x.test.ts').suite.id).toBe('platform:svc:vcaop');
    expect(lib.classifyTestFile('platform', 'services/agents/orb-agent/tests/test_x.py')).toMatchObject({ runner: 'pytest', suite: { id: 'platform:py:agents/orb-agent' } });
    expect(lib.classifyTestFile('frontend', 'src/hooks/useRole.test.tsx').suite.id).toBe('frontend:hooks');
    expect(lib.classifyTestFile('frontend', 'src/components/calendar/__regression__/calendar-logic.golden.test.ts').suite.id).toBe('frontend:calendar-golden');
    expect(lib.classifyTestFile('frontend', 'scripts/news-feed-ranker-regression.mjs').suite.id).toBe('frontend:node-regressions');
  });

  it('ignores non-test files and node_modules', () => {
    expect(lib.classifyTestFile('platform', 'services/gateway/src/routes/testing.ts')).toBeNull();
    expect(lib.classifyTestFile('platform', 'services/gateway/node_modules/x/a.test.ts')).toBeNull();
  });
});

describe('countCases', () => {
  it('counts it/test calls including .each and .skip, not method calls', () => {
    const src = `
      describe('x', () => {
        it('a', () => {});
        test('b', () => {});
        it.each([[1],[2]])('c %s', () => {});
        it.skip('d', () => {});
        regex.test('not a case');
      });`;
    expect(lib.countCases(src, 'jest')).toBe(4);
  });
  it('counts python test functions', () => {
    expect(lib.countCases('def test_a():\n  pass\nasync def test_b():\n  pass\ndef helper(): pass', 'pytest')).toBe(2);
  });
});

describe('workflow parsing', () => {
  const wf = (file: string, text: string) => lib.parseWorkflow('platform', file, text);

  it('reads triggers and crons from the on: block only', () => {
    const w = wf('TEST-SUITE.yml', `name: Test Suite
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:
jobs:
  gateway:
    steps:
      - run: npx jest --silent
`);
    expect(w.triggers).toMatchObject({ pull_request: true, push: true, workflow_dispatch: true, schedule: ['17 3 * * *'] });
    expect(w.kind).toBe('test');
    expect(w.environments).toEqual(['dev_pr', 'nightly']);
    expect(w.schedules[0].human).toBe('daily 03:17 UTC');
  });

  it('labels environments by the hosts a workflow targets', () => {
    const w = wf('E2E-ORB-MONITOR.yml', `on:
  schedule:
    - cron: '*/15 * * * *'
jobs:
  x:
    env:
      HUB_URL: https://preview-aws-gateway.vitanaland.com
    steps:
      - run: npx playwright test
`);
    expect(w.kind).toBe('monitor');
    expect(w.environments).toEqual(['staging']);
    expect(w.schedules[0].human).toBe('every 15 min');
  });

  it('puts database monitors on production (one shared Supabase project)', () => {
    const w = wf('ALERT-PUSH-DISPATCH-HEALTH.yml', `on:
  schedule:
    - cron: '*/20 * * * *'
jobs:
  x:
    steps:
      - run: curl "$SUPABASE_URL/rest/v1/user_notifications?select=id" -H "apikey: $SUPABASE_SERVICE_ROLE"
`);
    expect(w.environments).toEqual(['production']);
  });

  it('flags a Playwright workflow that touches a production host', () => {
    const w = wf('MORNING-SYSTEM-HEALTH-CHECK.yml', `on:
  schedule:
    - cron: '0 6 * * *'
jobs:
  x:
    steps:
      - run: npx playwright test --base-url https://vitanaland.com
`);
    expect(w.flags).toContain('ui_test_touches_production');
    expect(w.environments).toContain('production');
  });

  it('does not flag production curl checks when the Playwright step runs on staging (VTID-04648)', () => {
    const w = wf('MORNING-SYSTEM-HEALTH-CHECK.yml', `on:
  schedule:
    - cron: '0 6 * * *'
env:
  GATEWAY_URL: https://gateway.vitanaland.com
  COMMUNITY_STAGING_URL: https://preview-aws.vitanaland.com
jobs:
  x:
    steps:
      - name: prod health
        run: curl -sS "$GATEWAY_URL/alive"
      - name: screen load (staging)
        env:
          COMMUNITY_URL: \${{ env.COMMUNITY_STAGING_URL }}
        run: npx playwright test screen-load-timing.spec.ts
`);
    expect(w.flags).not.toContain('ui_test_touches_production');
    expect(w.environments).toContain('production');
  });

  it('resolves env references in the Playwright step (VTID-04648)', () => {
    const w = wf('X-E2E.yml', `on:
  workflow_dispatch:
env:
  COMMUNITY_PROD_URL: https://vitanaland.com
jobs:
  x:
    steps:
      - name: e2e
        env:
          COMMUNITY_URL: \${{ env.COMMUNITY_PROD_URL }}
        run: npx playwright test
`);
    expect(w.flags).toContain('ui_test_touches_production');
  });

  it('ignores production hosts in a refusal glob (VTID-04648)', () => {
    const w = wf('SCREEN-LOAD-TIMING.yml', `on:
  workflow_dispatch:
jobs:
  x:
    steps:
      - name: run
        run: |
          case "$COMMUNITY_URL" in
            https://vitanaland.com*|https://www.vitanaland.com*) exit 1 ;;
          esac
          npx playwright test screen-load-timing.spec.ts
        env:
          COMMUNITY_URL: https://preview-aws.vitanaland.com
`);
    expect(w.flags).not.toContain('ui_test_touches_production');
    expect(w.environments).toEqual(['staging']);
  });

  it('flags dead GCP hosts and ignores commented-out steps', () => {
    const w = wf('MOBILE-DEVICE-E2E.yml', `on:
  workflow_dispatch:
jobs:
  x:
    steps:
      # - run: npx jest
      - run: node run.mjs --url https://preview.vitanaland.com/maxina
`);
    expect(w.flags).toContain('dead_host');
    expect(w.runners).not.toContain('jest');
  });

  it('labels deploy workflows by what they deploy and treats scheduled data jobs as jobs', () => {
    expect(wf('AWS-PROD-DEPLOY-GATEWAY.yml', 'on:\n  workflow_dispatch:\njobs:\n  x:\n    steps:\n      - name: Smoke — build-info\n').environments).toEqual(['production']);
    expect(wf('AWS-STAGE-DEPLOY-GATEWAY.yml', 'on:\n  push:\njobs:\n  x:\n    steps:\n      - name: Smoke\n').environments).toEqual(['staging']);
    expect(wf('CRON-AUTO-PROMOTER.yml', "on:\n  schedule:\n    - cron: '30 * * * *'\n").kind).toBe('job');
    expect(wf('apply-notify-on-community-publish-migration.yml', 'on:\n  push:\n').kind).toBe('job');
  });
});

describe('describeCron / runsPerDay', () => {
  it.each([
    ['*/15 * * * *', 'every 15 min', 96],
    ['35 * * * *', 'hourly at :35', 24],
    ['7,37 * * * *', 'twice hourly at :07, :37', 48],
    ['0 7,19 * * *', 'daily 07:00, 19:00 UTC', 2],
    ['0 2 * * 0', 'Sun 02:00 UTC', 1 / 7],
  ])('%s', (cron, human, perDay) => {
    expect(lib.describeCron(cron)).toBe(human);
    expect(lib.runsPerDay(cron)).toBeCloseTo(perDay, 1);
  });
});

describe('buildCatalog', () => {
  const catalog = lib.buildCatalog({
    generated_at: '2026-09-26T00:00:00Z',
    sources: { platform: { sha: 'abc' } },
    files: [
      { repo: 'platform', path: 'services/gateway/test/routes/testing.test.ts', text: "it('a',()=>{}); it('b',()=>{})" },
      { repo: 'platform', path: 'services/vcaop-mcp/test/x.test.ts', text: "it('a',()=>{})" },
    ],
    workflows: [
      { repo: 'platform', file: 'TEST-SUITE.yml', text: "on:\n  pull_request:\n  schedule:\n    - cron: '17 3 * * *'\njobs:\n  x:\n    steps:\n      - run: npx jest\n" },
    ],
    packages: [
      { repo: 'platform', dir: 'services/gateway', text: JSON.stringify({ scripts: { 'test:support': 'jest test/routes/testing.test.ts' } }) },
    ],
  });

  it('attaches suites to the workflows that run them', () => {
    const s = catalog.suites.find((x: any) => x.id === 'platform:gateway:routes');
    expect(s).toMatchObject({ files: 1, cases: 2, runs_in: ['TEST-SUITE.yml'], environments: ['dev_pr', 'nightly'], never_run: false });
    expect(s.schedules[0]).toMatchObject({ workflow: 'TEST-SUITE.yml', human: 'daily 03:17 UTC' });
  });

  it('marks a suite no workflow runs as never_run', () => {
    const s = catalog.suites.find((x: any) => x.id === 'platform:svc:vcaop-mcp');
    expect(s.never_run).toBe(true);
    expect(catalog.summary.never_run_suites).toContain('platform:svc:vcaop-mcp');
  });

  it('resolves named npm test suites to their files', () => {
    expect(catalog.named_suites[0]).toMatchObject({ name: 'npm run test:support', files: 1, cases: 2, resolved: true });
  });
});

describe('this repository, scanned for real', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'coverage', 'graphify-out', '.repowise'].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else out.push(relative(REPO_ROOT, full).split('\\').join('/'));
    }
    return out;
  }
  const workflowFiles = readdirSync(join(REPO_ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));
  const workflows = workflowFiles.map((file) => ({ repo: 'platform', file, text: readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8') }));
  const gatewayTests = walk(join(REPO_ROOT, 'services/gateway/test')).filter((p) => p.endsWith('.test.ts'));

  it('classifies every gateway Jest file into a suite', () => {
    const unplaced = gatewayTests.filter((p) => !lib.classifyTestFile('platform', p));
    expect(unplaced).toEqual([]);
  });

  it('only wires suites to workflows that exist', () => {
    const ids = new Set(workflows.map((w) => `platform:${w.file}`));
    expect(lib.runnersForSuite('platform:gateway:routes', [...ids])).toEqual(['platform:TEST-SUITE.yml']);
    expect(lib.runnersForSuite('platform:e2e:community-desktop', [...ids])).toContain('platform:E2E-TEST-RUN.yml');
  });

  it('puts every test/monitor/gate workflow in at least one environment, unless it is flagged', () => {
    const parsed = workflows.map((w) => lib.parseWorkflow('platform', w.file, w.text));
    const unlabelled = parsed
      .filter((w: any) => ['test', 'gate', 'monitor', 'e2e', 'deploy_smoke'].includes(w.kind))
      .filter((w: any) => w.environments.length === 0 && w.flags.length === 0 && w.triggers.workflow_dispatch === false)
      .map((w: any) => w.file);
    expect(unlabelled).toEqual([]);
  });

  it('runs no browser suite against production (VTID-04648)', () => {
    const flagged = workflows
      .map((w) => lib.parseWorkflow('platform', w.file, w.text))
      .filter((w: any) => w.flags.includes('ui_test_touches_production'))
      .map((w: any) => w.file);
    expect(flagged).toEqual([]);
  });

  it('catalogues TEST-CATALOG.yml itself as a job, not a test', () => {
    const w = lib.parseWorkflow('platform', 'TEST-CATALOG.yml', readFileSync(join(REPO_ROOT, '.github/workflows/TEST-CATALOG.yml'), 'utf8'));
    expect(['job', 'other']).toContain(w.kind);
  });
});
