/**
 * VTID-04276 — wire ROUTINE_INGEST_TOKEN (the shared secret
 * routes/routines.ts and routes/routine-audits.ts require via the
 * X-Routine-Token header, requireRoutineToken()) into both gateway deploy
 * workflows.
 *
 * Root cause this closes: `process.env.ROUTINE_INGEST_TOKEN` is unset on
 * both live task definitions (confirmed live via a real 503
 * {"error":"ROUTINE_INGEST_TOKEN env var not configured"} from
 * gateway.vitanaland.com and preview-aws-gateway.vitanaland.com), which is
 * why essentially every Claude Code Remote Routine calling these endpoints
 * fails — 13 of them silently, because their own scripts `exit 0` on an
 * empty POST response.
 *
 * Staging: the same optional, describe-secret-gated ERP-bridge-style
 * pattern as OPERATOR_SQL_READONLY_DATABASE_URL / OPERATOR_MACHINE_AUTH_TOKEN
 * — absent secret, deploy unaffected; present secret, wired as a real
 * AWS Secrets Manager reference.
 *
 * Prod: the prod deploy role has no secretsmanager:Describe* (VTID-03880),
 * so the same describe-secret pattern cannot work there. Uses the
 * MARKETPLACE_SYNC_SECRET pattern instead — a plain env var sourced from
 * the GitHub Actions repository secret ROUTINE_INGEST_TOKEN, empty until
 * the owner adds it (which resolves to the identical "not configured" 503
 * the route already returns today — never a failed deploy).
 */

import * as fs from 'fs';
import * as path from 'path';

const STAGE_WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
);
const PROD_WORKFLOW = path.resolve(
  __dirname,
  '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
);

const stageYml = fs.readFileSync(STAGE_WORKFLOW, 'utf8');
const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');

describe('VTID-04276: staging wires ROUTINE_INGEST_TOKEN optionally, like the SQL-readonly secret', () => {
  it('describes the secret before using it, never assumes it exists', () => {
    expect(stageYml).toMatch(
      /aws secretsmanager describe-secret --secret-id vitana\/gateway\/staging\/routine-ingest-token/,
    );
  });

  it('resolves to an empty string, not a failure, when the secret is absent', () => {
    const block = stageYml.slice(
      stageYml.indexOf('SEC_ROUTINE_TOKEN=$('),
      stageYml.indexOf('SEC_ROUTINE_TOKEN=$(') + 600,
    );
    expect(block).toMatch(/SEC_ROUTINE_TOKEN=""/);
    expect(block).not.toMatch(/exit 1/);
  });

  it('strips ROUTINE_INGEST_TOKEN first, so a stale value cannot survive', () => {
    const secretsStripStart = stageYml.indexOf('.containerDefinitions[0].secrets |=');
    const secretsStripBlock = stageYml.slice(
      secretsStripStart,
      stageYml.indexOf('| not) ]', secretsStripStart),
    );
    expect(secretsStripBlock).toContain('"ROUTINE_INGEST_TOKEN"');
  });

  it('only wires ROUTINE_INGEST_TOKEN when the secret was actually resolved', () => {
    expect(stageYml).toMatch(
      /if \$SEC_ROUTINE_TOKEN != "" then[\s\S]{0,300}ROUTINE_INGEST_TOKEN", valueFrom:\$SEC_ROUTINE_TOKEN/,
    );
  });

  it('is never unconditionally wired — absent secret must leave it untouched', () => {
    const allMatches = stageYml.match(/\{name:"ROUTINE_INGEST_TOKEN", valueFrom:\$SEC_ROUTINE_TOKEN\}/g) || [];
    expect(allMatches.length).toBe(1);
    // and that one occurrence sits inside the "if $SEC_ROUTINE_TOKEN != """ guard,
    // not a bare unconditional entry in the base secrets list.
    const baseSecretsBlock = stageYml.slice(
      stageYml.indexOf('.containerDefinitions[0].secrets |='),
      stageYml.indexOf('| ( if $SEC_INTERNAL_TOKEN'),
    );
    expect(baseSecretsBlock).not.toContain('valueFrom:$SEC_ROUTINE_TOKEN');
  });
});

describe('VTID-04276: prod wires ROUTINE_INGEST_TOKEN as a plain env var sourced from a GitHub Actions secret (no describe-secret access on the prod deploy role)', () => {
  it('sources the value from the ROUTINE_INGEST_TOKEN repository secret', () => {
    expect(prodYml).toMatch(/ROUTINE_INGEST_TOKEN_VALUE:\s*\$\{\{\s*secrets\.ROUTINE_INGEST_TOKEN\s*\}\}/);
  });

  it('pins ROUTINE_INGEST_TOKEN as a plain env value (mirroring MARKETPLACE_SYNC_SECRET), never a Secrets Manager reference', () => {
    expect(prodYml).toMatch(
      /jq --arg S "\$ROUTINE_INGEST_TOKEN_VALUE" '\s*\.containerDefinitions\[0\]\.environment \|=\s*\(\s*\[\s*\.\[\]\s*\|\s*select\(\.name != "ROUTINE_INGEST_TOKEN"\)\s*\]\s*\+\s*\[\s*\{name:"ROUTINE_INGEST_TOKEN", value:\$S\}\s*\]\s*\)/,
    );
    expect(prodYml).not.toMatch(/valueFrom:\$SEC_ROUTINE_TOKEN/);
  });

  it('never runs a secretsmanager describe-secret call for this token — the prod deploy role cannot', () => {
    expect(prodYml).not.toMatch(/describe-secret --secret-id vitana\/gateway\/prod\/routine-ingest-token/);
  });
});
