/**
 * VTID-04893 — Google access tokens on ECS through the task role.
 *
 * The Workload Identity config's own credential source is the EC2 metadata
 * endpoint, which ECS does not serve, so every Google token request failed
 * (CloudWatch: the bridge's token prewarm, staging 2026-10-02 and production
 * 2026-09-28). These tests pin that the programmatic supplier replaces that
 * source, that the signed AWS request is built from the supplier's
 * credentials with no metadata call, and that the live path stays on the old
 * route until the flag is set.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildGoogleAwsClient,
  isGoogleAwsSupplierEnabled,
  makeAwsSupplier,
  readExternalAccountConfig,
} from '../src/lib/google-access-token';

const CONFIG = {
  universe_domain: 'googleapis.com',
  type: 'external_account',
  audience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/aws',
  subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
  token_url: 'https://sts.googleapis.com/v1/token',
  credential_source: {
    environment_id: 'aws1',
    region_url: 'http://metadata.invalid/latest/meta-data/placement/availability-zone',
    url: 'http://metadata.invalid/latest/meta-data/iam/security-credentials',
    regional_cred_verification_url: 'https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15',
  },
  service_account_impersonation_url:
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@example.iam.gserviceaccount.com:generateAccessToken',
};

describe('GOOGLE_AUTH_AWS_SUPPLIER_ENABLED', () => {
  it('is on only for the exact string true', () => {
    expect(isGoogleAwsSupplierEnabled({ GOOGLE_AUTH_AWS_SUPPLIER_ENABLED: 'true' })).toBe(true);
    expect(isGoogleAwsSupplierEnabled({ GOOGLE_AUTH_AWS_SUPPLIER_ENABLED: ' true ' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', '1', 'yes', 'false']) {
      expect(isGoogleAwsSupplierEnabled({ GOOGLE_AUTH_AWS_SUPPLIER_ENABLED: v })).toBe(false);
    }
  });
});

describe('readExternalAccountConfig', () => {
  it('reads raw and base64 JSON', () => {
    const raw = JSON.stringify(CONFIG);
    expect(readExternalAccountConfig({ GCP_SERVICE_ACCOUNT_JSON: raw })?.audience).toBe(CONFIG.audience);
    const b64 = Buffer.from(raw).toString('base64');
    expect(readExternalAccountConfig({ GCP_SERVICE_ACCOUNT_JSON: b64 })?.audience).toBe(CONFIG.audience);
  });

  it('rejects anything that is not an AWS external account', () => {
    expect(readExternalAccountConfig({})).toBeNull();
    expect(readExternalAccountConfig({ GCP_SERVICE_ACCOUNT_JSON: '{not json' })).toBeNull();
    expect(readExternalAccountConfig({ GCP_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account' }) })).toBeNull();
    expect(
      readExternalAccountConfig({
        GCP_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...CONFIG, subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' }),
      }),
    ).toBeNull();
  });
});

describe('makeAwsSupplier', () => {
  it('maps the SDK credentials and takes the region from the environment', async () => {
    const supplier = makeAwsSupplier(
      async () => ({ accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', sessionToken: 'session' }),
      { AWS_REGION: 'eu-central-1' },
    );
    const ctx = {} as never;
    expect(await supplier.getAwsRegion(ctx)).toBe('eu-central-1');
    expect(await supplier.getAwsSecurityCredentials(ctx)).toEqual({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      token: 'session',
    });
  });

  it('builds with the AWS SDK default provider when none is passed', () => {
    // Catches a wrong import: the default provider is only evaluated here.
    expect(() => makeAwsSupplier()).not.toThrow();
  });

  it('defaults the region to eu-central-1', async () => {
    const supplier = makeAwsSupplier(async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), {});
    expect(await supplier.getAwsRegion({} as never)).toBe('eu-central-1');
  });
});

describe('buildGoogleAwsClient', () => {
  it('replaces the credential source with the supplier', () => {
    const client = buildGoogleAwsClient(CONFIG, makeAwsSupplier(async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), {}));
    expect((client as unknown as { credentialSourceType: string }).credentialSourceType).toBe('programmatic');
  });

  it('signs the AWS request from the supplier, with no metadata call', async () => {
    const provider = jest.fn(async () => ({ accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', sessionToken: 'session' }));
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    const client = buildGoogleAwsClient(CONFIG, makeAwsSupplier(provider, { AWS_REGION: 'eu-central-1' }));
    const subject = await (client as unknown as { retrieveSubjectToken(): Promise<string> }).retrieveSubjectToken();
    const decoded = JSON.parse(decodeURIComponent(subject));
    expect(decoded.url).toContain('sts.eu-central-1.amazonaws.com');
    expect(decoded.url).toContain('GetCallerIdentity');
    expect(JSON.stringify(decoded.headers)).toContain('AKIA_TEST');
    expect(JSON.stringify(decoded.headers)).toContain('session');
    expect(provider).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('wiring', () => {
  const root = join(__dirname, '..', '..', '..');

  it('orb-live takes the supplier path only behind the flag, before the GoogleAuth path', () => {
    const src = readFileSync(join(__dirname, '../src/routes/orb-live.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function fetchFreshAccessToken'));
    const flag = fn.indexOf('isGoogleAwsSupplierEnabled()');
    const adc = fn.indexOf('googleAuth.getClient()');
    expect(flag).toBeGreaterThan(-1);
    expect(adc).toBeGreaterThan(flag);
  });

  it('staging turns the flag on; production does not set it yet', () => {
    const stage = readFileSync(join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    const prod = readFileSync(join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(stage).toContain('{name:"GOOGLE_AUTH_AWS_SUPPLIER_ENABLED", value:"true"}');
    expect(prod).not.toContain('GOOGLE_AUTH_AWS_SUPPLIER_ENABLED');
  });
});
