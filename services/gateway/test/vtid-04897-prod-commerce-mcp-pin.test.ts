/**
 * VTID-04897 — Commerce MCP (VTID-04847) is on in production.
 *
 * The production deploy pins COMMERCE_MCP_ENABLED=true in its own step, after
 * the reward-sweep pin (VTID-04896) and before the task definition is
 * registered. Functional coverage of the endpoint itself is
 * test/commerce-mcp.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { isCommerceMcpEnabled } from '../src/services/commerce-mcp';

const prodRaw = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const steps = (yaml.load(prodRaw) as any).jobs['build-push-deploy'].steps as Array<{ name?: string; run?: string }>;
const at = (prefix: string) => steps.findIndex((s) => (s.name ?? '').startsWith(prefix));

describe('production deploy turns Commerce MCP on', () => {
  it('pins COMMERCE_MCP_ENABLED to "true" before registration, after the sweep-off pin', () => {
    const i = at('Build task-definition (Commerce MCP)');
    expect(i).toBeGreaterThan(-1);
    expect(steps[i].run).toContain('{name:"COMMERCE_MCP_ENABLED", value:"true"}');
    expect(steps[i].run).toContain('select(.name != "COMMERCE_MCP_ENABLED")');
    expect(i).toBeGreaterThan(at('Build task-definition (reward sweep off)'));
    expect(i).toBeLessThan(at('Build task-definition (2/2'));
  });

  it('that value is exactly what turns the endpoint on', () => {
    expect(isCommerceMcpEnabled({ COMMERCE_MCP_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isCommerceMcpEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('the generated flag pins show it on for staging and production; the sweep stays off', () => {
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.COMMERCE_MCP_ENABLED).toEqual({ staging: 'true', prod: 'true' });
    expect(GATEWAY_WORKFLOW_PINS.REWARD_SWEEP_ENABLED).toEqual({ staging: null, prod: 'false' });
  });
});
