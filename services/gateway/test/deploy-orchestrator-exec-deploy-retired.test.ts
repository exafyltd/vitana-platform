/**
 * VTID-04059 — the Command Hub operator-console deploy path still dispatched
 * the GCP-era `EXEC-DEPLOY.yml` workflow, which this repo's own CLAUDE.md §9
 * lists as dead code (GCP is permanently decommissioned). Two distinct bugs
 * were shipped together in that one dispatch:
 *
 *  1. the workflow FILE was dead — so every Command Hub deploy request went
 *     to a workflow with no live purpose (or, once removed, simply 404'd);
 *  2. the INPUTS were for the wrong workflow — GitHub rejects a dispatch
 *     whose inputs aren't declared by the target workflow, so even pointing
 *     at a live file would have failed on `vtid`/`service`/`health_path`/
 *     `initiator`/`canary`/`commit_sha`/`image`.
 *
 * The fix routes each accepted service to its own AWS production workflow and
 * sends only the inputs those workflows actually declare: `reason` (required)
 * and `expected_commit` (only when a commit was supplied — omitted entirely
 * otherwise, never an empty string).
 */

import * as fs from 'fs';
import * as path from 'path';

// Governance evaluation must not reach Supabase: a null client is the
// service's documented fail-open path (allowed, level L4).
jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => null),
}));

// The whole point of this suite: observe exactly what gets dispatched.
jest.mock('../src/services/github-service', () => ({
  __esModule: true,
  default: {
    triggerWorkflow: jest.fn().mockResolvedValue(undefined),
    getWorkflowRuns: jest.fn().mockResolvedValue({
      workflow_runs: [
        {
          id: 98765,
          html_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/98765',
        },
      ],
    }),
  },
}));

jest.mock('../src/services/oasis-event-service', () => ({
  __esModule: true,
  default: {
    governanceDeployBlocked: jest.fn().mockResolvedValue(undefined),
    governanceDeployAllowed: jest.fn().mockResolvedValue(undefined),
    deployRequested: jest.fn().mockResolvedValue(undefined),
    deployAccepted: jest.fn().mockResolvedValue(undefined),
    deployFailed: jest.fn().mockResolvedValue(undefined),
  },
}));

import { executeDeploy, deployWorkflowForService, buildDeployWorkflowInputs } from '../src/services/deploy-orchestrator';
import githubService from '../src/services/github-service';

const mockTriggerWorkflow = githubService.triggerWorkflow as jest.Mock;
const mockGetWorkflowRuns = githubService.getWorkflowRuns as jest.Mock;

const ORCHESTRATOR_SOURCE = path.resolve(__dirname, '../src/services/deploy-orchestrator.ts');

const EXPECTED_WORKFLOW: Record<string, string> = {
  gateway: 'AWS-PROD-DEPLOY-GATEWAY.yml',
  'oasis-operator': 'AWS-PROD-DEPLOY-OASIS-OPERATOR.yml',
  'oasis-projector': 'AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml',
};

