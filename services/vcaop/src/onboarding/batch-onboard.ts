/**
 * Batch onboarding kickoff (revenue enablement).
 *
 * Turns the prepared provider catalog into a wave of queued onboarding jobs +
 * pre-filled human tasks in ONE call — so the human-in-the-loop can clear KYB /
 * accept-ToS / register checkpoints from a single inbox instead of one provider at
 * a time. The agent does the data-prep/form-fill; the human clears the gates.
 */
import { Repository, newId } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { Conductor } from '../agents/conductor';
import { assertNoPii } from '../guardrails/no-pii-leak';

export interface BatchOnboardEntry {
  providerId: string;
}

export interface BatchOnboardItemResult {
  providerId: string;
  status: 'queued' | 'denied';
  accountId?: string;
  jobId?: string;
  humanTaskIds?: string[];
  reason?: string;
}

export interface BatchOnboardSummary {
  total: number;
  queued: number;
  denied: number;
  humanTasksCreated: number;
  items: BatchOnboardItemResult[];
}

export class BatchOnboarder {
  constructor(private readonly repo: Repository, private readonly oasis: OasisSink, private readonly conductor: Conductor) {}

  /** Fan out a list of providers into queued provisioning jobs + human tasks. */
  async kickoff(tenantId: string, entries: BatchOnboardEntry[], officerIdRef?: string): Promise<BatchOnboardSummary> {
    const items: BatchOnboardItemResult[] = [];
    let queued = 0, denied = 0, humanTasksCreated = 0;

    for (const e of entries) {
      let plan;
      try {
        plan = this.conductor.planJob(e.providerId, 'onboard'); // throws if denied/unknown
      } catch (err) {
        denied++;
        items.push({ providerId: e.providerId, status: 'denied', reason: (err as Error).message });
        continue;
      }

      const account = await this.repo.create('provider_account', {
        id: newId('provider_account'), tenant_id: tenantId, provider_id: e.providerId, status: 'discovered',
      });
      const job = await this.repo.create('provisioning_job', {
        id: newId('provisioning_job'), tenant_id: tenantId, provider_account_id: account.id,
        status: 'queued', connector_tier: plan.connectorTier,
      });

      // One human task per human-gated step (KYB / registration submit).
      const taskIds: string[] = [];
      for (const step of plan.steps.filter((s) => s.humanGated)) {
        const type = step.kind === 'kyb' ? 'KYB' : 'IRREVERSIBLE_SUBMIT';
        const payload = {
          provider_id: e.providerId, step: step.kind, job_id: job.id,
          business_identity_ref: `business_identity:${tenantId}`, officer_id_ref: officerIdRef ?? null,
          fields_to_complete: ['legal_name', 'entity_type', 'registration_no', 'vat_eori'],
        };
        assertNoPii(payload, 'oasis_event');
        const task = await this.repo.create('human_task', {
          id: newId('human_task'), tenant_id: tenantId, type, provider_id: e.providerId,
          job_id: job.id, account_id: account.id, status: 'open', payload,
        });
        taskIds.push(task.id);
        humanTasksCreated++;
      }

      queued++;
      items.push({ providerId: e.providerId, status: 'queued', accountId: account.id, jobId: job.id, humanTaskIds: taskIds });
    }

    await this.oasis.emit({
      type: 'vcaop.onboarding.batch_kickoff', source: 'batch-onboarder', status: 'success',
      message: `batch onboarding: ${queued} queued, ${denied} denied, ${humanTasksCreated} human tasks`,
      payload: { tenantId, total: entries.length, queued, denied, humanTasksCreated },
    });

    return { total: entries.length, queued, denied, humanTasksCreated, items };
  }
}
