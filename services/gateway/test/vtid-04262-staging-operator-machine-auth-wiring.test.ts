/**
 * VTID-04262 — wire the VTID-04133 Operator Console machine-to-machine auth
 * secret into the staging deploy workflow, ERP-bridge-style (optional,
 * describe-secret-gated), now that an operator has actually provisioned
 * `vitana/gateway/staging/operator-machine-auth-token`.
 *
 * VTID-04133 built the mechanism (operator-machine-auth.ts) and the
 * provisioning script, but deliberately left the task-def wiring undone in
 * the same PR — that workflow's secret-resolution loop hard-fails the whole
 * staging deploy if a REQUIRED secret is missing, and the building session
 * could not confirm the secret existed yet. This VTID wires it the same
 * optional way OPERATOR_SQL_READONLY_DATABASE_URL already is: a
 * `describe-secret` probe that resolves to "" when absent, so the deploy
 * never fails just because this one credential isn't provisioned — it only
 * activates OPERATOR_MACHINE_AUTH_ENABLED when the secret is actually there.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);
const PROD_WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
);

const yml = fs.readFileSync(WORKFLOW, 'utf8');

describe('VTID-04262: staging wires OPERATOR_MACHINE_AUTH_TOKEN optionally, like the SQL-readonly secret', () => {
  it('describes the secret before using it, never assumes it exists', () => {
    expect(yml).toMatch(
      /aws secretsmanager describe-secret --secret-id vitana\/gateway\/staging\/operator-machine-auth-token/,
    );
  });

  it('resolves to an empty string, not a failure, when the secret is absent', () => {
    const block = yml.slice(
      yml.indexOf('SEC_MACHINE_AUTH=$('),
      yml.indexOf('SEC_MACHINE_AUTH=$(') + 600,
    );
    expect(block).toMatch(/SEC_MACHINE_AUTH=""/);
    expect(block).not.toMatch(/exit 1/);
  });

  it('strips OPERATOR_MACHINE_AUTH_ENABLED/TOKEN first, so a stale value cannot survive', () => {
    const envStripBlock = yml.slice(
      yml.indexOf('.containerDefinitions[0].environment |='),
      yml.indexOf('.containerDefinitions[0].secrets |='),
    );
    expect(envStripBlock).toContain('"OPERATOR_MACHINE_AUTH_ENABLED"');

    const secretsStripStart = yml.indexOf('.containerDefinitions[0].secrets |=');
    const secretsStripBlock = yml.slice(
      secretsStripStart,
      yml.indexOf('| not) ]', secretsStripStart),
    );
    expect(secretsStripBlock).toContain('"OPERATOR_MACHINE_AUTH_TOKEN"');
  });

  it('only activates OPERATOR_MACHINE_AUTH_ENABLED when the secret was actually resolved', () => {
    expect(yml).toMatch(
      /if \$SEC_MACHINE_AUTH != "" then[\s\S]{0,300}OPERATOR_MACHINE_AUTH_ENABLED", value:"true"/,
    );
    expect(yml).toMatch(
      /OPERATOR_MACHINE_AUTH_TOKEN", valueFrom:\$SEC_MACHINE_AUTH/,
    );
  });

  it('is never unconditionally forced true — absent secret must leave it untouched', () => {
    // Unlike an always-on flag (e.g. ORB_CASCADED_VOICE_ENABLED), this one
    // must never appear as a bare, unconditional {name:...,value:"true"} —
    // only inside the `if $SEC_MACHINE_AUTH != ""` guard asserted above.
    const unconditional = /\{name:"OPERATOR_MACHINE_AUTH_ENABLED", value:"true"\}(?![\s\S]{0,5}\))/;
    const allMatches = yml.match(/\{name:"OPERATOR_MACHINE_AUTH_ENABLED", value:"true"\}/g) || [];
    expect(allMatches.length).toBe(1);
  });

  it('is NOT declared on the prod deploy workflow — staging-only credential, no product reason for prod', () => {
    const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');
    expect(prodYml).not.toMatch(/OPERATOR_MACHINE_AUTH_ENABLED/);
    expect(prodYml).not.toMatch(/OPERATOR_MACHINE_AUTH_TOKEN/);
  });
});
