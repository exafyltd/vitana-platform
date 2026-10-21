import { KybFlow } from '../../src/onboarding/kyb-flow';
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';

function setup() {
  const repo = new InMemoryRepository();
  const oasis = new InMemoryOasisSink();
  return { repo, oasis, flow: new KybFlow(repo, oasis) };
}
const identity = { tenantId: 'platform', officerIdRef: 'vault://officer/1', documentRefs: ['vault://doc/passport', 'vault://doc/incorp'] };

describe('KYB-FLOW-0001 — human-in-the-loop onboarding', () => {
  test('first provider opens a KYB task; account is kyb_pending', async () => {
    const { flow, repo } = setup();
    const r = await flow.startOnboarding('platform', 'amazon', identity);
    expect(r.reusedArtifacts).toBe(false);
    expect(r.status).toBe('kyb_pending');
    expect(r.kybTaskId).toBeDefined();
    const task = await repo.get('human_task', r.kybTaskId!);
    expect(task!.type).toBe('KYB');
    // payload is PII-free (refs + field names only)
    expect(JSON.stringify(task!.payload)).not.toMatch(/@|\bstreet\b/i);
  });

  test('advances ONLY after BOTH staff and admin approve', async () => {
    const { flow } = setup();
    const r = await flow.startOnboarding('platform', 'amazon', identity);
    const afterStaff = await flow.approve(r.kybTaskId!, 'staff');
    expect(afterStaff.advanced).toBe(false);
    expect(afterStaff.accountStatus).toBe('kyb_pending'); // not yet advanced
    const afterAdmin = await flow.approve(r.kybTaskId!, 'admin');
    expect(afterAdmin.advanced).toBe(true);
    expect(afterAdmin.accountStatus).toBe('active');
    expect(afterAdmin.taskStatus).toBe('approved');
  });

  test('admin-then-staff order also requires both', async () => {
    const { flow } = setup();
    const r = await flow.startOnboarding('platform', 'ebay', identity);
    expect((await flow.approve(r.kybTaskId!, 'admin')).advanced).toBe(false);
    expect((await flow.approve(r.kybTaskId!, 'staff')).advanced).toBe(true);
  });

  test('KYB artifacts are reused for the next provider (no second KYB task)', async () => {
    const { flow } = setup();
    const first = await flow.startOnboarding('platform', 'amazon', identity);
    await flow.approve(first.kybTaskId!, 'staff');
    await flow.approve(first.kybTaskId!, 'admin');

    const second = await flow.startOnboarding('platform', 'walmart', identity);
    expect(second.reusedArtifacts).toBe(true);
    expect(second.kybTaskId).toBeUndefined(); // no new KYB task
    expect(second.status).toBe('data_prepared');
  });

  test('artifacts are tenant-scoped (a different tenant still needs KYB)', async () => {
    const { flow } = setup();
    const a = await flow.startOnboarding('platform', 'amazon', identity);
    await flow.approve(a.kybTaskId!, 'staff');
    await flow.approve(a.kybTaskId!, 'admin');
    const other = await flow.startOnboarding('tenant2', 'amazon', { tenantId: 'tenant2', documentRefs: ['vault://d'] });
    expect(other.reusedArtifacts).toBe(false);
    expect(other.kybTaskId).toBeDefined();
  });
});
