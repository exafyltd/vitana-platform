import { ConnectorFactory } from '../../src/factory/factory';
import { ingestOpenApi } from '../../src/factory/openapi-ingest';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { HumanTaskRequired, PolicyDenied } from '../../src/guardrails/errors';
import { JobContext } from '../../src/connectors/connector';
import { SandboxSupplierTransport } from './sandbox-transport';
import spec from './fixtures/sandbox-supplier-openapi.json';

const compile = () =>
  ConnectorFactory.compile(
    ingestOpenApi(spec as never, {
      connectorId: 'sandbox-supplier',
      partnerTenantId: 'tenant-a',
      providerId: 'sandbox_supplier',
    }).draft,
  );

const allowApiPolicy = () => {
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

const ctx = (emit: JobContext['emitHumanTask'] = () => undefined): JobContext => ({
  providerId: 'sandbox_supplier',
  tenantId: 'tenant-a',
  emitHumanTask: emit,
  env: { VCAOP_ENV: 'dev' } as unknown as NodeJS.ProcessEnv,
});

describe('ConnectorFactory', () => {
  test('compile refuses an invalid manifest', () => {
    expect(() => ConnectorFactory.compile({ connector_id: 'x' })).toThrow(/Manifest invalid/);
  });

  test('compiled connector operates a read through the sandbox transport', async () => {
    const compiled = compile();
    const connector = compiled.buildConnector(allowApiPolicy(), new SandboxSupplierTransport());
    const res = await connector.operate({ kind: 'listProducts' }, ctx());
    expect(res.ok).toBe(true);
    expect((res.data as { items: unknown[] }).items).toHaveLength(2);
  });

  test('GUARDRAIL INHERITANCE: default-deny — no policy row means the generated connector cannot operate', async () => {
    const compiled = compile();
    const connector = compiled.buildConnector(new PolicyEngine(), new SandboxSupplierTransport());
    await expect(connector.operate({ kind: 'listProducts' }, ctx())).rejects.toThrow(PolicyDenied);
  });

  test('GUARDRAIL INHERITANCE: human-gated action emits a human task and halts, never reaches the partner', async () => {
    const compiled = compile();
    const transport = new SandboxSupplierTransport();
    const connector = compiled.buildConnector(allowApiPolicy(), transport);
    const tasks: unknown[] = [];
    await expect(
      connector.operate({ kind: 'cancelOrder', payload: { id: 'sb-order-1' } }, ctx((t) => tasks.push(t))),
    ).rejects.toThrow(HumanTaskRequired);
    expect(tasks).toHaveLength(1);
    expect(transport.calls.find((c) => c.action === 'cancelOrder')).toBeUndefined();
  });

  test('GUARDRAIL INHERITANCE: registration is human-gated via BaseConnector', async () => {
    const compiled = compile();
    const connector = compiled.buildConnector(allowApiPolicy(), new SandboxSupplierTransport());
    await expect(
      connector.register({ tenantId: 'tenant-a', legalName: 'Synthetic GmbH', entityType: 'llc' }, ctx()),
    ).rejects.toThrow(HumanTaskRequired);
  });

  test('unknown action is refused — the manifest is the entire surface', async () => {
    const compiled = compile();
    const connector = compiled.buildConnector(allowApiPolicy(), new SandboxSupplierTransport());
    const res = await connector.operate({ kind: 'dropAllTables' }, ctx());
    expect(res.ok).toBe(false);
    expect((res.data as { error: string }).error).toBe('unknown_action');
  });

  test('invalid input is rejected by the generated validator before the transport runs', async () => {
    const compiled = compile();
    const transport = new SandboxSupplierTransport();
    const connector = compiled.buildConnector(allowApiPolicy(), transport);
    const res = await connector.operate({ kind: 'createOrder', payload: { sku: 123 } }, ctx());
    expect(res.ok).toBe(false);
    expect((res.data as { error: string }).error).toBe('invalid_input');
    expect(transport.calls.find((c) => c.action === 'createOrder')).toBeUndefined();
  });

  test('transient 5xx retries within the manifest budget, then succeeds', async () => {
    const compiled = compile();
    const transport = new SandboxSupplierTransport();
    transport.transientFailuresRemaining = 2; // retry budget is 3
    const connector = compiled.buildConnector(allowApiPolicy(), transport);
    const res = await connector.operate({ kind: 'listProducts' }, ctx());
    expect(res.ok).toBe(true);
    expect(transport.calls.filter((c) => c.action === 'listProducts')).toHaveLength(3);
  }, 15000);

  test('generated health check reports healthy against the sandbox and degraded on auth failure', async () => {
    const compiled = compile();
    const transport = new SandboxSupplierTransport();
    const connector = compiled.buildConnector(allowApiPolicy(), transport);
    const account = { id: 'acc-1', tenantId: 'tenant-a', providerId: 'sandbox_supplier', status: 'active' };
    expect((await connector.healthCheck(account)).status).toBe('healthy');
    transport.failAuth = true;
    expect((await connector.healthCheck(account)).status).toBe('degraded');
  });

  test('emits read-only MCP tool declarations for read capabilities only', () => {
    const compiled = compile();
    const names = compiled.mcpToolDeclarations.map((t) => t.name).sort();
    expect(names).toEqual(['sandbox-supplier_getProduct', 'sandbox-supplier_listProducts']);
    expect(compiled.mcpToolDeclarations.every((t) => t.readOnly)).toBe(true);
  });
});
