/**
 * VTID-03813 — the staging task def must PIN AURORA_RLS_DATABASE_URL as an
 * upserted `secrets` entry, not leave it to inherit whatever a prior task
 * definition happened to carry.
 *
 * GET /api/v1/admin/aurora-rls-health (VTID-03591, routes/admin-health.ts)
 * has been live since 2026-08-29 and fully tested
 * (test/routes/admin-aurora-rls-health.test.ts), but getAuroraPool()
 * returns null whenever AURORA_RLS_DATABASE_URL is unset — which it was, on
 * both AWS gateway task defs, per AURORA-B4-SIZING-REFRESH.md's 2026-09-10
 * addendum. So the route has always short-circuited to
 * `configured:false`, and the pg.Pool/raw-Postgres-wire transport it (and
 * every future real Aurora call site using the RLS-context shim) would use
 * has never been exercised end-to-end from anywhere — only the RDS Data
 * API, a different transport, had been proven live.
 *
 * This is deliberately a DIFFERENT variable from AURORA_DATABASE_URL
 * (VTID-03517/03773, services/db-i18n/aurora-client.ts), which this repo's
 * `main` independently wired to staging in the same window using the
 * `vitana_admin` (superuser-class) secret. Reusing that connection for the
 * RLS-health route would make it permanently report "unsafe" regardless of
 * whether RLS actually composes correctly — this route needs the
 * unprivileged `authenticator` role instead. Both variables now coexist on
 * staging, resolved via their own named secret in the same describe-secret
 * loop, pointed at the SAME single Aurora cluster but different login
 * roles for their different purposes.
 *
 * This pins the fix the same way VTID-03741 pinned
 * FEATURE_LATENCY_TELEMETRY_ENV: present in both the strip list and the
 * re-add list, resolved via `aws secretsmanager describe-secret` at deploy
 * time (not string-built) exactly like the other secrets in this block —
 * so a future edit that drops one half cannot silently regress the
 * diagnostic back to a permanent no-op.
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

describe('VTID-03813: staging pins AURORA_RLS_DATABASE_URL', () => {
  it('resolves the authenticator-role secret ARN via describe-secret, not a hardcoded ARN', () => {
    expect(stagingYml).toMatch(
      /"SEC_AURORA_RLS:vitana\/aurora\/prod\/postgrest-authenticator-uri"/,
    );
  });

  it('passes the resolved ARN into the jq filter as $SEC_AURORA_RLS', () => {
    expect(stagingYml).toMatch(/--arg SEC_AURORA_RLS "\$SEC_AURORA_RLS"/);
  });

  it('strips the inherited secret first, so a stale one cannot survive', () => {
    // Without this, the re-add would append a DUPLICATE key alongside the
    // inherited one, and which wins is not something to leave to chance —
    // same discipline the environment-block strip already applies.
    const secretsBlock = stagingYml.slice(
      stagingYml.indexOf('.containerDefinitions[0].secrets |='),
      stagingYml.indexOf('del(.taskDefinitionArn'),
    );
    const strip = secretsBlock.slice(0, secretsBlock.indexOf('| not) ]'));
    expect(strip).toContain('"AURORA_RLS_DATABASE_URL"');
  });

  it('upserts the AURORA_RLS_DATABASE_URL secret pointed at $SEC_AURORA_RLS', () => {
    expect(stagingYml).toMatch(
      /\{name:"AURORA_RLS_DATABASE_URL",\s*valueFrom:\$SEC_AURORA_RLS\}/,
    );
  });

  it('does not collide with the separately-wired AURORA_DATABASE_URL (VTID-03773, vitana_admin secret)', () => {
    expect(stagingYml).toMatch(
      /"SEC_AURORA:vitana\/aurora\/prod\/database-url"/,
    );
    expect(stagingYml).toMatch(
      /\{name:"AURORA_DATABASE_URL",\s*valueFrom:\$SEC_AURORA\}/,
    );
  });

  it('is NOT wired on prod — promoting this is a separate, later, human decision', () => {
    const prodYml = fs.readFileSync(PROD_WORKFLOW, 'utf8');
    expect(prodYml).not.toContain('AURORA_RLS_DATABASE_URL');
    expect(prodYml).not.toContain('postgrest-authenticator-uri');
  });
});
