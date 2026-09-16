/**
 * VTID-03958 — AWS-PROD-DEPLOY-GATEWAY.yml sat at GitHub's hard ceiling of 25
 * `workflow_dispatch` inputs (see workflow-dispatch-input-limit.test.ts). A
 * new production capability (OPERATOR_EXECUTION_ONRAMP_ENABLED, requested in
 * conversation) could not be added as a 26th named input without breaking
 * every future dispatch of this workflow, including the Command Hub PUBLISH
 * button — the exact failure mode VTID-03697 already documented.
 *
 * Fix: retire the two legacy Nova canary allowlist inputs
 * (nova_canary_user_ids / nova_canary_tenant_ids — narrowest, least
 * load-bearing pair; confirmed no caller of this workflow ever passes them,
 * see the PR body) to free two slots, and add ONE new generic
 * `env_overrides` JSON-object input as the escape hatch for any future
 * one-off flag, including this one. Net input count: 24 (was 25).
 *
 * This file:
 *  1. Confirms the two retired inputs are gone and env_overrides exists.
 *  2. Pins the net input count so a future PR notices if it drifts back to
 *     one-input-per-var.
 *  3. Extracts the REAL env_overrides jq block from the workflow file (not a
 *     reimplementation) and executes it with the real `jq` binary against a
 *     sample task-definition JSON, proving the generic upsert actually
 *     works for an arbitrary key, replaces an existing key, coerces a
 *     non-string JSON value, and — critically — that malformed or
 *     non-object JSON fails loudly (exit non-zero with an ::error:: line)
 *     rather than silently no-op'ing or corrupting NEW_DEF.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

const WORKFLOW_PATH = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
);
const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');

interface WorkflowStep {
  name?: string;
  run?: string;
}
interface WorkflowDoc {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function findStepRun(namePattern: RegExp): string {
  const doc = yaml.load(raw) as WorkflowDoc;
  for (const job of Object.values(doc.jobs || {})) {
    for (const step of job.steps || []) {
      if (step.name && namePattern.test(step.name) && typeof step.run === 'string') {
        return step.run;
      }
    }
  }
  throw new Error(`No step found matching ${namePattern}`);
}

/** Pull the `if [ -n "$ENV_OVERRIDES_INPUT" ]; then ... fi` block verbatim. */
function extractEnvOverridesBlock(run: string): string {
  const start = run.indexOf('if [ -n "$ENV_OVERRIDES_INPUT" ]; then');
  expect(start).toBeGreaterThan(-1);
  const registerIdx = run.indexOf('NEW_ARN=$(aws ecs register-task-definition');
  expect(registerIdx).toBeGreaterThan(start);
  return run.slice(start, registerIdx);
}

/**
 * Runs the extracted block for real, seeding NEW_DEF and ENV_OVERRIDES_INPUT,
 * and prints the resulting NEW_DEF so the test can parse it back out. This is
 * the actual jq program from the workflow file, not a copy.
 */
const MARKER = '===NEW_DEF_FOLLOWS===';

function runBlock(
  block: string,
  envOverridesInput: string,
  seedEnvironment: unknown[],
): { code: number; stdout: string; stderr: string; newDef: unknown | null } {
  const seedDef = JSON.stringify({ containerDefinitions: [{ environment: seedEnvironment }] });
  // NEW_DEF is reassigned via `jq` WITHOUT `-c` in the real workflow (matches
  // the existing style of every other override block in this file), so its
  // JSON is pretty-printed (multi-line). A marker line, not "last line of
  // output", is what correctly isolates it from the "Applying env_overrides:
  // [...]" log line the block itself also prints to stdout.
  const script = `
set -e
NEW_DEF='${seedDef.replace(/'/g, "'\\''")}'
${block}
echo "${MARKER}"
echo "$NEW_DEF"
`;
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('bash', ['-c', script], {
      env: { ...process.env, ENV_OVERRIDES_INPUT: envOverridesInput },
      encoding: 'utf8',
    });
  } catch (err: any) {
    code = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout ? err.stdout.toString() : '';
    stderr = err.stderr ? err.stderr.toString() : String(err.message || err);
  }
  let newDef: unknown | null = null;
  const markerIdx = stdout.indexOf(MARKER);
  if (markerIdx > -1) {
    const jsonText = stdout.slice(markerIdx + MARKER.length).trim();
    if (jsonText) {
      try {
        newDef = JSON.parse(jsonText);
      } catch {
        newDef = null;
      }
    }
  }
  return { code, stdout, stderr, newDef };
}

