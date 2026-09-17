/**
 * VTID-04000 — the staging task def must wire the Vertex Serbian bridge's
 * secret/env vars the same way the ERP-bridge secret is wired
 * (VTID-03840): OPTIONAL, resolved via `aws secretsmanager describe-secret`
 * at deploy time, and left completely untouched on the task definition
 * when the secret does not exist yet — never a hard `exit 1` that would
 * block every other staging deploy until an operator runs
 * scripts/aws/setup-vertex-serbian-bridge.sh --apply.
 *
 * Project id `project-da3eb05a-c86e-47cb-85f` (Vitanaland) and location
 * `global` are the platform owner's own values for the new, dedicated GCP
 * project (never `lovable-vitana-vers1`) — `global` because they enabled
 * the Live API as a global-endpoint service; Google's own docs confirm the
 * Vertex Live WebSocket endpoint (`wss://{location}-aiplatform.googleapis.com`)
 * accepts `global` as a literal location the same way it accepts any
 * region, so no code change was needed in `vertex-live-client.ts` for this.
 */

import * as fs from 'fs';
import * as path from 'path';

const STAGING_WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);
const PROD_WORKFLOW = path.resolve(
  __dirname,
  '../../../../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
);

const stagingYml = fs.readFileSync(STAGING_WORKFLOW, 'utf8');

describe('VTID-04000: staging wires the Vertex Serbian bridge, optionally', () => {
  it('resolves the GCP service account secret ARN via describe-secret, not a hardcoded ARN', () => {
    expect(stagingYml).toMatch(
      /aws secretsmanager describe-secret --secret-id vitana\/gateway\/staging\/gcp-service-account-json/,
    );
  });

  it('never fails the deploy when the secret is absent — falls back to an empty SEC_GCP_SA', () => {
    const block = stagingYml.slice(
      stagingYml.indexOf('SEC_GCP_SA=$(aws secretsmanager'),
      stagingYml.indexOf('TASK_ROLE_ARN=$('),
    );
    expect(block).toMatch(/if \[ -z "\$SEC_GCP_SA" \] \|\| \[ "\$SEC_GCP_SA" = "None" \]/);
    expect(block).toContain('SEC_GCP_SA=""');
    expect(block).not.toMatch(/exit 1/);
  });

  it('passes the resolved ARN into the jq filter as $SEC_GCP_SA', () => {
    expect(stagingYml).toMatch(/--arg SEC_GCP_SA "\$SEC_GCP_SA"/);
  });

  it('only wires the env vars and secret inside an if $SEC_GCP_SA != "" guard, mirroring the ERP-bridge pattern', () => {
    const guardBlock = stagingYml.slice(
      stagingYml.indexOf('if $SEC_GCP_SA != "" then'),
      stagingYml.indexOf('del(.taskDefinitionArn'),
    );
    expect(guardBlock).toContain('GOOGLE_CLOUD_PROJECT');
    expect(guardBlock).toContain('VERTEX_AI_LOCATION');
    expect(guardBlock).toContain('VERTEX_SERBIAN_BRIDGE_ENABLED');
    expect(guardBlock).toContain('GCP_SERVICE_ACCOUNT_JSON');
  });

  it('pins the exact project id and global location the platform owner gave', () => {
    expect(stagingYml).toMatch(
      /\{name:"GOOGLE_CLOUD_PROJECT", value:"project-da3eb05a-c86e-47cb-85f"\}/,
    );
    expect(stagingYml).toMatch(/\{name:"VERTEX_AI_LOCATION", value:"global"\}/);
    expect(stagingYml).toMatch(
      /\{name:"VERTEX_SERBIAN_BRIDGE_ENABLED", value:"true"\}/,
    );
  });

  it('upserts the GCP_SERVICE_ACCOUNT_JSON secret pointed at $SEC_GCP_SA', () => {
    expect(stagingYml).toMatch(
      /\{name:"GCP_SERVICE_ACCOUNT_JSON",\s*valueFrom:\$SEC_GCP_SA\}/,
    );
  });

  it('strips inherited GOOGLE_CLOUD_PROJECT/VERTEX_AI_LOCATION/VERTEX_SERBIAN_BRIDGE_ENABLED first, so a stale value cannot survive', () => {
    const guardBlock = stagingYml.slice(
      stagingYml.indexOf('if $SEC_GCP_SA != "" then'),
      stagingYml.indexOf('del(.taskDefinitionArn'),
    );
    const strip = guardBlock.slice(0, guardBlock.indexOf('| not) ]'));
    expect(strip).toContain('GOOGLE_CLOUD_PROJECT');
    expect(strip).toContain('VERTEX_AI_LOCATION');
    expect(strip).toContain('VERTEX_SERBIAN_BRIDGE_ENABLED');
  });

  it('is NOT wired on prod — promoting this is a separate, later, human decision', () => {
    const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');
    expect(prodYml).not.toContain('VERTEX_SERBIAN_BRIDGE_ENABLED');
    expect(prodYml).not.toContain('gcp-service-account-json');
  });
});
