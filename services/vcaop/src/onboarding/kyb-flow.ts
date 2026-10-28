/**
 * KYB onboarding flow (KYB-FLOW-0001, runbook Sec. 6 / Sec. 4.2).
 *
 * Human-in-the-loop supplier onboarding:
 *  - portal pre-fills a KYB human_task (PII-free; values live in the RLS portal)
 *  - a KYB provider advances ONLY after BOTH staff AND admin approval
 *  - completed KYB artifacts are vaulted (refs) and REUSED for the next provider
 *    (no second KYB task once the tenant is verified)
 *
 * Storage-agnostic: works over the Repository + Vault + OasisSink abstractions
 * (in-memory impls for tests/dev; Prisma/Supabase-backed in the Gateway).
 */
import { Repository, Record_, newId } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { Vault } from '../vault/vault';
import { assertNoPii } from '../guardrails/no-pii-leak';

export type Role = 'staff' | 'admin';

export interface OnboardingResult {
  accountId: string;
  status: string;
  kybTaskId?: string;
  reusedArtifacts: boolean;
}

export interface KybIdentity {
  tenantId: string;
  /** Vault refs for documents/officer identity — never raw PII. */
  officerIdRef?: string;
  documentRefs?: string[];
}

export class KybFlow {
  constructor(
    private readonly repo: Repository,
    private readonly oasis: OasisSink,
    private readonly vault?: Vault,
  ) {}

  /** Reusable, verified KYB artifacts already on file for this tenant. */
  private async reusableArtifacts(tenantId: string): Promise<Record_[]> {
    return this.repo.list('kyb_artifact', (r) => r.tenant_id === tenantId && r.reusable === true);
  }

  /**
   * Begin onboarding a provider. If the tenant already has reusable KYB artifacts,
   * skip the KYB task and pre-advance; otherwise open a KYB human_task.
   */
  async startOnboarding(tenantId: string, providerId: string, identity: KybIdentity): Promise<OnboardingResult> {
    const reusable = await this.reusableArtifacts(tenantId);
    const account = await this.repo.create('provider_account', {
      id: newId('provider_account'),
      tenant_id: tenantId,
      provider_id: providerId,
      status: reusable.length > 0 ? 'data_prepared' : 'kyb_pending',
    });

    if (reusable.length > 0) {
      await this.oasis.emit({
        type: 'vcaop.onboarding.kyb_reused',
        source: 'kyb-flow',
        status: 'success',
        message: `reused ${reusable.length} KYB artifact(s) for ${providerId}`,
        payload: { accountId: account.id, providerId, artifactCount: reusable.length },
      });
      return { accountId: account.id, status: account.status as string, reusedArtifacts: true };
    }

    // PII-free pre-filled KYB task payload (refs + field names only).
    const payload = {
      provider_id: providerId,
      officer_id_ref: identity.officerIdRef ?? null,
      required_document_refs: identity.documentRefs ?? [],
      fields_to_complete: ['legal_name', 'entity_type', 'registration_no', 'vat_eori', 'ein'],
      approvals: { staff: false, admin: false },
    };
    assertNoPii(payload, 'oasis_event');

    const task = await this.repo.create('human_task', {
      id: newId('human_task'),
      tenant_id: tenantId,
      type: 'KYB',
      status: 'open',
      provider_id: providerId,
      account_id: account.id,
      payload,
    });

    await this.oasis.emit({
      type: 'vcaop.onboarding.kyb_opened',
      source: 'kyb-flow',
      status: 'info',
      message: `KYB task opened for ${providerId}`,
      payload: { accountId: account.id, providerId, taskId: task.id },
    });

    return { accountId: account.id, status: account.status as string, kybTaskId: task.id, reusedArtifacts: false };
  }

  /**
   * Record an approval on a KYB task. The provider advances ONLY once BOTH staff
   * and admin have approved; at that point KYB artifacts are vaulted and marked
   * reusable for the tenant.
   */
  async approve(taskId: string, role: Role): Promise<{ taskStatus: string; accountStatus: string; advanced: boolean }> {
    const task = await this.repo.get('human_task', taskId);
    if (!task) throw new Error(`KYB task ${taskId} not found`);
    if (task.type !== 'KYB') throw new Error(`task ${taskId} is not a KYB task`);

    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const approvals = { staff: false, admin: false, ...(payload.approvals as object) } as { staff: boolean; admin: boolean };
    approvals[role] = true;

    const bothApproved = approvals.staff && approvals.admin;
    const accountId = String(task.account_id);
    const tenantId = String(task.tenant_id);
    const providerId = String(task.provider_id);

    await this.repo.update('human_task', taskId, {
      payload: { ...payload, approvals },
      status: bothApproved ? 'approved' : 'in_progress',
    });

    if (!bothApproved) {
      await this.oasis.emit({
        type: 'vcaop.onboarding.kyb_approval',
        source: 'kyb-flow',
        status: 'info',
        message: `${role} approved KYB ${taskId} (awaiting both roles)`,
        payload: { taskId, role },
      });
      const acct = await this.repo.get('provider_account', accountId);
      return { taskStatus: 'in_progress', accountStatus: String(acct?.status), advanced: false };
    }

    // Both approved → vault artifacts, mark reusable for the tenant, advance account.
    const docRefs = (payload.required_document_refs as string[]) ?? [];
    for (const ref of docRefs) {
      await this.repo.create('kyb_artifact', {
        id: newId('kyb_artifact'),
        tenant_id: tenantId,
        artifact_ref: ref,
        reusable: true,
        source_provider_id: providerId,
      });
    }
    await this.repo.update('provider_account', accountId, { status: 'active' });

    await this.oasis.emit({
      type: 'vcaop.onboarding.kyb_approved',
      source: 'kyb-flow',
      status: 'success',
      message: `KYB approved for ${providerId}; account active; ${docRefs.length} artifact(s) reusable`,
      payload: { taskId, accountId, providerId, reusableArtifacts: docRefs.length },
    });

    return { taskStatus: 'approved', accountStatus: 'active', advanced: true };
  }
}
