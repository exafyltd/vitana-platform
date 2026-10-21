/**
 * VTID-04608 — Assert that scripts/aws/setup-operator-agent-task-role-grants.sh
 * contains all required IAM statements for vitana-ecs-task-role.
 *
 * This test reads the raw script text and verifies:
 *   1. ecs:DescribeServices scoped to cluster services (Sid OperatorEcsServicesReadVTID03836)
 *   2. logs:FilterLogEvents (Sid OperatorCloudWatchLogsReadVTID04020)
 *   3. ecs:ListTasks + ecs:DescribeTasks (Sid OperatorEcsTasksReadVTID04035)
 *   4. ecs:StopTask (Sid DevAutopilotCancelStopTaskVTID04032)
 *
 * It does NOT run the script — it only reads its source text.
 */

import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../scripts/aws/setup-operator-agent-task-role-grants.sh',
);

let scriptText: string;

beforeAll(() => {
  scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8');
});

describe('setup-operator-agent-task-role-grants.sh — IAM policy statements', () => {
  it('contains the OperatorEcsServicesReadVTID03836 Sid', () => {
    expect(scriptText).toContain('OperatorEcsServicesReadVTID03836');
  });

  it('grants ecs:DescribeServices', () => {
    expect(scriptText).toContain('ecs:DescribeServices');
  });

  it('scopes ecs:DescribeServices to cluster services ARN (service/${CLUSTER_NAME}/*)', () => {
    // The resource must reference the cluster's services path, not a wildcard "*"
    expect(scriptText).toMatch(
      /ecs:DescribeServices[\s\S]*?service\/\$\{CLUSTER_NAME\}\/\*/,
    );
  });

  it('contains the OperatorCloudWatchLogsReadVTID04020 Sid (logs:FilterLogEvents)', () => {
    expect(scriptText).toContain('OperatorCloudWatchLogsReadVTID04020');
    expect(scriptText).toContain('logs:FilterLogEvents');
  });

  it('contains the OperatorEcsTasksReadVTID04035 Sid (ecs:ListTasks + ecs:DescribeTasks)', () => {
    expect(scriptText).toContain('OperatorEcsTasksReadVTID04035');
    expect(scriptText).toContain('ecs:ListTasks');
    expect(scriptText).toContain('ecs:DescribeTasks');
  });

  it('contains the DevAutopilotCancelStopTaskVTID04032 Sid (ecs:StopTask)', () => {
    expect(scriptText).toContain('DevAutopilotCancelStopTaskVTID04032');
    expect(scriptText).toContain('ecs:StopTask');
  });

  it('uses ${REGION}, ${ACCOUNT_ID}, ${CLUSTER_NAME} variable style throughout', () => {
    expect(scriptText).toContain('${REGION}');
    expect(scriptText).toContain('${ACCOUNT_ID}');
    expect(scriptText).toContain('${CLUSTER_NAME}');
  });

  it('header comment lists dev_aws_ecs_status (VTID-03836)', () => {
    expect(scriptText).toContain('dev_aws_ecs_status');
    expect(scriptText).toContain('VTID-03836');
  });
});
