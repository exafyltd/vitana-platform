/**
 * Human-task service (simplifies the human-in-the-loop).
 *
 * One inbox over all open tasks, grouped for fast clearing, with single-call and
 * bulk completion that advances the linked account/job. KYB approvals require the
 * two-role gate (staff + admin) via KybFlow; other tasks complete directly. Every
 * action emits an OASIS event.
 */
import { Repository, Record_ } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { KybFlow, Role } from './kyb-flow';

export interface InboxGroup {
  type: string;
  count: number;
  tasks: Record_[];
}
export interface Inbox {
  tenantId: string;
  openCount: number;
  groups: InboxGroup[];
}

export class HumanTaskService {
  private readonly kyb: KybFlow;
  constructor(private readonly repo: Repository, private readonly oasis: OasisSink) {
    this.kyb = new KybFlow(repo, oasis);
  }

  /** Grouped inbox of open tasks for fast triage. */
  async inbox(tenantId: string): Promise<Inbox> {
    const open = await this.repo.list('human_task', (t) => t.tenant_id === tenantId && (t.status === 'open' || t.status === 'in_progress'));
    const byType = new Map<string, Record_[]>();
    for (const t of open) {
      const k = String(t.type);
      (byType.get(k) ?? byType.set(k, []).get(k)!).push(t);
    }
    return {
      tenantId, openCount: open.length,
      groups: [...byType.entries()].map(([type, tasks]) => ({ type, count: tasks.length, tasks })),
    };
  }

  /** Complete a non-approval task and advance its job/account. */
  async complete(taskId: string, evidenceRef?: string): Promise<{ taskStatus: string }> {
    const task = await this.repo.get('human_task', taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.type === 'KYB') throw new Error('KYB tasks require approve() with staff + admin, not complete()');
    await this.repo.update('human_task', taskId, { status: 'completed', evidence_refs: evidenceRef ? [evidenceRef] : null });
    if (task.account_id) await this.repo.update('provider_account', String(task.account_id), { status: 'verification_pending' });
    if (task.job_id) await this.repo.update('provisioning_job', String(task.job_id), { status: 'running' });
    await this.oasis.emit({
      type: 'vcaop.human_task.completed', source: 'human-task-service', status: 'success',
      message: `task ${taskId} (${task.type}) completed`, payload: { taskId, type: task.type },
    });
    return { taskStatus: 'completed' };
  }

  /** Approve a KYB task (two-role gate via KybFlow). */
  async approveKyb(taskId: string, role: Role) {
    return this.kyb.approve(taskId, role);
  }

  /** Complete many non-approval tasks in one action (the "finish faster" path). */
  async bulkComplete(taskIds: string[]): Promise<{ completed: string[]; skipped: { id: string; reason: string }[] }> {
    const completed: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of taskIds) {
      try {
        await this.complete(id);
        completed.push(id);
      } catch (e) {
        skipped.push({ id, reason: (e as Error).message });
      }
    }
    return { completed, skipped };
  }
}
