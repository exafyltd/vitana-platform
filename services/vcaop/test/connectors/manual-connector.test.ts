import { ManualConnector } from '../../src/connectors/manual-connector';
import { JobContext, BusinessIdentity } from '../../src/connectors/connector';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { HumanTaskRequired } from '../../src/guardrails/errors';
import { assertNoPii } from '../../src/guardrails/no-pii-leak';
import { HumanTask } from '../../src/guardrails/human-gate';

const manualPolicy: ProviderPolicy = {
  automation_allowed: 'manual_only',
  registration_method: 'human_required',
  captcha_policy: 'human_only',
  kyb_required: true,
  multi_account_allowed: false,
  affiliate_cashback_allowed: null,
  notes: 't',
};

function setup() {
  const pe = new PolicyEngine();
  pe.setPolicy('target', manualPolicy);
  const connector = new ManualConnector(pe);
  const tasks: HumanTask[] = [];
  const ctx: JobContext = { providerId: 'target', tenantId: 'platform', accountId: 'acc1', env: { VCAOP_ENV: 'dev' }, emitHumanTask: (t) => tasks.push(t) };
  return { connector, ctx, tasks };
}

describe('CONN-MANUAL-0005 — ManualConnector (human-task generator)', () => {
  test('register emits a KYB human task with a pre-filled, PII-free payload', async () => {
    const { connector, ctx, tasks } = setup();
    const identity: BusinessIdentity = {
      tenantId: 'platform',
      legalName: 'Exafy Ltd',
      entityType: 'ltd',
      officerIdRef: 'vault://officer/1',
      documentRefs: ['vault://doc/a', 'vault://doc/b'],
    };
    await expect(connector.register(identity, ctx)).rejects.toBeInstanceOf(HumanTaskRequired);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.type).toBe('KYB'); // kyb_required policy
    // payload is pre-filled with refs + field NAMES, no raw PII values
    expect(task.payload.business_identity_ref).toBeDefined();
    expect(task.payload.required_document_refs).toEqual(['vault://doc/a', 'vault://doc/b']);
    expect(task.payload.fields_to_complete).toContain('legal_name');
    const blob = JSON.stringify(task.payload);
    expect(blob).not.toContain('Exafy Ltd'); // raw legal name not in payload
    expect(() => assertNoPii(task.payload, 'oasis_event')).not.toThrow();
  });

  test('operate generates a human task and halts', async () => {
    const { connector, ctx, tasks } = setup();
    await expect(connector.operate({ kind: 'update_listing' }, ctx)).rejects.toBeInstanceOf(HumanTaskRequired);
    expect(tasks[0].payload.action).toBe('update_listing');
  });

  test('healthCheck is unknown (human-operated)', async () => {
    const { connector } = setup();
    const r = await connector.healthCheck({ id: 'acc1', tenantId: 'platform', providerId: 'target', status: 'active' });
    expect(r.status).toBe('unknown');
  });
});
