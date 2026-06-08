import { Vault } from '../../src/vault/vault';
import { InMemorySecretStore } from '../../src/vault/secret-store';
import { assertNoSensitiveFields } from '../../src/guardrails/no-credential-store';

const SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"

function makeVault() {
  const store = new InMemorySecretStore();
  return { vault: new Vault(store), store };
}

describe('VAULT-CORE-0001 — Vault', () => {
  test('putCredential returns a ref (not the value); value lives only in the store', async () => {
    const { vault, store } = makeVault();
    const ref = await vault.putCredential('acc1', 'super-secret-token');
    expect(ref).toMatch(/^vault:\/\//);
    expect(ref).not.toContain('super-secret-token');
    expect(await store.get(ref)).toBe('super-secret-token'); // retrievable only inside the vault/store
    // The ref is safe to persist in the DB (passes no-credential-store as *_ref).
    expect(() => assertNoSensitiveFields('provider_account', { credential_ref: ref })).not.toThrow();
  });

  test('scoped short-lived credential is an ephemeral token, never the long-lived secret', async () => {
    const { vault } = makeVault();
    await vault.putCredential('acc1', 'long-lived-secret');
    const scoped = await vault.getScopedShortLivedCredential('acc1', 'operate:read', 60_000);
    expect(scoped.token).toMatch(/^stk_/);
    expect(scoped.token).not.toContain('long-lived-secret');
    expect(scoped.expiresAt).toBeGreaterThan(Date.now());
    expect(scoped.scope).toBe('operate:read');
  });

  test('scoped issuance fails when no credential exists', async () => {
    const { vault } = makeVault();
    await expect(vault.getScopedShortLivedCredential('missing', 's')).rejects.toThrow();
  });

  test('generateTotp from a vaulted seed matches the RFC vector at a fixed time', async () => {
    const { vault } = makeVault();
    await vault.putTotpSeed('acc1', SEED_B32);
    const code = await vault.generateTotp('acc1', 59, { digits: 8, algorithm: 'sha1' });
    expect(code).toBe('94287082'); // RFC 6238 Appendix B
  });

  test('verifyTotp accepts a freshly generated code', async () => {
    const { vault } = makeVault();
    await vault.putTotpSeed('acc1', SEED_B32);
    const t = 1234567890;
    const code = await vault.generateTotp('acc1', t, { digits: 8, algorithm: 'sha1' });
    expect(await vault.verifyTotp('acc1', code, t, { digits: 8, algorithm: 'sha1' })).toBe(true);
  });

  test('recovery codes are stored hashed; a valid code is consumed once', async () => {
    const { vault, store } = makeVault();
    const ref = await vault.putRecoveryCodes('acc1', ['code-AAA', 'code-BBB']);
    const stored = (await store.get(ref))!;
    expect(stored).not.toContain('code-AAA'); // hashed, not plaintext
    expect(await vault.useRecoveryCode('acc1', 'code-AAA')).toBe(true);
    expect(await vault.useRecoveryCode('acc1', 'code-AAA')).toBe(false); // single-use
    expect(await vault.useRecoveryCode('acc1', 'nope')).toBe(false);
    expect(await vault.useRecoveryCode('acc1', 'code-BBB')).toBe(true);
  });
});
