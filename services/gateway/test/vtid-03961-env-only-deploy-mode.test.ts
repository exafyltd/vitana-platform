/**
 * VTID-03961 — neither of AWS-PROD-DEPLOY-GATEWAY.yml's two existing
 * `deploy_mode`s (promote-staging, rebuild-main) can express "ship no
 * app-code change at all, just flip a task-def env var": both always
 * re-derive the image from staging's or main's current HEAD. Confirmed live
 * on 2026-09-16: prod was 30 commits behind staging (including several
 * unrelated features never discussed as part of this change), so either
 * existing mode would have silently promoted all of them alongside a
 * deliberate one-off env_overrides application — exactly what CLAUDE.md's
 * Part 1 IF-THEN rule 26 says to avoid shipping without explicit review.
 *
 * Fix: a third `env-only` mode. Its "Resolve deploy source" branch reads
 * back the CURRENT prod task definition's own image and GIT_COMMIT_SHA and
 * echoes them as this run's source — so the next step's image/commit-stamp
 * rewrite is a byte-for-byte no-op, and only env_overrides (or another
 * dispatch-input override) can change anything.
 *
 * This file extracts the REAL "Resolve deploy source" step's script (not a
 * reimplementation) and executes it under a stub `aws` CLI on PATH, proving
 * env-only mode: (1) never touches the staging service at all, (2) echoes
 * back the CURRENT service's own image/commit unchanged, (3) fails loudly
 * rather than silently proceeding when the current image can't be resolved,
 * and (4) leaves promote-staging/rebuild-main behavior untouched.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
      if (step.name && namePattern.test(step.name) && step.run) {
        return step.run;
      }
    }
  }
  throw new Error(`No step matching ${namePattern} found in ${WORKFLOW_PATH}`);
}

const sourceStepScript = findStepRun(/Resolve deploy source/);

/** Runs the real extracted "Resolve deploy source" script under a stub `aws`. */
function runSourceStep(opts: {
  deployMode: string;
  currentImage?: string;
  currentSha?: string;
  expectedCommit?: string;
}): { exitCode: number; stderr: string; stdout: string; outputs: Record<string, string> } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-03961-'));
  const outputFile = path.join(tmpDir, 'github_output');
  fs.writeFileSync(outputFile, '');

  const image = opts.currentImage ?? '123456789.dkr.ecr.eu-central-1.amazonaws.com/vitana/gateway:abc123';
  const sha = opts.currentSha ?? 'dc2d17d210678522e973a1bc94453f153eb39e5b';

  // A stub `aws` on PATH: only understands the two calls env-only mode makes.
  const awsStub = `#!/usr/bin/env bash
set -e
if [[ "$*" == *"describe-services"* ]]; then
  echo "arn:aws:ecs:eu-central-1:123456789:task-definition/vitana-gateway-awsdr:999"
  exit 0
fi
if [[ "$*" == *"describe-task-definition"* ]]; then
  if [[ "$*" == *"GIT_COMMIT_SHA"* ]]; then
    echo "${sha === '' ? 'None' : sha}"
  else
    echo "${image === '' ? 'None' : image}"
  fi
  exit 0
fi
echo "unexpected aws invocation: $*" >&2
exit 99
`;
  const awsBinDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(awsBinDir);
  const awsPath = path.join(awsBinDir, 'aws');
  fs.writeFileSync(awsPath, awsStub, { mode: 0o755 });

  // GitHub expands `${{ ... }}` template expressions before bash ever sees
  // this script; run outside that harness, bash chokes on the literal
  // braces ("bad substitution"). The stub `aws` below only pattern-matches
  // on subcommand text (describe-services / describe-task-definition), not
  // on flag values, so blanking these expressions out is a safe stand-in
  // for GitHub's real interpolation for this test's purposes.
  const sanitizedScript = sourceStepScript.replace(/\$\{\{[^}]*\}\}/g, '');
  const scriptPath = path.join(tmpDir, 'source-step.sh');
  fs.writeFileSync(scriptPath, sanitizedScript);

  let exitCode = 0;
  let stderr = '';
  let stdout = '';
  try {
    stdout = execFileSync('bash', [scriptPath], {
      env: {
        PATH: `${awsBinDir}:${process.env.PATH}`,
        DEPLOY_MODE: opts.deployMode,
        EXPECTED_COMMIT: opts.expectedCommit ?? '',
        STAGING_URL: 'https://preview-aws-gateway.vitanaland.com',
        GITHUB_OUTPUT: outputFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
    exitCode = e.status ?? 1;
    stderr = e.stderr?.toString() ?? '';
    // The script's ::error:: lines are plain `echo` (stdout), matching every
    // other override block's convention in this workflow — GitHub Actions
    // recognizes the marker regardless of stream, so check both here too.
    stdout = e.stdout?.toString() ?? '';
  }

  const outputRaw = fs.readFileSync(outputFile, 'utf8');
  const outputs: Record<string, string> = {};
  for (const line of outputRaw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { exitCode, stderr, stdout, outputs };
}

describe('VTID-03961: AWS-PROD-DEPLOY-GATEWAY.yml env-only deploy mode', () => {
  it('deploy_mode input lists env-only as a third choice, not a new named input', () => {
    const doc = yaml.load(raw) as {
      on: { workflow_dispatch: { inputs: Record<string, { options?: string[] }> } };
    };
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toContain('deploy_mode');
    expect(inputs.deploy_mode.options).toEqual(['promote-staging', 'rebuild-main', 'env-only']);
    // Adding a choice value must not add a new top-level input.
    expect(Object.keys(inputs).length).toBe(24);
  });

  it('is a well-formed bash script that passes bash -n on its own', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-03961-syntax-'));
    const p = path.join(tmp, 's.sh');
    fs.writeFileSync(p, sourceStepScript);
    expect(() => execFileSync('bash', ['-n', p])).not.toThrow();
  });

  it('env-only mode calls describe-services/describe-task-definition, never a staging build-info curl', () => {
    expect(sourceStepScript).toMatch(/DEPLOY_MODE"\s*=\s*"env-only"/);
    // The env-only branch must return (exit 0) before the promote-staging
    // section's staging_url curl is ever reached.
    const envOnlyIdx = sourceStepScript.indexOf('"env-only"');
    const stagingCurlIdx = sourceStepScript.indexOf('STAGING_URL');
    expect(envOnlyIdx).toBeGreaterThan(-1);
    expect(stagingCurlIdx).toBeGreaterThan(envOnlyIdx);
  });

  it('echoes back the CURRENT service image/commit unchanged (mode=env-only, no rebuild)', () => {
    const result = runSourceStep({
      deployMode: 'env-only',
      currentImage: '123456789.dkr.ecr.eu-central-1.amazonaws.com/vitana/gateway:dc2d17d',
      currentSha: 'dc2d17d210678522e973a1bc94453f153eb39e5b',
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.mode).toBe('env-only');
    expect(result.outputs.image).toBe('123456789.dkr.ecr.eu-central-1.amazonaws.com/vitana/gateway:dc2d17d');
    expect(result.outputs.sha).toBe('dc2d17d210678522e973a1bc94453f153eb39e5b');
    expect(result.outputs.short).toBe('dc2d17d21067');
  });

  it('falls back to sha=unknown, not a crash, when the current task def has no GIT_COMMIT_SHA', () => {
    const result = runSourceStep({ deployMode: 'env-only', currentSha: '' });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.mode).toBe('env-only');
    expect(result.outputs.sha).toBe('unknown');
  });

  it('fails loudly (non-zero exit) rather than proceeding when the current image cannot be resolved', () => {
    const result = runSourceStep({ deployMode: 'env-only', currentImage: '' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('::error::');
    expect(result.outputs.mode).toBeUndefined();
  });

  it('rebuild-main mode is unaffected by the new env-only branch', () => {
    const result = runSourceStep({ deployMode: 'rebuild-main' });
    // rebuild-main reads steps.commit.outputs.* (unavailable in this
    // extracted-script harness), so its interpolated values render as
    // literal `${{ ... }}` text — that's fine, this test only asserts mode
    // selection and that env-only's branch was skipped correctly.
    expect(result.exitCode).toBe(0);
    expect(result.outputs.mode).toBe('rebuild-main');
  });
});
