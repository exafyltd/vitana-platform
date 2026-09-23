/**
 * VTID-04380: the staging task def pins GATEWAY_URL to the staging host, so
 * nothing on staging (self-healing snapshots, autopilot verification, the
 * event loop) falls back to production or to a decommissioned GCP host.
 */
import * as fs from 'fs';
import * as path from 'path';

const repo = path.resolve(__dirname, '../../..');
const stage = fs.readFileSync(path.join(repo, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(repo, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

describe('GATEWAY_URL on the staging task def', () => {
  it('is stripped then re-added with the staging host', () => {
    expect(stage).toContain('"NAV_CONTINUATION_BIND","VITANA_ENV","GATEWAY_URL",');
    expect(stage).toContain('{name:"GATEWAY_URL", value:"https://preview-aws-gateway.vitanaland.com"}');
  });
  it('is not pinned to the staging host on prod', () => {
    expect(prod).not.toContain('preview-aws-gateway.vitanaland.com"}');
  });
});

describe('no decommissioned GCP defaults in autopilot verification', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/autopilot-verification.ts'), 'utf8');
  it('gateway and oasis-operator default to AWS hosts', () => {
    expect(src).toContain("process.env.GATEWAY_URL || 'https://gateway.vitanaland.com'");
    expect(src).toContain("process.env.OASIS_OPERATOR_URL || 'https://dr-oasis-operator.vitanaland.com'");
    expect(src).not.toMatch(/gateway-lovable-vitana-vers1/);
  });
});
