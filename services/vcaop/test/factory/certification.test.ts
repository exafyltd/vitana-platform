import { ConnectorFactory } from '../../src/factory/factory';
import { activateConnector, runCertification } from '../../src/factory/certification';
import { ingestOpenApi } from '../../src/factory/openapi-ingest';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { SandboxSupplierTransport } from './sandbox-transport';
import spec from './fixtures/sandbox-supplier-openapi.json';

const compiled = () =>
  ConnectorFactory.compile(
    ingestOpenApi(spec as never, {
      connectorId: 'sandbox-supplier',
      partnerTenantId: 'tenant-a',
      providerId: 'sandbox_supplier',
    }).draft,
  );

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

const APPROVE_EMAIL = {
  source_schema: 'OrderRequest',
  source_field: 'customer_email',
  decision: 'approve' as const,
  decided_by: 'reviewer-1',
};

describe('certification pipeline', () => {
  test('sensitive / low-confidence mappings block certification with approval_required', async () => {
    const c = compiled();
    const res = await runCertification(c, new SandboxSupplierTransport(), policy());
    expect(res.status).toBe('approval_required');
    expect(res.pendingMappings.map((p) => p.source_field)).toContain('customer_email');
    // Contract tests themselves all passed — the block is the mapping gate.
    expect(res.testResults.every((t) => t.passed)).toBe(true);
  }, 20000);

  test('an explicit human MappingDecision unblocks certification', async () => {
    const c = compiled();
    const res = await runCertification(c, new SandboxSupplierTransport(), policy(), {
      approvals: [APPROVE_EMAIL],
    });
    expect(res.status).toBe('certified');
    expect(res.pendingMappings).toEqual([]);
  }, 20000);

  test('a failing contract test fails certification outright', async () => {
    const c = compiled();
    const broken = new SandboxSupplierTransport();
    broken.failAuth = true; // every real call 401s → happy-path reads fail
    const res = await runCertification(c, broken, policy(), { approvals: [APPROVE_EMAIL] });
    expect(res.status).toBe('failed');
    expect(res.testResults.some((t) => !t.passed)).toBe(true);
  }, 20000);

  test('activation refuses anything not certified — no override exists', async () => {
    const c = compiled();
    const pending = await runCertification(c, new SandboxSupplierTransport(), policy());
    expect(() => activateConnector(c, pending, policy(), new SandboxSupplierTransport())).toThrow(/Refusing activation/);
  }, 20000);

  test('certified manifest activates and the activated connector serves reads', async () => {
    const c = compiled();
    const pe = policy();
    const transport = new SandboxSupplierTransport();
    const cert = await runCertification(c, transport, pe, { approvals: [APPROVE_EMAIL] });
    const active = activateConnector(c, cert, pe, transport);
    expect(active.state).toBe('active');
    const res = await active.build.operate(
      { kind: 'getProduct', payload: { id: 'sb-prod-1' } },
      { providerId: 'sandbox_supplier', tenantId: 'tenant-a', emitHumanTask: () => undefined, env: { VCAOP_ENV: 'dev' } as unknown as NodeJS.ProcessEnv },
    );
    expect(res.ok).toBe(true);
  }, 20000);
});
