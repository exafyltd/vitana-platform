/**
 * VTID-04474 — the orchestrator's opt-in agents are pinned ON for staging only.
 * The support and commerce specialists and delegation persistence were
 * documented as staging-pinned but the live staging task def carried none of
 * them, so they had never run anywhere. Production is not touched.
 */
import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const stage = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

const FLAGS = [
  'ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED',
  'ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED',
  'ORCHESTRATOR_DELEGATION_PERSIST_ENABLED',
];

describe('VTID-04474 staging orchestrator flags', () => {
  it.each(FLAGS)('%s is stripped then re-added as exact "true" on staging', (flag) => {
    expect(stage).toContain(`"${flag}"`);
    expect(stage).toContain(`{name:"${flag}", value:"true"}`);
  });

  // VTID-04605: the owner approved the specialists for production — prod now
  // pins the same three flags (and the same values) as staging.
  it.each(FLAGS)('%s is declared "true" on the prod workflow too (VTID-04605)', (flag) => {
    expect(prod).toContain(`{name:"${flag}", value:"true"}`);
    expect(prod).toMatch(new RegExp(`IN\\([^)]*"${flag}"`));
  });

  it('does not enable run leases (their migration is not applied)', () => {
    expect(stage).not.toContain('ORCHESTRATOR_RUN_LEASE_ENABLED');
  });
});
