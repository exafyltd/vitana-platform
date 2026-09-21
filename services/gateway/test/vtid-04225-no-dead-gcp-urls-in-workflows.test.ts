/**
 * VTID-04225 — no workflow may point at the decommissioned GCP estate.
 *
 * GCP project `lovable-vitana-vers1` had billing disabled and its Cloud Run
 * `gateway` service deleted on 2026-08-16 (VTID-03599/VTID-03649). Five
 * workflows that feed the autonomous Dev Autopilot / self-healing loops
 * kept POSTing to `gateway-q74ibpv6ia-uc.a.run.app` anyway — DEV-AUTOPILOT.yml
 * answered `404 Page not found` on every one of its twice-daily runs (run #324,
 * 2026-09-21), so no scan ever reached autopilot_recommendations and the
 * whole loop starved with a red-but-ignored cron as the only symptom.
 *
 * Same defect family as VTID-03696 (a workflow `paths:` list that drifted
 * from its guard for 30+ runs): a dead URL in a workflow is invisible when
 * reading the YAML and nothing had a test. This one does. It fails the build
 * the moment ANY workflow references a `*.run.app` host or the dead project
 * id — there is no allowlist, because the retired GCP-only workflows were
 * deleted rather than kept (CLAUDE.md §9 already listed them as dead).
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const E2E = path.resolve(__dirname, '../../../e2e');
const STAGING_GATEWAY = 'https://preview-aws-gateway.vitanaland.com';
const STAGING_FRONTEND = 'https://preview-aws.vitanaland.com';

const DEAD_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'Cloud Run host (*.run.app)', re: /\.run\.app/ },
  { label: 'decommissioned GCP project id', re: /lovable-vitana-vers1/ },
];

function workflowFiles(): string[] {
  return fs
    .readdirSync(WF)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

describe('VTID-04225: no .github/workflows/*.yml references the decommissioned GCP estate', () => {
  const files = workflowFiles();

  it('scans a non-trivial number of workflow files (guard against a wrong path)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  for (const { label, re } of DEAD_PATTERNS) {
    it(`no workflow references a ${label}`, () => {
      const offenders: string[] = [];
      for (const f of files) {
        const text = fs.readFileSync(path.join(WF, f), 'utf8');
        text.split('\n').forEach((line, i) => {
          if (re.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe('VTID-04225: the loop-feeding workflows target the AWS STAGING gateway (staging-first, §16)', () => {
  const read = (f: string) => fs.readFileSync(path.join(WF, f), 'utf8');

  it('DEV-AUTOPILOT.yml POSTs the scan to staging by default, prod only via an explicit gateway_url dispatch input', () => {
    const y = read('DEV-AUTOPILOT.yml');
    expect(y).toContain(`GATEWAY_URL: \${{ github.event.inputs.gateway_url || '${STAGING_GATEWAY}' }}`);
    expect(y).toMatch(/gateway_url:\n\s+description:/);
    // the cron itself never carries a gateway_url, so it can only ever hit staging
    expect(y).toMatch(/cron: "0 7,19 \* \* \*"/);
  });

  it('DEV-AUTOPILOT-IMPACT.yml ingests impact findings into the staging gateway', () => {
    expect(read('DEV-AUTOPILOT-IMPACT.yml')).toContain(`GATEWAY_URL: ${STAGING_GATEWAY}`);
  });

  it('E2E-ORB-MONITOR.yml tests the staging Command Hub and reports failures to the staging self-healing endpoint', () => {
    const y = read('E2E-ORB-MONITOR.yml');
    expect(y).toContain(`HUB_URL: ${STAGING_GATEWAY}`);
    expect(y).toContain(`GATEWAY_URL: ${STAGING_GATEWAY}`);
    expect(y).toContain('/api/v1/self-healing/report');
  });

  it('E2E-TEST-RUN.yml uses the staging gateway for the hub and the self-healing report', () => {
    const y = read('E2E-TEST-RUN.yml');
    expect(y).toContain(`HUB_URL: ${STAGING_GATEWAY}`);
    expect(y).toContain(`GATEWAY_URL: ${STAGING_GATEWAY}`);
  });

  it('SCREEN-LOAD-TIMING.yml reports timings to the staging gateway', () => {
    expect(read('SCREEN-LOAD-TIMING.yml')).toContain(`GATEWAY_URL: ${STAGING_GATEWAY}`);
  });

  it('VISUAL-VERIFY-FRONTEND.yml defaults to the staging frontend', () => {
    const y = read('VISUAL-VERIFY-FRONTEND.yml');
    expect(y).toContain(`default: '${STAGING_FRONTEND}'`);
  });

  it('the retired GCP-only workflows are gone, not merely disabled', () => {
    for (const f of [
      'EXEC-DEPLOY.yml', 'STAGE-DEPLOY.yml', 'DEPLOY-ORB-AGENT.yml', 'DEPLOY-AUTOPILOT-JOB.yml',
      'SET-OPENAI-KEY.yml', 'VTID-OPS-JOURNEY-V2.yml', 'PROVISION-MEMORYSTORE.yml',
    ]) {
      expect(fs.existsSync(path.join(WF, f))).toBe(false);
    }
  });

  it('SMOKE-WELCOME-GREETING.yml no longer waits on the retired EXEC-DEPLOY workflow_run', () => {
    const y = read('SMOKE-WELCOME-GREETING.yml');
    expect(y).not.toContain('Exec Deploy (VTID Bridge)');
    expect(y).toContain('workflows: ["AWS Stage Deploy Gateway (ECS)"]');
  });
});

describe('VTID-04225: the e2e harness defaults match the workflows', () => {
  it('playwright.config.ts and fixtures/test-users.ts default HUB_URL to the staging gateway', () => {
    for (const f of ['playwright.config.ts', 'fixtures/test-users.ts']) {
      const text = fs.readFileSync(path.join(E2E, f), 'utf8');
      expect(text).not.toMatch(/\.run\.app/);
      expect(text).toContain(`process.env.HUB_URL || '${STAGING_GATEWAY}'`);
    }
  });
});

describe('VTID-04225: the staging gateway task def carries the credentials those workflows present', () => {
  const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

  it('pins DEV_AUTOPILOT_SCAN_TOKEN from the repo secret (requireScanToken rejects everything when it is unset)', () => {
    expect(staging).toContain('DEV_AUTOPILOT_SCAN_TOKEN_VALUE: ${{ secrets.DEV_AUTOPILOT_SCAN_TOKEN }}');
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_SCAN_TOKEN", value:\$SCAN_TOKEN\}/);
    expect(staging).toContain('"DEV_AUTOPILOT_SCAN_TOKEN",');
  });

  it('wires GATEWAY_SERVICE_TOKEN to the same secret the prod task def maps it to (require-service-or-admin.ts fails closed without it)', () => {
    expect(staging).toContain('"SEC_SERVICE_TOKEN:vitana/supabase/prod/service-role-key"');
    expect(staging).toMatch(/\{name:"GATEWAY_SERVICE_TOKEN", valueFrom:\$SEC_SERVICE_TOKEN\}/);
  });

  it('wires GATEWAY_INTERNAL_TOKEN only when its secret exists (ERP-bridge pattern — never fails a deploy)', () => {
    expect(staging).toContain('vitana/gateway/staging/internal-token');
    expect(staging).toMatch(/if \$SEC_INTERNAL_TOKEN != "" then/);
    expect(staging).toMatch(/\{name:"GATEWAY_INTERNAL_TOKEN", valueFrom:\$SEC_INTERNAL_TOKEN\}/);
  });

  it('adds none of the three to the prod gateway workflow (prod promotion is a separate decision)', () => {
    expect(prod).not.toContain('DEV_AUTOPILOT_SCAN_TOKEN');
    expect(prod).not.toContain('SEC_INTERNAL_TOKEN');
  });
});
