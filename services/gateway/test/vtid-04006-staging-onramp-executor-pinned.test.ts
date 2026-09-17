/**
 * VTID-04006 — staging routes operator-instructed executions to the agent
 * executor (Test Run #4). OPERATOR_ONRAMP_EXECUTOR=agent is pinned on the
 * AWS staging gateway workflow only; prod stays on the single-shot default.
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

describe('VTID-04006: staging pins OPERATOR_ONRAMP_EXECUTOR=agent', () => {
  it('pins the exact value "agent" on the staging gateway task def', () => {
    expect(staging).toMatch(/\{name:"OPERATOR_ONRAMP_EXECUTOR", value:"agent"\}/);
  });

  it('strips an inherited value first, so a stale one cannot survive a deploy', () => {
    const stripBlock = staging.slice(
      staging.indexOf('.containerDefinitions[0].environment |='),
      staging.indexOf('.containerDefinitions[0].secrets |='),
    );
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"OPERATOR_ONRAMP_EXECUTOR"');
  });

  it('is deliberately NOT pinned on the prod gateway deploy workflow', () => {
    expect(prod).not.toContain('OPERATOR_ONRAMP_EXECUTOR');
  });

  it('sits behind the on-ramp flag and the ECS executor dispatch it depends on', () => {
    expect(staging).toMatch(/\{name:"OPERATOR_EXECUTION_ONRAMP_ENABLED", value:"true"\}/);
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_USE_JOB", value:"true"\}/);
  });
});
