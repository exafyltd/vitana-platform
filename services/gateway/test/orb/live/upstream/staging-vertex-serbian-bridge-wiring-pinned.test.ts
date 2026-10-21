/**
 * VTID-04000 — the staging task def wires the Vertex Serbian bridge's four
 * env vars UNCONDITIONALLY, as plain values, alongside AURORA_CA_BUNDLE_PATH
 * etc. — not as an AWS-Secrets-Manager-backed OPTIONAL secret the way the
 * ERP-bridge token is (VTID-03840).
 *
 * This superseded an earlier design (AWS Secrets Manager +
 * `aws secretsmanager describe-secret`) after the platform owner hit GCP's
 * org-wide `iam.disableServiceAccountKeyCreation` policy live, even as org
 * Owner — no downloadable service-account key could ever exist to put in
 * Secrets Manager. The replacement is Workload Identity Federation (WIF):
 * a Workload Identity Pool (`vitana-aws-pool`) + AWS provider
 * (`vitana-aws-provider`) trusting AWS account `472838866351` directly, with
 * `roles/iam.workloadIdentityUser` granted to the AWS principal that runs
 * this workflow. The credential config this produces
 * (`gcloud iam workload-identity-pools create-cred-config`'s output, type
 * `external_account`) contains no private key — only federation metadata
 * (pool/provider names, STS endpoints) — which is why Google's own docs
 * call it safe to store in plain text, and why it is wired as a plain `value`
 * here rather than routed through Secrets Manager. `gcp-adc-bootstrap.ts`
 * and `google-auth-library`'s `GoogleAuth()` both already handle an
 * `external_account` credential JSON generically — no code change needed
 * for either to consume this.
 *
 * Project id `project-da3eb05a-c86e-47cb-85f` (Vitanaland, GCP project
 * number `20926255361`) and location `global` are the platform owner's own
 * values for the new, dedicated GCP project (never `lovable-vitana-vers1`)
 * — `global` because they enabled the Live API as a global-endpoint
 * service; Google's own docs confirm the Vertex Live WebSocket endpoint
 * (`wss://{location}-aiplatform.googleapis.com`) accepts `global` as a
 * literal location the same way it accepts any region, so no code change
 * was needed in `vertex-live-client.ts` for this.
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

describe('VTID-04000: staging wires the Vertex Serbian bridge (WIF), unconditionally', () => {
  it('never resolves a GCP service-account secret via describe-secret — there is no key to store', () => {
    expect(stagingYml).not.toMatch(/gcp-service-account-json/);
    expect(stagingYml).not.toMatch(/SEC_GCP_SA/);
  });

  it('assembles the WIF external_account credential config as a static, non-secret variable', () => {
    expect(stagingYml).toMatch(/GCP_CRED_CONFIG='\{.*"type":"external_account".*\}'/);
  });

  it('pins the real pool/provider/project the platform owner provisioned via Cloud Shell', () => {
    expect(stagingYml).toContain(
      '//iam.googleapis.com/projects/20926255361/locations/global/workloadIdentityPools/vitana-aws-pool/providers/vitana-aws-provider',
    );
    expect(stagingYml).toContain(
      'vitanaland@project-da3eb05a-c86e-47cb-85f.iam.gserviceaccount.com',
    );
    expect(stagingYml).toContain('sts.googleapis.com/v1/token');
  });

  it('passes the credential config into the jq filter as $GCP_CRED_CONFIG', () => {
    expect(stagingYml).toMatch(/--arg GCP_CRED_CONFIG "\$GCP_CRED_CONFIG"/);
  });

  it('wires all four vars UNCONDITIONALLY, in the same strip/add block as AURORA_CA_BUNDLE_PATH — no if-guard', () => {
    const jqBlock = stagingYml.slice(
      stagingYml.indexOf('.containerDefinitions[0].environment |='),
      stagingYml.indexOf('.containerDefinitions[0].secrets |='),
    );
    // The old design's conditional guard must be gone entirely for this var.
    expect(jqBlock).not.toMatch(/if \$SEC_GCP_SA/);
    expect(jqBlock).toContain('"GOOGLE_CLOUD_PROJECT","VERTEX_AI_LOCATION"');
    expect(jqBlock).toContain('"VERTEX_SERBIAN_BRIDGE_ENABLED"');
    // Presence in the strip list only — NOT positionally last. VTID-04118
    // appended OPERATOR_CODEINTEL_ENABLED/CODEINTEL_PLATFORM_REPO_DIR/
    // CODEINTEL_V1_REPO_DIR after this name in the same array; this
    // assertion's job is confirming GCP_SERVICE_ACCOUNT_JSON gets stripped
    // before being re-added (so a stale value can't survive a deploy), not
    // pinning where in the list that happens.
    expect(jqBlock).toContain('"GCP_SERVICE_ACCOUNT_JSON"');
    expect(jqBlock).toContain('{name:"AURORA_CA_BUNDLE_PATH"');
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

  it('wires GCP_SERVICE_ACCOUNT_JSON as a plain environment value pointed at $GCP_CRED_CONFIG, not a secret', () => {
    expect(stagingYml).toMatch(
      /\{name:"GCP_SERVICE_ACCOUNT_JSON", value:\$GCP_CRED_CONFIG\}/,
    );
  });

  it('strips any GCP_SERVICE_ACCOUNT_JSON left in .secrets, for migration hygiene, without re-adding it there', () => {
    const secretsBlock = stagingYml.slice(
      stagingYml.indexOf('.containerDefinitions[0].secrets |='),
      stagingYml.indexOf('| ( if $SEC_ERP_BRIDGE'),
    );
    const strip = secretsBlock.slice(0, secretsBlock.indexOf('| not) ]'));
    expect(strip).toContain('"GCP_SERVICE_ACCOUNT_JSON"');
    const add = secretsBlock.slice(secretsBlock.indexOf('+ [ {'));
    expect(add).not.toContain('GCP_SERVICE_ACCOUNT_JSON');
  });

  // VTID-04048: this branch is the deliberate, explicit production
  // activation of the bridge — the platform owner confirmed in conversation
  // that they want Serbian voice live in prod, not just backported inert.
  // Every other prod deploy prior to this asserted the opposite (see git
  // history for this test); that assertion is superseded here, not
  // silently dropped.
  it('is wired on prod, unconditionally, with the SAME GCP_CRED_CONFIG value staging uses (VTID-04048)', () => {
    const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');
    expect(prodYml).toContain('VERTEX_SERBIAN_BRIDGE_ENABLED');
    expect(prodYml).toContain('GCP_SERVICE_ACCOUNT_JSON');
    expect(prodYml).toContain('workloadIdentityPools');

    // The exact same external_account credential config as staging — WIF
    // trusts the AWS principal (the shared vitana-ecs-task-role ARN), not a
    // specific ECS service, so prod needs no separate GCP-side binding.
    const stagingCred = stagingYml.match(/GCP_CRED_CONFIG='(\{.*?\})'/)?.[1];
    const prodCred = prodYml.match(/GCP_CRED_CONFIG='(\{.*?\})'/)?.[1];
    expect(stagingCred).toBeTruthy();
    expect(prodCred).toBe(stagingCred);

    // Unconditional — no describe-secret, no if-guard, mirroring staging's
    // own strip/re-add pattern (same style as AURORA_CA_BUNDLE_PATH etc.).
    const prodBlock = prodYml.slice(
      prodYml.indexOf('VERTEX_SERBIAN_BRIDGE_ENABLED'),
      prodYml.indexOf('VERTEX_SERBIAN_BRIDGE_ENABLED') + 1200,
    );
    expect(prodBlock).not.toContain('describe-secret');
    expect(prodBlock).not.toContain('if [');

    // sr only — never widened to any other language, same as staging.
    expect(prodYml).toContain('VERTEX_SERBIAN_BRIDGE_ENABLED", value:"true"');
    expect(prodYml).not.toMatch(/VERTEX_SERBIAN_BRIDGE_ENABLED.*value:"false"/);
  });

  it('prod points at the same new GCP project — never the decommissioned one', () => {
    const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');
    expect(prodYml).toContain('project-da3eb05a-c86e-47cb-85f');
    expect(prodYml).not.toContain('lovable-vitana-vers1');
  });
});
