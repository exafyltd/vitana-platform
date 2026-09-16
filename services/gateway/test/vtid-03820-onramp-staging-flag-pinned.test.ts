/**
 * VTID-03820 follow-up — the staging task def now PINS
 * OPERATOR_EXECUTION_ONRAMP_ENABLED to the exact string "true", per an
 * explicit platform-owner request to enable and test the Operator Console
 * DeepSeek execution on-ramp on staging.
 *
 * isOnRampEnabled() (operator-execution-onramp.ts) checks for the literal
 * string "true" — unset/"false"/a typo all stay disabled, matching this
 * codebase's own established convention for a new autonomy surface
 * (ORB_FULL_DUPLEX_ENABLED, etc.). Enabling this means the Operator
 * Console chat (autopilot_execute_task tool) can cause a real pull
 * request against this repo — there is one GitHub repo regardless of
 * which gateway environment triggers it. Every other gate (target VTID
 * spec_status='approved' + non-terminal, the full reused
 * approveAutoExecute() safety gate) is unchanged.
 *
 * Deliberately NOT pinned on the prod deploy workflow — promoting it
 * there is a separate, later decision once a real on-ramp execution has
 * been observed end-to-end on staging.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);

const yml = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-03820 follow-up: staging pins OPERATOR_EXECUTION_ONRAMP_ENABLED', () => {
  it('upserts the flag as the exact string "true"', () => {
    expect(yml).toMatch(
      /\{name:"OPERATOR_EXECUTION_ONRAMP_ENABLED", value:"true"\}/,
    );
  });

  it('strips the inherited value first, so a stale one cannot survive', () => {
    const stripBlock = yml.slice(
      yml.indexOf('.containerDefinitions[0].environment |='),
      yml.indexOf('.containerDefinitions[0].secrets |='),
    );
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"OPERATOR_EXECUTION_ONRAMP_ENABLED"');
  });

  it('is deliberately NOT pinned on the prod deploy workflow yet', () => {
    const prodWorkflow = path.resolve(
      __dirname,
      '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
    );
    const prodYml = fs.readFileSync(prodWorkflow, 'utf8');
    expect(prodYml).not.toContain('OPERATOR_EXECUTION_ONRAMP_ENABLED');
  });

  it('DEEPSEEK_API_KEY secret is already wired on the same task definition (a real prerequisite for the on-ramp)', () => {
    const secretsBlock = yml.slice(
      yml.indexOf('.containerDefinitions[0].secrets |='),
      yml.indexOf('| del(.taskDefinitionArn'),
    );
    expect(secretsBlock).toContain('"DEEPSEEK_API_KEY"');
  });
});