describe('VTID-04059: Command Hub deploy dispatches the AWS production workflow', () => {
  beforeEach(() => {
    mockTriggerWorkflow.mockClear();
    mockGetWorkflowRuns.mockClear();
  });

  it.each(Object.keys(EXPECTED_WORKFLOW))(
    'executeDeploy(%s) triggers %s and never EXEC-DEPLOY.yml',
    async (service) => {
      const result = await executeDeploy({
        vtid: 'VTID-04059',
        service: service as 'gateway' | 'oasis-operator' | 'oasis-projector',
        environment: 'production',
        source: 'operator.console.chat',
      });

      expect(result.ok).toBe(true);
      expect(mockTriggerWorkflow).toHaveBeenCalledTimes(1);
      const [repo, workflowFile] = mockTriggerWorkflow.mock.calls[0];
      expect(repo).toBe('exafyltd/vitana-platform');
      expect(workflowFile).toBe(EXPECTED_WORKFLOW[service]);
      expect(workflowFile).not.toBe('EXEC-DEPLOY.yml');

      // The run lookup must target the same workflow, otherwise the returned
      // workflow_url points at a different pipeline's run.
      expect(mockGetWorkflowRuns).toHaveBeenCalledWith(
        'exafyltd/vitana-platform',
        EXPECTED_WORKFLOW[service],
      );
      expect(result.workflow_url).toBe(
        'https://github.com/exafyltd/vitana-platform/actions/runs/98765',
      );
    },
  );

  it('sends only the declared inputs when no commitSha is supplied', async () => {
    await executeDeploy({
      vtid: 'VTID-04059',
      service: 'gateway',
      environment: 'production',
      source: 'operator.console.chat',
    });

    const inputs = mockTriggerWorkflow.mock.calls[0][3];
    expect(Object.keys(inputs).sort()).toEqual(['reason']);
    expect(inputs.reason).toBe('Command Hub deploy request VTID-04059');
    // The AWS-PROD-DEPLOY-*.yml workflows declare none of these; sending them
    // makes GitHub reject the whole dispatch.
    expect(inputs).not.toHaveProperty('expected_commit');
    expect(inputs).not.toHaveProperty('vtid');
    expect(inputs).not.toHaveProperty('service');
    expect(inputs).not.toHaveProperty('health_path');
    expect(inputs).not.toHaveProperty('initiator');
    expect(inputs).not.toHaveProperty('canary');
    expect(inputs).not.toHaveProperty('commit_sha');
    expect(inputs).not.toHaveProperty('image');
    // deploy_mode is deliberately left unset so the workflow default applies.
    expect(inputs).not.toHaveProperty('deploy_mode');
  });

  it('sends reason + expected_commit when commitSha is supplied', async () => {
    const sha = 'dc2d17d210678522e973a1bc94453f153eb39e5b';
    await executeDeploy({
      vtid: 'VTID-04059',
      service: 'oasis-operator',
      environment: 'production',
      source: 'api',
      commitSha: sha,
      // image/canary are accepted by the request type for legacy callers but
      // have no counterpart in the AWS workflow's inputs.
      image: '123456789.dkr.ecr.eu-central-1.amazonaws.com/vitana/gateway:abc123',
      canary: true,
    });

    const inputs = mockTriggerWorkflow.mock.calls[0][3];
    expect(Object.keys(inputs).sort()).toEqual(['expected_commit', 'reason']);
    expect(inputs.reason).toBe('Command Hub deploy request VTID-04059');
    expect(inputs.expected_commit).toBe(sha);
  });

  it('never sends an empty expected_commit for a falsy commitSha', async () => {
    for (const commitSha of ['', undefined]) {
      mockTriggerWorkflow.mockClear();
      await executeDeploy({
        vtid: 'VTID-04059',
        service: 'oasis-projector',
        environment: 'production',
        source: 'operator.console.chat',
        commitSha,
      });
      const inputs = mockTriggerWorkflow.mock.calls[0][3];
      expect(inputs).not.toHaveProperty('expected_commit');
    }
  });

  it('maps exactly the three accepted services and refuses anything else', () => {
    for (const [service, workflowFile] of Object.entries(EXPECTED_WORKFLOW)) {
      expect(deployWorkflowForService(service)).toBe(workflowFile);
    }
    expect(deployWorkflowForService('something-else')).toBeNull();
  });

  it('buildDeployWorkflowInputs omits expected_commit entirely when commitSha is falsy', () => {
    expect(Object.keys(buildDeployWorkflowInputs('VTID-04059')).sort()).toEqual(['reason']);
    expect(buildDeployWorkflowInputs('VTID-04059', '').expected_commit).toBeUndefined();
    expect(buildDeployWorkflowInputs('VTID-04059', 'abc123').expected_commit).toBe('abc123');
  });

  it('deploy-orchestrator.ts source no longer names EXEC-DEPLOY.yml', () => {
    const source = fs.readFileSync(ORCHESTRATOR_SOURCE, 'utf8');
    expect(source).not.toContain('EXEC-DEPLOY.yml');
  });

  it('deploy-orchestrator.ts source no longer references the dead gcpPromote path', () => {
    const source = fs.readFileSync(ORCHESTRATOR_SOURCE, 'utf8');
    expect(source).not.toContain('GCP_DUAL_PUBLISH_ENABLED');
    expect(source).not.toContain('gcpPromote');
  });
});
