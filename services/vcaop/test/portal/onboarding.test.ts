/** Phase 3 — connect-business workflow end-to-end + controls. */
import {
  InMemoryConnectionRepository,
  PartnerOnboardingService,
  PortalEvent,
} from '../../src/portal/onboarding-service';
import { presentActivationSummary, presentMappingPreview } from '../../src/portal/views';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { SandboxSupplierTransport } from '../factory/sandbox-transport';
import spec from '../factory/fixtures/sandbox-supplier-openapi.json';

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

function makeService() {
  const events: PortalEvent[] = [];
  const repo = new InMemoryConnectionRepository();
  const service = new PartnerOnboardingService({
    repo,
    policyEngine: policy(),
    emit: (e) => events.push(e),
    transportFor: () => new SandboxSupplierTransport(),
  });
  return { service, events, repo };
}

const start = (service: PartnerOnboardingService) =>
  service.startConnection({
    tenantId: 'tenant-a',
    name: 'Sandbox Supplier GmbH',
    connectorId: 'sandbox-supplier',
    providerId: 'sandbox_supplier',
    openApiDocument: spec as never,
  });

describe('connect-business workflow', () => {
  test('full path: discover → mapping → review → sandbox tests → one approval → active', async () => {
    const { service, events } = makeService();
    let rec = await start(service);
    expect(rec.state).toBe('mapping');

    const preview = presentMappingPreview(rec);
    expect(preview.pending_review_count).toBeGreaterThan(0);
    const pending = preview.mappings.find((m) => m.needs_review)!;
    expect(pending.source).toBe('OrderRequest.customer_email');

    // First sandbox run blocks on the sensitive mapping — nothing silently activates.
    rec = await service.runSandboxTests(rec.id);
    expect(rec.state).toBe('approval_required');

    // Human reviews the mapping…
    rec = await service.submitMappingDecision(rec.id, {
      source_schema: 'OrderRequest',
      source_field: 'customer_email',
      decision: 'approve',
      decided_by: 'admin-1',
    });
    // …and re-tests: now certified.
    rec = await service.runSandboxTests(rec.id);
    expect(rec.state).toBe('certified');

    // The ONE activation approval.
    rec = await service.approveActivation(rec.id, 'admin-1');
    expect(rec.state).toBe('active');
    expect(rec.approvedBy).toBe('admin-1');

    // Every transition audited.
    const topics = events.map((e) => e.topic);
    expect(topics).toEqual(
      expect.arrayContaining([
        'mesh.connection.discovered',
        'mesh.connection.mapping',
        'mesh.connection.testing',
        'mesh.connection.approval_required',
        'mesh.connection.certified',
        'mesh.connection.active',
      ]),
    );
    // Events may name fields (metadata, per the ManualConnector precedent) but
    // must never carry PII VALUES, vault references, or secret material.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/vault:/);
    expect(serialized).not.toMatch(/\S+@\S+\.\S+/); // no email-shaped values
    expect(serialized).not.toMatch(/secret_refs/);
  }, 30000);

  test('activation is refused before certification — approval alone is not enough', async () => {
    const { service } = makeService();
    const rec = await start(service);
    await service.runSandboxTests(rec.id); // → approval_required (sensitive mapping)
    await expect(service.approveActivation(rec.id, 'admin-1')).rejects.toThrow(/Refusing activation/);
  }, 30000);

  test('no machine-readable spec → authorization_required, never a guessed manifest', async () => {
    const { service } = makeService();
    const rec = await service.startConnection({
      tenantId: 'tenant-a',
      name: 'Fax-Only Wholesale',
      connectorId: 'fax-only',
      providerId: 'fax_only',
    });
    expect(rec.state).toBe('authorization_required');
    expect(rec.manifest).toBeUndefined();
  });

  test('pause / resume / reauthorize / revoke controls follow the state machine', async () => {
    const { service } = makeService();
    let rec = await start(service);
    await service.submitMappingDecision(rec.id, {
      source_schema: 'OrderRequest',
      source_field: 'customer_email',
      decision: 'approve',
      decided_by: 'admin-1',
    });
    await service.runSandboxTests(rec.id);
    rec = await service.approveActivation(rec.id, 'admin-1');

    rec = await service.pause(rec.id, 'staff-1');
    expect(rec.state).toBe('suspended');
    rec = await service.resume(rec.id, 'staff-1');
    expect(rec.state).toBe('active');
    rec = await service.reauthorize(rec.id, 'staff-1');
    expect(rec.state).toBe('suspended'); // held until fresh credentials complete
    rec = await service.revoke(rec.id, 'admin-1');
    expect(rec.state).toBe('revoked');
    // Revoked is terminal.
    await expect(service.resume(rec.id, 'staff-1')).rejects.toThrow(/Illegal/);
  }, 30000);

  test('activation summary states exactly what is being approved, with no refs', async () => {
    const { service } = makeService();
    const rec = await start(service);
    const view = presentActivationSummary(rec);
    expect(view.capabilities.length).toBeGreaterThan(0);
    expect(view.data_read).toEqual(expect.arrayContaining(['product', 'order']));
    expect(view.human_approval_required_for).toContain('cancelOrder');
    expect(view.auth_mechanism).toBe('api_key');
    expect(JSON.stringify(view)).not.toMatch(/(vault:|_ref|secret)/i);
  });

  test('mapping decisions require a human decided_by', async () => {
    const { service } = makeService();
    const rec = await start(service);
    await expect(
      service.submitMappingDecision(rec.id, {
        source_schema: 'OrderRequest',
        source_field: 'customer_email',
        decision: 'approve',
        decided_by: '',
      }),
    ).rejects.toThrow(/human/);
  });
});
