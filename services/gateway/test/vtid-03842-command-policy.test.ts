/**
 * VTID-03842 — policy engine, exhaustively (pure function, no I/O).
 * Rows come from docs/backoffice/GOLDEN-WORKFLOWS.md §1.3 / §3.3 / §4.3.
 */
import { getCommandSpec, BACKOFFICE_COMMANDS } from '../src/constants/backoffice-commands';
import { DEFAULT_TENANT_POLICY, evaluateCommand, evaluateApproval, eligibleApproverCount, thresholdApprover, type PolicyActor } from '../src/services/backoffice/command-policy';

const spec = (t: string) => { const s = getCommandSpec(t); if (!s) throw new Error(t); return s; };
const actor = (caps: string[], extra: Partial<PolicyActor> = {}): PolicyActor =>
  ({ user_id: 'u1', active_role: 'backoffice', is_exafy_admin: false, capabilities: caps, channel: 'web', ...extra });
const P = DEFAULT_TENANT_POLICY;

describe('registry shape', () => {
  test('164 unique types, every ERPClaw-gated action is commit or high, approvers only on high', () => {
    expect(new Set(BACKOFFICE_COMMANDS.map((c) => c.type)).size).toBe(BACKOFFICE_COMMANDS.length);
    expect(BACKOFFICE_COMMANDS.length).toBe(164);
    for (const c of BACKOFFICE_COMMANDS) {
      if (c.tier === 'high') expect(c.approveCapability).toBeTruthy(); else expect(c.approveCapability).toBeNull();
    }
    expect(spec('crm.lead.create').tier).toBe('draft');
    expect(spec('sales.invoice.cancel').tier).toBe('high');
    expect(spec('sales.invoice.cancel').approveCapability).toBe('finance.approve');
    expect(spec('settings.company.create').approveCapability).toBe('erp.admin');
  });
});

describe('evaluateCommand — capability + tier', () => {
  test('read with the view capability executes; without it rejects capability_missing', () => {
    expect(evaluateCommand(spec('crm.lead.list'), {}, actor(['crm.view']), P, false).outcome).toBe('execute');
    const d = evaluateCommand(spec('crm.lead.list'), {}, actor(['sales.view']), P, false);
    expect(d).toMatchObject({ outcome: 'reject', reason: 'capability_missing', required_capability: 'crm.view' });
  });
  test('draft executes without confirmation', () => {
    expect(evaluateCommand(spec('crm.lead.create'), { lead_name: 'x' }, actor(['crm.manage']), P, false).outcome).toBe('execute');
  });
  test('commit needs the explicit confirmation', () => {
    const s = spec('accounting.journal.submit');
    expect(evaluateCommand(s, {}, actor(['accounting.post']), P, false)).toMatchObject({ tier: 'commit', outcome: 'reject', reason: 'confirmation_required' });
    expect(evaluateCommand(s, {}, actor(['accounting.post']), P, true)).toMatchObject({ tier: 'commit', outcome: 'execute' });
  });
  test('high always queues, even when confirmed, with the approver capability', () => {
    const d = evaluateCommand(spec('sales.invoice.cancel'), {}, actor(['sales.commit']), P, true);
    expect(d).toMatchObject({ tier: 'high', outcome: 'queue', reason: 'awaiting_approval', approve_capability: 'finance.approve' });
  });
  test('any-of capabilities: sales.invoice.cancel accepts a finance.approve holder as requester too', () => {
    expect(evaluateCommand(spec('sales.invoice.cancel'), {}, actor(['finance.approve']), P, true).outcome).toBe('queue');
  });
  test('exafy super-admin passes capability but still queues High-risk (no self-approval later)', () => {
    const d = evaluateCommand(spec('finance.payment.cancel'), {}, actor([], { is_exafy_admin: true, active_role: null }), P, true);
    expect(d.outcome).toBe('queue');
  });
  test('developer/infra ceiling is Read (§3.3 rule 5), even holding the capability', () => {
    expect(evaluateCommand(spec('crm.lead.list'), {}, actor(['crm.view'], { active_role: 'developer' }), P, false).outcome).toBe('execute');
    expect(evaluateCommand(spec('crm.lead.create'), {}, actor(['crm.manage'], { active_role: 'infra' }), P, true)).toMatchObject({ outcome: 'reject', reason: 'platform_role_read_only' });
  });
});