describe('VTID-03958: AWS-PROD-DEPLOY-GATEWAY.yml stays under the 25-input ceiling via env_overrides', () => {
  it('removes nova_canary_user_ids and nova_canary_tenant_ids as named inputs', () => {
    const doc = yaml.load(raw) as any;
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(inputs.nova_canary_user_ids).toBeUndefined();
    expect(inputs.nova_canary_tenant_ids).toBeUndefined();
  });

  it('adds env_overrides as a named input', () => {
    const doc = yaml.load(raw) as any;
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(inputs.env_overrides).toBeDefined();
    expect(inputs.env_overrides.required).toBe(false);
    expect(inputs.env_overrides.default).toBe('');
  });

  it('net input count is 24 (was 25, at the ceiling, before this change)', () => {
    const doc = yaml.load(raw) as any;
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).length).toBe(24);
  });

  it('the nova_sonic_enabled override block no longer references the removed env wiring', () => {
    const step = findStepRun(/Build task-definition \(2\/2/);
    expect(step).not.toContain('NOVA_USERS_INPUT');
    expect(step).not.toContain('NOVA_TENANTS_INPUT');
    // The env var NAMES the canary allowlist used to upsert must also no
    // longer be touched by the nova_sonic_enabled block specifically (they
    // can still be set generically via env_overrides — this only asserts
    // the DEDICATED block no longer references them).
    const novaBlockStart = step.indexOf('if [ -n "$NOVA_ENABLED_INPUT" ]; then');
    const novaBlockEnd = step.indexOf('\n          fi', novaBlockStart) + '\n          fi'.length;
    const novaBlock = step.slice(novaBlockStart, novaBlockEnd);
    expect(novaBlock).not.toContain('NOVA_SONIC_CANARY_USER_IDS');
    expect(novaBlock).not.toContain('NOVA_SONIC_CANARY_TENANT_IDS');
  });

  it('wires ENV_OVERRIDES_INPUT from inputs.env_overrides on the register step', () => {
    const step = findStepRun(/Build task-definition \(2\/2/);
    // Confirmed via the step's own `env:` block in the YAML doc, not string
    // matching inside `run:` (the env: mapping is separate YAML).
    const doc = yaml.load(raw) as any;
    const job = doc.jobs['build-push-deploy'];
    const stepDoc = job.steps.find((s: any) => /Build task-definition \(2\/2/.test(s.name || ''));
    expect(stepDoc.env.ENV_OVERRIDES_INPUT).toBe('${{ inputs.env_overrides }}');
    expect(step).toContain('ENV_OVERRIDES_INPUT');
  });

  describe('the real extracted jq block, executed against real jq', () => {
    const step = findStepRun(/Build task-definition \(2\/2/);
    const block = extractEnvOverridesBlock(step);

    it('is a non-empty, well-formed bash if/fi block', () => {
      expect(block.length).toBeGreaterThan(0);
      expect(block.trim().startsWith('if [ -n "$ENV_OVERRIDES_INPUT" ]; then')).toBe(true);
      expect(block.trim().endsWith('fi')).toBe(true);
    });

    it('passes bash -n on its own', () => {
      expect(() =>
        execFileSync('bash', ['-n'], { input: `if true; then\n${block}\nfi`, stdio: ['pipe', 'pipe', 'pipe'] }),
      ).not.toThrow();
    });

    it('EMPTY input is a true no-op — NEW_DEF passes through byte-for-byte', () => {
      const seed = [{ name: 'EXISTING_VAR', value: 'old' }];
      const result = runBlock(block, '', seed);
      expect(result.code).toBe(0);
      const parsed = result.newDef as any;
      expect(parsed.containerDefinitions[0].environment).toEqual(seed);
    });

    it('adds a brand-new key with no code change needed (generic, not hardcoded)', () => {
      const seed = [{ name: 'EXISTING_VAR', value: 'old' }];
      const result = runBlock(block, JSON.stringify({ OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true' }), seed);
      expect(result.code).toBe(0);
      const env = (result.newDef as any).containerDefinitions[0].environment as { name: string; value: string }[];
      expect(env).toContainEqual({ name: 'EXISTING_VAR', value: 'old' });
      expect(env).toContainEqual({ name: 'OPERATOR_EXECUTION_ONRAMP_ENABLED', value: 'true' });
    });

    it('upserts (replaces) a key that already exists on the task def', () => {
      const seed = [
        { name: 'EXISTING_VAR', value: 'old' },
        { name: 'SOME_FLAG', value: 'stale' },
      ];
      const result = runBlock(block, JSON.stringify({ SOME_FLAG: 'fresh' }), seed);
      expect(result.code).toBe(0);
      const env = (result.newDef as any).containerDefinitions[0].environment as { name: string; value: string }[];
      // Exactly one SOME_FLAG entry survives, with the new value — not both.
      expect(env.filter((e) => e.name === 'SOME_FLAG')).toEqual([{ name: 'SOME_FLAG', value: 'fresh' }]);
      expect(env).toContainEqual({ name: 'EXISTING_VAR', value: 'old' });
    });

    it('applies multiple keys in one call, generically (to_entries, no fixed arity)', () => {
      const seed: unknown[] = [];
      const result = runBlock(
        block,
        JSON.stringify({ FLAG_A: 'a', FLAG_B: 'b', FLAG_C: 'c' }),
        seed,
      );
      expect(result.code).toBe(0);
      const env = (result.newDef as any).containerDefinitions[0].environment as { name: string; value: string }[];
      expect(env).toEqual(
        expect.arrayContaining([
          { name: 'FLAG_A', value: 'a' },
          { name: 'FLAG_B', value: 'b' },
          { name: 'FLAG_C', value: 'c' },
        ]),
      );
      expect(env.length).toBe(3);
    });

    it('coerces a non-string JSON value to a string (ECS env vars are always strings)', () => {
      const seed: unknown[] = [];
      const result = runBlock(block, JSON.stringify({ SOME_BOOL: true, SOME_NUM: 5 }), seed);
      expect(result.code).toBe(0);
      const env = (result.newDef as any).containerDefinitions[0].environment as { name: string; value: string }[];
      expect(env).toContainEqual({ name: 'SOME_BOOL', value: 'true' });
      expect(env).toContainEqual({ name: 'SOME_NUM', value: '5' });
    });

    it('fails loudly (non-zero exit, ::error::) on malformed JSON — never a silent no-op', () => {
      const seed = [{ name: 'EXISTING_VAR', value: 'old' }];
      const result = runBlock(block, '{not valid json', seed);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('::error::');
      expect(result.stdout + result.stderr).toContain('not valid JSON');
    });

    it('fails loudly on valid JSON that is not an object (e.g. an array or a string)', () => {
      const seed = [{ name: 'EXISTING_VAR', value: 'old' }];
      const arrayResult = runBlock(block, '["not", "an", "object"]', seed);
      expect(arrayResult.code).not.toBe(0);
      expect(arrayResult.stdout + arrayResult.stderr).toContain('::error::');
      expect(arrayResult.stdout + arrayResult.stderr).toContain('must be a JSON OBJECT');

      const stringResult = runBlock(block, '"just a string"', seed);
      expect(stringResult.code).not.toBe(0);
      expect(stringResult.stdout + stringResult.stderr).toContain('::error::');
    });

    it('never partially mutates NEW_DEF on a validation failure — original env is intact on the error path', () => {
      // The malformed-JSON checks run BEFORE any jq pipe over NEW_DEF, so a
      // bad env_overrides value must never reach the upsert at all: the
      // script exits before ever printing the MARKER, so there is no NEW_DEF
      // in its output for anything downstream to consume — corrupted or
      // otherwise.
      const result = runBlock(block, '{bad', [{ name: 'EXISTING_VAR', value: 'old' }]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain(MARKER);
      expect(result.newDef).toBeNull();
    });
  });
});
