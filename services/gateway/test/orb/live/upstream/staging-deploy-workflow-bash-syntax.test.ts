/**
 * VTID-03788 — regression guard for a defect class that has now broken
 * AWS-STAGE-DEPLOY-GATEWAY.yml's task-definition-update step TWICE:
 * an apostrophe inside a `run: |` step's embedded jq program prematurely
 * closes the surrounding single-quoted bash string. The file's own inline
 * comment (near the SEC_JWT resolution loop) already names the first
 * incident; VTID-03787's own diagnostic-instrumentation flag comment
 * reproduced it a second time — a fresh "user's" in a comment that lives
 * INSIDE the jq single-quoted program, not outside it like the file's own
 * warning says to keep it.
 *
 * Real cost: every push-triggered staging deploy on the VTID-03787 branch
 * (4 consecutive runs, including the eventual merge to main) failed with
 * 0 jobs / a bash syntax error, silently — GitHub Actions reports this as
 * workflow run failure with no job ever created, easy to miss unless you
 * go looking. Staging kept serving a stale commit the whole time with no
 * loud signal pointing at the actual cause.
 *
 * This test doesn't just re-check the specific broken line — it parses
 * EVERY `run:` step in EVERY job of both gateway deploy workflows with a
 * real YAML parser (js-yaml, already a dependency) and shells each one out
 * to `bash -n`, so any future step anywhere in these files with a genuine
 * bash syntax error (this class or any other) fails CI loudly instead of
 * silently killing every job in the run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

const WORKFLOWS = [
  path.resolve(__dirname, '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'),
  path.resolve(__dirname, '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'),
];

interface WorkflowStep {
  name?: string;
  run?: string;
  shell?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  jobs?: Record<string, WorkflowJob>;
}

function bashSteps(workflowPath: string): { jobId: string; stepName: string; run: string }[] {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const doc = yaml.load(raw) as WorkflowDoc;
  const out: { jobId: string; stepName: string; run: string }[] = [];
  for (const [jobId, job] of Object.entries(doc.jobs || {})) {
    for (const step of job.steps || []) {
      if (typeof step.run !== 'string') continue;
      // Only bash-family shells use bash syntax; skip anything explicitly
      // set to something else (none of these workflows do today, but the
      // check should stay honest if that ever changes).
      if (step.shell && !/bash/.test(step.shell)) continue;
      out.push({ jobId, stepName: step.name || '(unnamed step)', run: step.run });
    }
  }
  return out;
}

describe('VTID-03788: every run: step in the gateway deploy workflows is valid bash', () => {
  for (const workflowPath of WORKFLOWS) {
    const workflowName = path.basename(workflowPath);

    it(`${workflowName}: YAML parses and has at least one bash run: step`, () => {
      const steps = bashSteps(workflowPath);
      expect(steps.length).toBeGreaterThan(0);
    });

    it(`${workflowName}: every run: step passes bash -n`, () => {
      const steps = bashSteps(workflowPath);
      const failures: string[] = [];

      for (const { jobId, stepName, run } of steps) {
        try {
          execFileSync('bash', ['-n'], { input: run, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err: any) {
          const stderr = err.stderr ? err.stderr.toString() : String(err.message || err);
          failures.push(`job "${jobId}" step "${stepName}": ${stderr.trim()}`);
        }
      }

      expect(failures).toEqual([]);
    });
  }

  it('AWS-STAGE-DEPLOY-GATEWAY.yml: the task-definition update step has no apostrophe inside its jq program (VTID-03787/VTID-03788 regression)', () => {
    const steps = bashSteps(WORKFLOWS[0]);
    const updateStep = steps.find((s) => /NEW_DEF=\$\(aws ecs describe-task-definition/.test(s.run));
    expect(updateStep).toBeDefined();

    // The jq program is the single-quoted string passed as the last
    // argument to `jq`. Isolate it (from the opening `'` right after the
    // --arg list to the closing `')` before NEW_ARN=) and assert it
    // carries no apostrophe — an apostrophe there closes the string early,
    // which is exactly what broke this step twice.
    const run = updateStep!.run;
    const jqStart = run.indexOf("--arg TASK_ROLE \"$TASK_ROLE_ARN\" '") + "--arg TASK_ROLE \"$TASK_ROLE_ARN\" '".length;
    const jqEnd = run.indexOf("')", jqStart);
    expect(jqStart).toBeGreaterThan(0);
    expect(jqEnd).toBeGreaterThan(jqStart);
    const jqProgram = run.slice(jqStart, jqEnd);
    expect(jqProgram).not.toContain("'");
  });
});
