/** Phase 5 — drift detection, repair pipeline, healing limits. */
import { detectDrift, FreshDiscovery } from '../../src/factory/drift';
import {
  applyRepair,
  healConnectorDrift,
  proposeRepair,
  testRepair,
} from '../../src/factory/repair';
import { DeterministicMappingProposer } from '../../src/factory/proposer';
import { ingestOpenApi } from '../../src/factory/openapi-ingest';
import { ConnectorManifest } from '../../src/factory/manifest';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { SandboxSupplierTransport } from './sandbox-transport';
import spec from './fixtures/sandbox-supplier-openapi.json';

const proposer = new DeterministicMappingProposer();

const certifiedManifest = (): ConnectorManifest => {
  const m = ingestOpenApi(spec as never, {
    connectorId: 'sandbox-supplier',
    partnerTenantId: 'tenant-a',
    providerId: 'sandbox_supplier',
  }).draft;
  m.certification = { status: 'certified', certified_at: '2026-08-08T00:00:00Z', certified_by: 'admin-1' };
  return m;
};

const policy = () => {
  const pe = new PolicyEngine();
  pe.setPolicy('sandbox_supplier', {
    automation_allowed: 'api_only',
    registration_method: 'human_required',
    captcha_policy: 'human_only',
    kyb_required: true,
    multi_account_allowed: false,
    affiliate_cashback_allowed: null,
    notes: 'sandbox fixture policy (test)',
  });
  return pe;
};

/** Fresh discovery identical to the certified manifest. */
const unchanged = (m: ConnectorManifest): FreshDiscovery => ({
  sourceSchemas: m.source_schemas.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f })) })),
  authMechanism: m.auth.mechanism,
  actionKeys: m.actions.map((a) => a.key),
});

describe('drift detection', () => {
  test('identical discovery → no drift', () => {
    const m = certifiedManifest();
    expect(detectDrift(m, unchanged(m)).materiality).toBe('none');
  });

  test('added optional non-sensitive field → non-material', () => {
    const m = certifiedManifest();
    const fresh = unchanged(m);
    const product = fresh.sourceSchemas.find((s) => s.name === 'Product')!;
    product.fields.push({ name: 'ean_code', type: 'string', required: false, sensitive: false });
    product.hash = 'changed-hash-0001';
    const report = detectDrift(m, fresh);
    expect(report.materiality).toBe('non_material');
    expect(report.changes.map((c) => c.kind)).toContain('field_added');
  });

  test('removed MAPPED field / type change on mapped field / auth change → material', () => {
    const m = certifiedManifest();

    const removed = unchanged(m);
    const order = removed.sourceSchemas.find((s) => s.name === 'Order')!;
    order.fields = order.fields.filter((f) => f.name !== 'total_amount');
    order.hash = 'changed-hash-0002';
    expect(detectDrift(m, removed).materiality).toBe('material');

    const typed = unchanged(m);
    const order2 = typed.sourceSchemas.find((s) => s.name === 'Order')!;
    order2.fields.find((f) => f.name === 'total_amount')!.type = 'string';
    order2.hash = 'changed-hash-0003';
    expect(detectDrift(m, typed).materiality).toBe('material');

    const auth = unchanged(m);
    auth.authMechanism = 'oauth2_client_credentials';
    expect(detectDrift(m, auth).materiality).toBe('material');
  });

  test('new SENSITIVE field → material (data classes the business never approved)', () => {
    const m = certifiedManifest();
    const fresh = unchanged(m);
    const order = fresh.sourceSchemas.find((s) => s.name === 'Order')!;
    order.fields.push({ name: 'customer_phone', type: 'string', required: false, sensitive: true });
    order.hash = 'changed-hash-0004';
    expect(detectDrift(m, fresh).materiality).toBe('material');
  });
});

