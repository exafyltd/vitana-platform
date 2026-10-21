/**
 * VTID-03788 — regression guard, corrected mid-investigation.
 *
 * First hypothesis (real, but NOT the actual blocking cause): an apostrophe
 * inside a `run: |` step's embedded jq program prematurely closes the
 * surrounding single-quoted bash string. The file's own inline comment
 * (near the SEC_JWT resolution loop) already names one incident of this;
 * VTID-03787's own diagnostic-instrumentation flag comment reproduced it a
 * second time. `bash -n` on the extracted step confirmed a real syntax
 * error, so this was fixed and is still guarded below.
 *
 * Fixing that did NOT resolve the actual outage — a THIRD push (the
 * VTID-03788 fix itself) still failed with the identical 0-jobs signature.
 * Root-caused via the real GitHub Actions API (a direct workflow_dispatch
 * call returns the raw parse error, not just a webhook summary):
 * `Invalid Argument - failed to parse workflow: (Line: 184, Col: 14):
 * Exceeded max expression length 21000`. GitHub Actions hard-rejects a
 * workflow file whose `run:` step value is too large — a real, undocumented
 * (in this repo) limit that the "Register task-definition revision" step
 * had been creeping toward for a long time (255 lines of comments vs. ~100
 * lines of actual bash) and finally crossed once VTID-03787's own comment
 * was added. Confirmed empirically, not just theorized: dispatching the
 * exact last-known-good commit (whose same step measured 23,981 characters)
 * via a throwaway branch parsed and queued successfully; the failing
 * version measured 25,111. Fixed by relocating every comment out of the
 * `run:` block into plain YAML comments above it (a pure relocation — bash
 * ignores comments regardless of position, so this changes nothing about
 * what runs; verified line-for-line identical executable content and
 * complete comment-text preservation before this test was written).
 *
 * Real cost: every push/dispatch of this workflow across the VTID-03787 and
 * first VTID-03788 fix attempt (5 consecutive runs, including two separate
 * merges to main) failed with 0 jobs — GitHub Actions reports this as a
 * workflow run failure with no job ever created and no check-run failure
 * message reaching the PR's own CI (the PR's CI never runs THIS workflow —
 * it only runs on push to main / dispatch — so a green PR merge gave zero
 * signal that the actual deploy pipeline was broken). Staging kept serving
 * a stale commit the whole time.
 *
 * This test file parses EVERY `run:` step in EVERY job of both gateway
 * deploy workflows with a real YAML parser (js-yaml, already a dependency):
 *  - shells each one out to `bash -n`, so a genuine bash syntax error (the
 *    apostrophe class or any other) fails CI loudly instead of silently
 *    killing every job in the run;
 *  - asserts every step's `run:` value stays under a conservative size cap,
 *    so this specific "grew past GitHub's real limit" class cannot recur
 *    silently either — the cap (20,000 chars) sits safely under the
 *    confirmed-working 23,981 measurement, not just under the confirmed-
 *    broken 25,111 one.
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

    // VTID-03788 — the actual defect: GitHub Actions rejects the WHOLE
    // workflow file (0 jobs, no per-job CI signal) once a single step's
    // run: value gets too large. 20,000 is chosen deliberately under the
    // empirically-CONFIRMED-WORKING 23,981-char measurement (not just under
    // the confirmed-broken 25,111), so this cap can never itself be the
    // thing that makes a legitimately-sized step fail.
    it(`${workflowName}: no single run: step exceeds 20,000 characters (GitHub Actions workflow-file size limit)`, () => {
      const steps = bashSteps(workflowPath);
      const oversized = steps
        .map((s) => ({ ...s, chars: s.run.length }))
        .filter((s) => s.chars > 20_000);

      expect(oversized.map((s) => `job "${s.jobId}" step "${s.stepName}": ${s.chars} chars`)).toEqual([]);
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
