/**
 * VTID-04593: the Dev Autopilot planner runs on DeepSeek Flash and the coding
 * agent on Bedrock Claude Sonnet 4.6 (owner decision 2026-09-26). Sonnet 5 is
 * listed on the account but not invokable (AccessDeniedException), so it is
 * not the default.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEV_PLANNER_DEFAULT, DEV_WORKER_DEFAULT, devPlannerModel, devWorkerModel } from '../src/services/dev-pipeline-models';

describe('dev pipeline model resolution', () => {
  it('defaults: planner DeepSeek Flash, coding agent Bedrock Sonnet 4.6', () => {
    expect(devPlannerModel({})).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(devWorkerModel({})).toEqual({ provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });
  });

  it('an env pair overrides, a half-set pair does not', () => {
    expect(devWorkerModel({ AGENT_PRIMARY_PROVIDER: 'deepseek', AGENT_PRIMARY_MODEL: 'deepseek-flash' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(devWorkerModel({ AGENT_PRIMARY_PROVIDER: 'deepseek' })).toEqual(DEV_WORKER_DEFAULT);
    expect(devPlannerModel({ DEV_PLANNER_PROVIDER: 'bedrock', DEV_PLANNER_MODEL: 'eu.anthropic.claude-sonnet-4-6' }))
      .toEqual({ provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });
  });

  it('refuses Google and the direct Anthropic API', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(devWorkerModel({ AGENT_PRIMARY_PROVIDER: 'vertex', AGENT_PRIMARY_MODEL: 'gemini-2.5-pro' })).toEqual(DEV_WORKER_DEFAULT);
    expect(devPlannerModel({ DEV_PLANNER_PROVIDER: 'anthropic', DEV_PLANNER_MODEL: 'claude-sonnet-4-6' })).toEqual(DEV_PLANNER_DEFAULT);
    warn.mockRestore();
  });
});

describe('wiring', () => {
  const SRC = path.resolve(__dirname, '../src');
  const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

  it('the on-ramp stamps the coding agent model on the execution row', () => {
    const s = read('services/operator-execution-onramp.ts');
    expect(s).toContain('llm_on_ramp_override: { provider: WORKER.provider, model: WORKER.model }');
    expect(s).not.toMatch(/llm_on_ramp_override: \{ provider: 'deepseek'/);
  });

  it('the agent executor defaults to devWorkerModel()', () => {
    const s = read('services/autopilot-agent/run-agent-execution.ts');
    expect(s).toContain('const AGENT_PRIMARY = devWorkerModel();');
    expect(s).toContain('extractLlmOnRampOverride(exec.metadata) || AGENT_PRIMARY');
  });

  it('the planner and the spec generator override the planner stage primary', () => {
    const plan = read('services/dev-autopilot-planning.ts');
    expect(plan).toMatch(/providerOverride: planner\.provider,\s*modelOverride: planner\.model/);
    const spec = read('routes/specs.ts');
    expect(spec).toMatch(/providerOverride: specPlanner\.provider,\s*modelOverride: specPlanner\.model/);
  });
});