describe('repair pipeline', () => {
  test('no drift → no proposal', async () => {
    const m = certifiedManifest();
    expect(await proposeRepair(m, unchanged(m), proposer)).toBeNull();
  });

  test('non-material repair: patch bump, sandbox-certifies, auto-applies; prior version untouched', async () => {
    const m = certifiedManifest();
    const approvals = [
      { source_schema: 'OrderRequest', source_field: 'customer_email', decision: 'approve' as const, decided_by: 'admin-1' },
    ];
    const fresh = unchanged(m);
    const product = fresh.sourceSchemas.find((s) => s.name === 'Product')!;
    product.fields.push({ name: 'ean_code', type: 'string', required: false, sensitive: false });
    product.hash = 'changed-hash-0005';

    const proposal = (await proposeRepair(m, fresh, proposer))!;
    expect(proposal.requiresApproval).toBe(false);
    expect(proposal.toVersion).toBe('0.1.1'); // patch bump

    const test_ = await testRepair(proposal, new SandboxSupplierTransport(), policy(), approvals);
    expect(test_.certification.status).toBe('certified');

    const applied = applyRepair(m, proposal, test_);
    expect(applied.manifest.version).toBe('0.1.1');
    expect(applied.priorVersion).toBe('0.1.0'); // rollback target intact
    expect(m.version).toBe('0.1.0'); // prior manifest never mutated
  }, 30000);

  test('material repair refuses to apply without a human approval, applies with one', async () => {
    const m = certifiedManifest();
    const approvals = [
      { source_schema: 'OrderRequest', source_field: 'customer_email', decision: 'approve' as const, decided_by: 'admin-1' },
    ];
    const fresh = unchanged(m);
    const order = fresh.sourceSchemas.find((s) => s.name === 'Order')!;
    order.fields = order.fields.filter((f) => f.name !== 'created_at'); // mapped field gone
    order.hash = 'changed-hash-0006';

    const proposal = (await proposeRepair(m, fresh, proposer))!;
    expect(proposal.requiresApproval).toBe(true);
    expect(proposal.toVersion).toBe('0.2.0'); // minor bump for material

    const test_ = await testRepair(proposal, new SandboxSupplierTransport(), policy(), approvals);
    expect(test_.certification.status).toBe('certified');

    expect(() => applyRepair(m, proposal, test_)).toThrow(/human approval/);
    const applied = applyRepair(m, proposal, test_, { approvedBy: 'admin-1', reason: 'partner removed created_at' });
    expect(applied.manifest.certification.certified_by).toBe('admin-1');
  }, 30000);

  test('HEALING LIMIT: a repair never expands scopes or swaps auth — certified values are kept', async () => {
    const m = certifiedManifest();
    m.auth.scopes = ['read:catalog'];
    const fresh = unchanged(m);
    fresh.authMechanism = 'oauth2_client_credentials'; // partner "upgraded" auth
    const product = fresh.sourceSchemas.find((s) => s.name === 'Product')!;
    product.hash = 'changed-hash-0007';
    product.fields.push({ name: 'promo_flag', type: 'boolean', required: false, sensitive: false });

    const proposal = (await proposeRepair(m, fresh, proposer))!;
    expect(proposal.proposedManifest.auth.mechanism).toBe(m.auth.mechanism); // unchanged
    expect(proposal.proposedManifest.auth.scopes).toEqual(['read:catalog']); // no expansion
    expect(proposal.requiresApproval).toBe(true); // auth drift is material
    expect(proposal.notes.join(' ')).toContain('re-authorize deliberately');
  });

  test('HEALING LIMIT: new partner actions are not auto-added — capability growth is onboarding, not repair', async () => {
    const m = certifiedManifest();
    const fresh = unchanged(m);
    fresh.actionKeys = [...fresh.actionKeys!, 'deleteAllProducts'];
    const product = fresh.sourceSchemas.find((s) => s.name === 'Product')!;
    product.hash = 'changed-hash-0008';
    const proposal = (await proposeRepair(m, fresh, proposer))!;
    expect(proposal.proposedManifest.actions.map((a) => a.key)).not.toContain('deleteAllProducts');
  });
});

describe('healConnectorDrift ladder', () => {
  const mkDeps = () => {
    const events: Array<{ topic: string }> = [];
    const tasks: Array<{ type: string; payload: Record<string, unknown> }> = [];
    return {
      deps: {
        proposer,
        policyEngine: policy(),
        transport: new SandboxSupplierTransport(),
        emit: (e: { topic: string }) => events.push(e),
        emitHumanTask: (t: { type: string; payload: Record<string, unknown> }) => tasks.push(t),
      },
      events,
      tasks,
    };
  };

  test('no drift → no_drift, silent (repetition ≠ signal)', async () => {
    const m = certifiedManifest();
    const { deps, events, tasks } = mkDeps();
    const result = await healConnectorDrift(m, unchanged(m), deps);
    expect(result.outcome).toBe('no_drift');
    expect(events).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  test('non-material drift → sandbox-tested auto repair with events', async () => {
    const m = certifiedManifest();
    // Approve the sensitive mapping as onboarding did, so certification can pass.
    m.canonical_mappings.find((x) => x.source_field === 'customer_email')!.decided_by = 'human';
    const fresh = unchanged(m);
    const product = fresh.sourceSchemas.find((s) => s.name === 'Product')!;
    product.fields.push({ name: 'ean_code', type: 'string', required: false, sensitive: false });
    product.hash = 'changed-hash-0009';

    const { deps, events, tasks } = mkDeps();
    const result = await healConnectorDrift(m, fresh, deps);
    expect(result.outcome).toBe('auto_repaired');
    expect(events.map((e) => e.topic)).toEqual([
      'mesh.connector.drift_detected',
      'mesh.connector.auto_repaired',
    ]);
    expect(tasks).toHaveLength(0);
  }, 30000);

  test('material drift → human task, nothing applied automatically', async () => {
    const m = certifiedManifest();
    const fresh = unchanged(m);
    const order = fresh.sourceSchemas.find((s) => s.name === 'Order')!;
    order.fields = order.fields.filter((f) => f.name !== 'total_amount');
    order.hash = 'changed-hash-0010';

    const { deps, tasks } = mkDeps();
    const result = await healConnectorDrift(m, fresh, deps);
    expect(result.outcome).toBe('approval_required');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('CONNECTOR_REPAIR_APPROVAL');
    expect(JSON.stringify(tasks[0])).not.toMatch(/vault:|secret_refs/);
  });
});
