/**
 * Admin UI view-models (UIA-CATALOG-0001 / UIA-OPS-0002, runbook Sec. 6).
 *
 * Framework-agnostic presenters the admin React app binds to (components live in
 * the Vitanaland frontend, BLK-003). NEVER render secrets/PII: every record is
 * passed through `stripSensitive` (drops *_ref / secret-like / PII-named fields).
 */
import { Repository, Record_ } from '../api/repository';
import { ProviderPolicy } from '../guardrails/policy-engine';

const PII_OR_SECRET = /password|secret|credential|token|apikey|api_key|totp|mfa_seed|recovery|officer_name|legal_name|registered_address|email|tax_id|ein|vat_eori/i;

/** Drop *_ref and any secret/PII-named field so the admin UI renders neither. */
export function stripSensitive(rec: Record_): Record_ {
  const out: Record_ = { id: rec.id };
  for (const [k, v] of Object.entries(rec)) {
    const key = k.toLowerCase();
    if (key.endsWith('_ref') || PII_OR_SECRET.test(key)) continue;
    out[k] = v;
  }
  return out;
}

export interface CatalogView {
  providers: Record_[];
  affiliatePrograms: Record_[];
}

/** Provider + affiliate catalog (policy is shown for editing; non-secret config only). */
export async function buildCatalogView(repo: Repository): Promise<CatalogView> {
  const providers = (await repo.list('provider')).map(stripSensitive);
  const affiliatePrograms = (await repo.list('affiliate_program')).map(stripSensitive);
  return { providers, affiliatePrograms };
}

export interface PolicyEditorModel {
  providerId: string;
  policy: ProviderPolicy;
  /** Allowed enum choices for the editor UI. */
  choices: {
    automation_allowed: string[];
    registration_method: string[];
    captcha_policy: string[];
  };
}

export function buildPolicyEditorModel(providerId: string, policy: ProviderPolicy): PolicyEditorModel {
  return {
    providerId,
    policy,
    choices: {
      automation_allowed: ['api_only', 'oauth_only', 'browser_with_human_submit', 'manual_only', 'denied'],
      registration_method: ['human_required', 'api', 'oauth'],
      captcha_policy: ['human_only'],
    },
  };
}

export interface OpsView {
  jobQueue: Record_[];
  humanTaskInbox: Record_[]; // open tasks awaiting action
  approvalsPending: Record_[]; // KYB/payout/transfer + Tier-B awaiting admin
  accounts: Record_[];
  auditRecent: Record_[];
}

/** Ops console: job queue, human-task inbox, approvals, accounts, audit — no secrets/PII. */
export async function buildOpsView(repo: Repository, auditLimit = 50): Promise<OpsView> {
  const open = (r: Record_) => r.status === 'open' || r.status === 'in_progress';
  const tasks = await repo.list('human_task');
  const approvalTypes = new Set(['KYB', 'PAYOUT_BANK_LINK', 'TRANSFER', 'PRIVILEGE_ESCALATION']);
  const audit = await repo.list('audit_event');
  return {
    jobQueue: (await repo.list('provisioning_job')).map(stripSensitive),
    humanTaskInbox: tasks.filter(open).map(stripSensitive),
    approvalsPending: tasks.filter((t) => open(t) && approvalTypes.has(String(t.type))).map(stripSensitive),
    accounts: (await repo.list('provider_account')).map(stripSensitive),
    auditRecent: audit.slice(-auditLimit).map(stripSensitive),
  };
}
