import { assertTransition, validateManifest } from '../../src/factory/manifest';
import { ingestOpenApi } from '../../src/factory/openapi-ingest';
import spec from './fixtures/sandbox-supplier-openapi.json';

const draftManifest = () =>
  ingestOpenApi(spec as never, {
    connectorId: 'sandbox-supplier',
    partnerTenantId: 'tenant-a',
    providerId: 'sandbox_supplier',
  }).draft;

describe('ConnectorManifest validation', () => {
  test('a well-formed ingested draft validates', () => {
    const res = validateManifest(draftManifest());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('inline secret VALUES are rejected — refs only (no-credential-store discipline)', () => {
    const m = draftManifest() as Record<string, unknown>;
    (m.auth as { secret_refs: string[] }).secret_refs = ['sk_live_abcdef1234567890abcdef'];
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/vault reference/);
  });

  test('secret-named fields carrying values (not refs) are rejected wherever they appear', () => {
    const m = draftManifest() as unknown as Record<string, { [k: string]: unknown }>;
    (m as Record<string, unknown>).webhook_config = {
      path: '/hooks/x',
      signature_header: 'X-Sig',
      secret_ref: 'vault:sandbox-supplier/webhook',
    };
    // Smuggle a raw token into a nested config-ish field.
    (m.rate_limits as Record<string, unknown>).api_token = 'ghp_abcdefghijklmnop123456';
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
  });

  test('mappings must reference declared schemas', () => {
    const m = draftManifest();
    m.canonical_mappings.push({
      source_schema: 'NotDeclared',
      source_field: 'x',
      canonical_entity: 'product',
      canonical_field: 'id',
      confidence: 1,
      decided_by: 'ai',
      sensitive: false,
    });
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('undeclared source schema');
  });

  test('a destructive action without human gate or idempotency key is rejected', () => {
    const m = draftManifest();
    const cancel = m.actions.find((a) => a.key === 'cancelOrder')!;
    cancel.human_gated = false;
    cancel.idempotency = 'none';
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('must be human_gated');
  });

  test('health check must point at a declared action', () => {
    const m = draftManifest();
    m.health_check.action_key = 'ghost';
    expect(validateManifest(m).ok).toBe(false);
  });

  test('connection state machine refuses illegal jumps', () => {
    expect(() => assertTransition('testing', 'certified')).not.toThrow();
    expect(() => assertTransition('mapping', 'active')).toThrow(/Illegal/);
    expect(() => assertTransition('revoked', 'active')).toThrow(/Illegal/);
  });
});
