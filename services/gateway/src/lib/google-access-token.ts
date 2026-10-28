/**
 * VTID-04893 — Google access tokens on AWS ECS through the task role.
 *
 * The gateway reaches the dedicated Google project (the Serbian/Russian
 * Vertex Live bridges, VTID-04000/04813) with Workload Identity Federation:
 * `GCP_SERVICE_ACCOUNT_JSON` holds an `external_account` config that trades
 * AWS credentials for a Google token. That config was generated with an
 * EC2-style credential source, so google-auth-library looks for AWS
 * credentials at the EC2 instance metadata endpoint. ECS Fargate does not
 * serve it, and every token request fails (`connect EINVAL`). CloudWatch
 * shows the bridge's own token prewarm failing this way on staging
 * (2026-10-02) and production (2026-09-28).
 *
 * This module supplies the AWS credentials programmatically instead, through
 * google-auth-library's `AwsSecurityCredentialsSupplier`, from the AWS SDK's
 * default provider chain. On ECS that chain reads the task role from the
 * container credentials endpoint. The rest of the Workload Identity config
 * (audience, token URL, service-account impersonation) is used unchanged.
 *
 * Off unless `GOOGLE_AUTH_AWS_SUPPLIER_ENABLED` is exactly `true`. Callers
 * that already have a path (orb-live's `GoogleAuth`) keep it while the flag
 * is off. The Google side must trust the ECS task role for the exchange to
 * succeed; that binding is an owner-side GCP setting, not code.
 */

import { AwsClient, type AwsSecurityCredentialsSupplier } from 'google-auth-library';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const AWS_SUBJECT_TOKEN_TYPE = 'urn:ietf:params:aws:token-type:aws4_request';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export function isGoogleAwsSupplierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GOOGLE_AUTH_AWS_SUPPLIER_ENABLED ?? '').trim() === 'true';
}

/**
 * The Workload Identity `external_account` config from
 * `GCP_SERVICE_ACCOUNT_JSON` (raw JSON or base64, the same forms
 * `gcp-adc-bootstrap.ts` accepts). Null when it is unset, malformed, or not an
 * AWS-sourced external account.
 */
export function readExternalAccountConfig(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | null {
  const raw = env.GCP_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.type !== 'external_account') return null;
    if (parsed.subject_token_type !== AWS_SUBJECT_TOKEN_TYPE) return null;
    return parsed;
  } catch {
    return null;
  }
}

type AwsCredentialProvider = () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

/**
 * Supplies the region and the task role's credentials. The SDK provider
 * caches and refreshes the credentials itself; google-auth-library does not
 * cache what a supplier returns, so the cached provider matters.
 */
export function makeAwsSupplier(
  provider: AwsCredentialProvider = defaultProvider(),
  env: NodeJS.ProcessEnv = process.env,
): AwsSecurityCredentialsSupplier {
  return {
    getAwsRegion: async () => env.AWS_REGION || env.AWS_DEFAULT_REGION || 'eu-central-1',
    getAwsSecurityCredentials: async () => {
      const c = await provider();
      return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, token: c.sessionToken };
    },
  };
}

/**
 * An `AwsClient` built from the external account config with the
 * programmatic supplier in place of the config's credential source.
 */
export function buildGoogleAwsClient(
  config: Record<string, unknown>,
  supplier: AwsSecurityCredentialsSupplier,
): AwsClient {
  const { credential_source: _ignored, ...rest } = config;
  return new AwsClient({
    ...(rest as Record<string, unknown>),
    type: 'external_account',
    scopes: [CLOUD_PLATFORM_SCOPE],
    aws_security_credentials_supplier: supplier,
  } as unknown as ConstructorParameters<typeof AwsClient>[0]);
}

let client: AwsClient | null = null;

/** The shared client, built once per process. Throws when the config is missing. */
export function getGoogleAwsClient(): AwsClient {
  if (client) return client;
  const config = readExternalAccountConfig();
  if (!config) {
    throw new Error('google_auth_config_missing: GCP_SERVICE_ACCOUNT_JSON is not an AWS external_account config');
  }
  client = buildGoogleAwsClient(config, makeAwsSupplier());
  return client;
}

export interface GoogleAccessToken {
  token: string;
  /** Epoch ms, when Google reported it. */
  expiresAt: number | null;
}

/**
 * A Google access token through the task-role supplier. The client caches the
 * token until shortly before it expires.
 */
export async function getGoogleAccessTokenViaAwsSupplier(): Promise<GoogleAccessToken> {
  const c = getGoogleAwsClient();
  const res = await c.getAccessToken();
  if (!res.token) throw new Error('google_auth_no_token: the token exchange returned no access token');
  const expiry = (c as { credentials?: { expiry_date?: number | null } }).credentials?.expiry_date;
  return { token: res.token, expiresAt: typeof expiry === 'number' ? expiry : null };
}

/** Test hook: forget the cached client. */
export function __resetGoogleAwsClientForTests(): void {
  client = null;
}
