/**
 * VTID-04999: each Kiro seat holder's own API key, one Secrets Manager secret
 * per user under `<prefix>/<user_id>`.
 *
 * Only this service's task role can read or write that prefix. The key is
 * never returned by status(), never logged, and never echoed by a route.
 */
import {
  PutResourcePolicyCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/** The subset of SecretsManagerClient this store uses, so tests inject a fake. */
export interface SecretsClient { send(command: unknown): Promise<any> }

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_KEY_LENGTH = 4096;

export function isUserId(v: unknown): v is string { return typeof v === 'string' && USER_ID.test(v); }

/** Shape check only: Kiro decides whether the key is good. */
export function isPlausibleKey(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_LENGTH && /^\S+$/.test(v);
}

/** Secrets Manager could not be asked (throttle, network) — not the same as "no key". */
export class KeyUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'KeyUnavailableError'; }
}

function errName(err: unknown): string { return (err as { name?: string })?.name ?? ''; }

/**
 * Resource policy on every key secret: nobody but the runner's own task role may
 * read the value. An explicit Deny wins over any broad Allow another role (the
 * gateway's included) might carry, so "only the runner reads keys" does not
 * depend on how the shared roles are configured.
 */
export function onlyRunnerReadsPolicy(readerRoleArn: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'OnlyKiroRunnerReadsTheKey',
      Effect: 'Deny',
      Principal: '*',
      Action: 'secretsmanager:GetSecretValue',
      Resource: '*',
      Condition: { StringNotEquals: { 'aws:PrincipalArn': readerRoleArn } },
    }],
  });
}

export class KeyStore {
  constructor(
    private readonly sm: SecretsClient,
    private readonly prefix: string,
    private readonly readerRoleArn: string | null = null,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  secretName(userId: string): string {
    if (!isUserId(userId)) throw new Error('invalid user id');
    return `${this.prefix}/${userId.toLowerCase()}`;
  }

  async put(userId: string, key: string): Promise<void> {
    const name = this.secretName(userId);
    // A revoke force-deletes asynchronously: for a short while the name still
    // exists but is pending deletion, so neither create nor put works. Back off
    // and retry the create until the deletion has finished (DeleteSecret API docs).
    for (let attempt = 0; ; attempt++) {
      try {
        await this.sm.send(new CreateSecretCommand({
          Name: name,
          SecretString: key,
          Description: 'VTID-04999 Kiro API key of one Command Hub user',
          Tags: [{ Key: 'vtid', Value: 'VTID-04999' }],
        }));
        break;
      } catch (err) {
        const n = errName(err);
        if (n !== 'ResourceExistsException' && n !== 'InvalidRequestException') throw err;
        if (n === 'ResourceExistsException') {
          try {
            await this.sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: key }));
            break;
          } catch (putErr) {
            if (errName(putErr) !== 'InvalidRequestException') throw putErr; // pending deletion: retry the create
          }
        }
        if (attempt >= 5) throw err;
        await this.sleep(500 * 2 ** attempt);
      }
    }
    if (this.readerRoleArn) {
      await this.sm.send(new PutResourcePolicyCommand({ SecretId: name, ResourcePolicy: onlyRunnerReadsPolicy(this.readerRoleArn), BlockPublicPolicy: true }));
    }
  }

  /** Linked or not, and when it last changed. Never reads the value. */
  async status(userId: string): Promise<{ linked: boolean; updated_at: string | null }> {
    try {
      const d = await this.sm.send(new DescribeSecretCommand({ SecretId: this.secretName(userId) }));
      if (d?.DeletedDate) return { linked: false, updated_at: null };
      const at = d?.LastChangedDate ?? d?.CreatedDate ?? null;
      return { linked: true, updated_at: at ? new Date(at).toISOString() : null };
    } catch (err) {
      if (errName(err) === 'ResourceNotFoundException') return { linked: false, updated_at: null };
      throw err;
    }
  }

  /** The key, or null when the user has none. Any other failure is KeyUnavailableError. */
  async get(userId: string): Promise<string | null> {
    try {
      const r = await this.sm.send(new GetSecretValueCommand({ SecretId: this.secretName(userId) }));
      return typeof r?.SecretString === 'string' && r.SecretString ? r.SecretString : null;
    } catch (err) {
      const n = errName(err);
      if (n === 'ResourceNotFoundException') return null;
      // A secret scheduled for deletion answers InvalidRequestException: treat as no key.
      if (n === 'InvalidRequestException') return null;
      throw new KeyUnavailableError(n || 'secrets_manager_error');
    }
  }

  /** Revoke now: no recovery window, so the name is free for a re-link straight away. */
  async delete(userId: string): Promise<void> {
    try {
      await this.sm.send(new DeleteSecretCommand({ SecretId: this.secretName(userId), ForceDeleteWithoutRecovery: true }));
    } catch (err) {
      if (errName(err) !== 'ResourceNotFoundException') throw err;
    }
  }
}
