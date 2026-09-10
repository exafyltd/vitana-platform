/**
 * VTID-03773 — unit coverage for `resolveSsl`/`resolveAuroraConfig`.
 *
 * This module had ZERO direct test coverage before this file — only
 * exercised indirectly through mocks in admin-aurora-memory-health.test.ts
 * and, for real connectivity, aurora-integration.test.ts (skipped without a
 * local Postgres). Neither would have caught the real bug this file pins:
 * a live staging call against a correctly-configured `AURORA_CA_BUNDLE_PATH`
 * still failed TLS verification ("unable to get local issuer certificate")
 * against the RDS Proxy endpoint, because a custom `ca` value REPLACES
 * Node's built-in trusted roots rather than extending them, and the RDS
 * Proxy's certificate can chain to a different, public root than the
 * RDS-instance-specific bundle covers. See the comment above
 * `splitPemCertificates` in aurora-client.ts for the full explanation.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { AuroraConfigError, resolveAuroraConfig } from '../../src/services/db-i18n/aurora-client';

const FAKE_CERT_1 = '-----BEGIN CERTIFICATE-----\nMIIFAKEcertOne==\n-----END CERTIFICATE-----';
const FAKE_CERT_2 = '-----BEGIN CERTIFICATE-----\nMIIFAKEcertTwo==\n-----END CERTIFICATE-----';

describe('resolveAuroraConfig / resolveSsl', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aurora-ca-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when AURORA_DATABASE_URL is unset', () => {
    expect(() => resolveAuroraConfig({} as NodeJS.ProcessEnv)).toThrow(AuroraConfigError);
  });

  it('throws when AURORA_DATABASE_URL is not a postgres(ql):// URL', () => {
    expect(() =>
      resolveAuroraConfig({ AURORA_DATABASE_URL: 'mysql://x' } as NodeJS.ProcessEnv),
    ).toThrow(/postgres:\/\/ or postgresql:\/\//);
  });

  it('verifies against the system default trust store when nothing is set', () => {
    const cfg = resolveAuroraConfig({
      AURORA_DATABASE_URL: 'postgres://user:pw@example.com:5432/db',
    } as NodeJS.ProcessEnv);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('redacts the password in describe()', () => {
    const cfg = resolveAuroraConfig({
      AURORA_DATABASE_URL: 'postgres://user:secret-pw@example.com:5432/db',
    } as NodeJS.ProcessEnv);
    expect(cfg.describe).not.toContain('secret-pw');
    expect(cfg.describe).toContain('***');
  });

  it('AURORA_SSL_INSECURE=true skips verification when no CA bundle is set', () => {
    const cfg = resolveAuroraConfig({
      AURORA_DATABASE_URL: 'postgres://user:pw@example.com:5432/db',
      AURORA_SSL_INSECURE: 'true',
    } as NodeJS.ProcessEnv);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('honours sslmode=disable on a loopback host', () => {
    const cfg = resolveAuroraConfig({
      AURORA_DATABASE_URL: 'postgres://user:pw@127.0.0.1:5432/db?sslmode=disable',
    } as NodeJS.ProcessEnv);
    expect(cfg.ssl).toBe(false);
  });

  it('refuses sslmode=disable against a non-loopback host, even with a CA bundle set', () => {
    expect(() =>
      resolveAuroraConfig({
        AURORA_DATABASE_URL: 'postgres://user:pw@example.com:5432/db?sslmode=disable',
      } as NodeJS.ProcessEnv),
    ).toThrow(/only permitted for loopback hosts/);
  });

  it('throws AuroraConfigError when AURORA_CA_BUNDLE_PATH points at a missing file', () => {
    expect(() =>
      resolveAuroraConfig({
        AURORA_DATABASE_URL: 'postgres://user:pw@example.com:5432/db',
        AURORA_CA_BUNDLE_PATH: path.join(dir, 'does-not-exist.pem'),
      } as NodeJS.ProcessEnv),
    ).toThrow(/no such file exists/);
  });

  it('throws AuroraConfigError when the bundle file contains no PEM certificates', () => {
    const bundlePath = path.join(dir, 'empty.pem');
    writeFileSync(bundlePath, 'not a certificate\njust some text\n');
    expect(() =>
      resolveAuroraConfig({
        AURORA_DATABASE_URL: 'postgres://user:pw@example.com:5432/db',
        AURORA_CA_BUNDLE_PATH: bundlePath,
      } as NodeJS.ProcessEnv),
    ).toThrow(/contains no PEM certificates/);
  });

  // This is the real bug fix: a custom `ca` option was previously set to
  // ONLY the bundle's own certs, which REPLACES rather than extends
  // Node's trusted roots — cutting off a certificate chain (like RDS
  // Proxy's) that relies on one of those built-in public roots.
  it('unions the CA bundle certs with tls.rootCertificates, not replacing them', () => {
    const bundlePath = path.join(dir, 'rds-bundle.pem');
    writeFileSync(bundlePath, `${FAKE_CERT_1}\n${FAKE_CERT_2}\n`);
    const cfg = resolveAuroraConfig({
      AURORA_DATABASE_URL: 'postgres://user:pw@vitana-rds-proxy-prod.rds.amazonaws.com:5432/db',
      AURORA_CA_BUNDLE_PATH: bundlePath,
    } as NodeJS.ProcessEnv);

    expect(cfg.ssl).toMatchObject({ rejectUnauthorized: true });
    const ca = (cfg.ssl as { ca: string[] }).ca;
    expect(Array.isArray(ca)).toBe(true);
    // Both bundle certs are present, individually split out...
    expect(ca).toContain(FAKE_CERT_1);
    expect(ca).toContain(FAKE_CERT_2);
    // ...and every one of Node's built-in trusted roots is still present —
    // this is the assertion that would have caught the original bug.
    expect(ca.length).toBe(2 + rootCertificates.length);
    for (const root of rootCertificates) {
      expect(ca).toContain(root);
    }
  });

  it('does not throw AuroraConfigError:not-configured when a CA bundle IS set (configured:true path)', () => {
    // A live health-route regression: an AuroraConfigError thrown from
    // resolveSsl (not just resolveAuroraConfig's own URL checks) must still
    // be catchable as a config problem, not silently swallowed.
    const bundlePath = path.join(dir, 'rds-bundle.pem');
    writeFileSync(bundlePath, `${FAKE_CERT_1}\n`);
    expect(() =>
      resolveAuroraConfig({
        AURORA_DATABASE_URL: 'postgres://user:pw@example.com:5432/db',
        AURORA_CA_BUNDLE_PATH: bundlePath,
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