describe('evaluateCommand — §4.3 escalations', () => {
  test('submit-payment kind=pay → High-risk, approver finance.pay; kind=receive stays Commit', () => {
    const s = spec('finance.payment.submit');
    expect(evaluateCommand(s, { kind: 'pay', payment_entry_id: 'p' }, actor(['accounting.post']), P, true))
      .toMatchObject({ tier: 'high', outcome: 'queue', approve_capability: 'finance.pay', escalations: ['kind:pay'] });
    expect(evaluateCommand(s, { kind: 'receive', payment_entry_id: 'p' }, actor(['finance.approve']), P, true))
      .toMatchObject({ tier: 'commit', outcome: 'execute', escalations: [] });
  });
  test('journal submit tagged payroll → High-risk, approver payroll.approve', () => {
    const d = evaluateCommand(spec('accounting.journal.submit'), { tags: ['month-end', 'payroll'] }, actor(['accounting.post']), P, true);
    expect(d).toMatchObject({ tier: 'high', approve_capability: 'payroll.approve', escalations: ['tags:payroll'] });
  });
  test('amount ≥ threshold on a Commit → High-risk with the per-domain approver; below stays Commit', () => {
    const s = spec('finance.payment.allocate');
    expect(evaluateCommand(s, { amount: '25000.00' }, actor(['finance.approve']), P, true)).toMatchObject({ tier: 'high', approve_capability: 'finance.approve', escalations: ['amount>=25000'] });
    expect(evaluateCommand(s, { amount: 24999.99 }, actor(['finance.approve']), P, true)).toMatchObject({ tier: 'commit', outcome: 'execute' });
    expect(evaluateCommand(spec('accounting.journal.submit'), { amount: 30000 }, actor(['accounting.post']), P, true)).toMatchObject({ tier: 'high', approve_capability: 'accounting.close' });
    expect(thresholdApprover(spec('accounting.coa.add_account'))).toBe('accounting.close');
    expect(thresholdApprover(spec('sales.quotation.submit'))).toBe('finance.approve');
  });
  test('tenant threshold is honoured', () => {
    const d = evaluateCommand(spec('sales.invoice.submit'), { amount: 1000 }, actor(['sales.commit']), { ...P, high_risk_amount_threshold: 500 }, true);
    expect(d.tier).toBe('high');
  });
  test('escalations stack (pay + amount) and never downgrade', () => {
    const d = evaluateCommand(spec('finance.payment.submit'), { kind: 'pay', amount: 100000 }, actor(['accounting.post']), P, true);
    expect(d).toMatchObject({ tier: 'high', approve_capability: 'finance.pay', escalations: ['kind:pay', 'amount>=25000'] });
  });
  test('Read and Draft never escalate on amount', () => {
    expect(evaluateCommand(spec('crm.opportunity.create'), { amount: 9_999_999 }, actor(['crm.manage']), P, false).tier).toBe('draft');
  });
});

describe('evaluateCommand — channel ceilings', () => {
  test('voice: Read/Draft ok, Commit and High-risk rejected voice_not_permitted', () => {
    expect(evaluateCommand(spec('crm.lead.create'), {}, actor(['crm.manage'], { channel: 'voice' }), P, false).outcome).toBe('execute');
    expect(evaluateCommand(spec('sales.invoice.submit'), {}, actor(['sales.commit'], { channel: 'voice' }), P, true)).toMatchObject({ outcome: 'reject', reason: 'voice_not_permitted' });
    expect(evaluateCommand(spec('sales.invoice.cancel'), {}, actor(['sales.commit'], { channel: 'voice' }), P, true)).toMatchObject({ outcome: 'reject', reason: 'voice_not_permitted' });
  });
  test('chat: Commit executes with confirmation, High-risk queues', () => {
    expect(evaluateCommand(spec('sales.invoice.submit'), {}, actor(['sales.commit'], { channel: 'chat' }), P, true).outcome).toBe('execute');
    expect(evaluateCommand(spec('sales.invoice.cancel'), {}, actor(['sales.commit'], { channel: 'chat' }), P, true).outcome).toBe('queue');
  });
});

describe('evaluateApproval — maker-checker', () => {
  const approver = (caps: string[], extra: Partial<Parameters<typeof evaluateApproval>[0]> = {}) =>
    ({ user_id: 'u2', active_role: 'admin', is_exafy_admin: false, capabilities: caps, channel: 'web' as const, aal: 'aal2', ...extra });
  test('requester ≠ approver, for everyone including Exafy', () => {
    expect(evaluateApproval(approver(['finance.pay'], { user_id: 'u1' }), 'u1', 'finance.pay', P)).toEqual({ ok: false, reason: 'self_approval_forbidden' });
    expect(evaluateApproval(approver([], { user_id: 'u1', is_exafy_admin: true }), 'u1', 'finance.pay', P)).toEqual({ ok: false, reason: 'self_approval_forbidden' });
  });
  test('approver must hold the approve capability; approvals.policy never approves', () => {
    expect(evaluateApproval(approver(['finance.approve', 'approvals.policy']), 'u1', 'finance.pay', P)).toEqual({ ok: false, reason: 'approver_capability_missing' });
    expect(evaluateApproval(approver(['finance.pay']), 'u1', 'finance.pay', P)).toEqual({ ok: true });
  });
  test('only from the Approvals screen (web); MFA-backed session when policy requires it', () => {
    expect(evaluateApproval(approver(['finance.pay'], { channel: 'chat' }), 'u1', 'finance.pay', P)).toEqual({ ok: false, reason: 'approval_requires_approvals_screen' });
    expect(evaluateApproval(approver(['finance.pay'], { channel: 'voice' }), 'u1', 'finance.pay', P)).toEqual({ ok: false, reason: 'approval_requires_approvals_screen' });
    expect(evaluateApproval(approver(['finance.pay'], { aal: 'aal1' }), 'u1', 'finance.pay', P)).toEqual({ ok: false, reason: 'mfa_required' });
    expect(evaluateApproval(approver(['finance.pay'], { aal: null }), 'u1', 'finance.pay', { ...P, require_mfa_for_high: false })).toEqual({ ok: true });
  });
  test('platform roles cannot approve; erp.admin approves company creation', () => {
    expect(evaluateApproval(approver(['accounting.close'], { active_role: 'developer' }), 'u1', 'accounting.close', P)).toEqual({ ok: false, reason: 'platform_role_read_only' });
    expect(evaluateApproval(approver(['erp.admin']), 'u1', 'erp.admin', P)).toEqual({ ok: true });
    expect(evaluateApproval(approver(['crm.manage']), 'u1', 'crm.manage' as any, P)).toEqual({ ok: false, reason: 'no_approve_capability_on_request' });
  });
  test('minimum staffing counts distinct holders other than the requester', () => {
    expect(eligibleApproverCount(['u1', 'u2', 'u2'], 'u1')).toBe(1);
    expect(eligibleApproverCount(['u2', 'u3'], 'u1')).toBe(2);
  });
});
