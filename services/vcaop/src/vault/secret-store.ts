/**
 * Secret store abstraction for the VCAOP vault (VAULT-CORE-0001, runbook Sec. 4.5).
 *
 * Secret MATERIAL lives ONLY here (backed by Cloud Secret Manager in prod). The
 * database stores references (`*_ref`) returned by `put`, never values
 * (no-credential-store guardrail). This interface is what the Vault sits on; the
 * in-memory impl is for tests/dev. A Secret Manager impl is a runtime concern
 * (BLK-001) implemented behind the same interface.
 */
export interface SecretStore {
  /** Store secret material under a logical name; returns a reference (never the value). */
  put(name: string, value: string): Promise<string>;
  /** Retrieve secret material by reference. ONLY callable inside the trusted vault. */
  get(ref: string): Promise<string | null>;
  /** Delete secret material. */
  delete(ref: string): Promise<void>;
  exists(ref: string): Promise<boolean>;
}

/** Reference format: `vault://<name>`. Opaque to callers. */
export function refFor(name: string): string {
  return `vault://${name}`;
}

export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();

  async put(name: string, value: string): Promise<string> {
    const ref = refFor(name);
    this.map.set(ref, value);
    return ref;
  }
  async get(ref: string): Promise<string | null> {
    return this.map.get(ref) ?? null;
  }
  async delete(ref: string): Promise<void> {
    this.map.delete(ref);
  }
  async exists(ref: string): Promise<boolean> {
    return this.map.has(ref);
  }
}
