import {
  currentEnv,
  isDevLike,
  assertDevEnvironment,
  assertNonProdTarget,
  assertNotDestructiveSql,
  assertNoIamChange,
  assertNoBillingChange,
  guardedDeploy,
  guardedMigration,
} from '../../src/guardrails/env-boundary';
import { EnvBoundaryViolation } from '../../src/guardrails/errors';

describe('env-boundary (Sec. 0.2) — fail-closed dev/staging only', () => {
  test('classifies dev-like envs, defaults unknown/unset to prod', () => {
    expect(currentEnv({ VCAOP_ENV: 'dev' })).toBe('dev');
    expect(currentEnv({ VCAOP_ENV: 'development' })).toBe('dev');
    expect(currentEnv({ VCAOP_ENV: 'staging' })).toBe('staging');
    expect(currentEnv({ NODE_ENV: 'test' })).toBe('test');
    expect(currentEnv({})).toBe('prod'); // unset => prod
    expect(currentEnv({ VCAOP_ENV: 'production' })).toBe('prod');
    expect(currentEnv({ VCAOP_ENV: 'anything-else' })).toBe('prod');
  });

  test('VCAOP_ENV takes precedence over NODE_ENV', () => {
    expect(currentEnv({ VCAOP_ENV: 'dev', NODE_ENV: 'production' })).toBe('dev');
  });

  test('assertDevEnvironment throws on prod', () => {
    expect(() => assertDevEnvironment({ VCAOP_ENV: 'dev' })).not.toThrow();
    expect(() => assertDevEnvironment({})).toThrow(EnvBoundaryViolation);
    expect(isDevLike({ VCAOP_ENV: 'staging' })).toBe(true);
  });

  test('assertNonProdTarget refuses prod-looking targets', () => {
    expect(() => assertNonProdTarget('vcaop-api-dev')).not.toThrow();
    expect(() => assertNonProdTarget('vitana-gateway-prod')).toThrow(EnvBoundaryViolation);
    expect(() => assertNonProdTarget('foo-production')).toThrow(EnvBoundaryViolation);
    expect(() => assertNonProdTarget('db.live.example')).toThrow(EnvBoundaryViolation);
    expect(() => assertNonProdTarget('')).toThrow(EnvBoundaryViolation); // empty => refuse
  });

  test('assertNotDestructiveSql blocks DROP/TRUNCATE/unbounded DELETE/destructive ALTER', () => {
    expect(() => assertNotDestructiveSql('SELECT 1')).not.toThrow();
    expect(() => assertNotDestructiveSql('DELETE FROM t WHERE id = 1')).not.toThrow();
    expect(() => assertNotDestructiveSql('DROP TABLE provider')).toThrow(EnvBoundaryViolation);
    expect(() => assertNotDestructiveSql('truncate provider_account')).toThrow(EnvBoundaryViolation);
    expect(() => assertNotDestructiveSql('DELETE FROM provider_account')).toThrow(EnvBoundaryViolation);
    expect(() => assertNotDestructiveSql('ALTER TABLE x DROP COLUMN y')).toThrow(EnvBoundaryViolation);
  });

  test('IAM and billing changes are always refused', () => {
    expect(() => assertNoIamChange('grant role')).toThrow(EnvBoundaryViolation);
    expect(() => assertNoBillingChange('enable paid API')).toThrow(EnvBoundaryViolation);
  });

  test('guardedDeploy allows *-dev and no-traffic tagged revisions only', () => {
    const env = { VCAOP_ENV: 'dev' };
    expect(() => guardedDeploy({ service: 'vcaop-api-dev' }, env)).not.toThrow();
    expect(() => guardedDeploy({ service: 'vitana-gateway', noTraffic: true }, env)).not.toThrow();
    expect(() => guardedDeploy({ service: 'vitana-gateway' }, env)).toThrow(EnvBoundaryViolation);
    expect(() => guardedDeploy({ service: 'vcaop-api-dev' }, {})).toThrow(EnvBoundaryViolation); // prod env
  });

  test('guardedMigration requires non-destructive up and a recorded down', () => {
    const env = { VCAOP_ENV: 'dev' };
    expect(() =>
      guardedMigration({ target: 'dev-supabase', up: 'CREATE TABLE x()', down: 'DROP TABLE x' }, env),
    ).not.toThrow();
    expect(() =>
      guardedMigration({ target: 'dev-supabase', up: 'CREATE TABLE x()', down: null }, env),
    ).toThrow(/rollback/i);
    expect(() =>
      guardedMigration({ target: 'prod-supabase', up: 'CREATE TABLE x()', down: 'DROP TABLE x' }, env),
    ).toThrow(EnvBoundaryViolation);
  });
});
