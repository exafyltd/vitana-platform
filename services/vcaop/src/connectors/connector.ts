/**
 * Connector interface (CONN-BASE-0001, runbook Sec. 4.4).
 *
 * One interface for onboarding AND checkout, across the connector ladder
 * (api > oauth > scim > browser > manual). Every concrete adapter extends
 * BaseConnector (see base-connector.ts), which routes EVERY method through the
 * guardrails (policy-engine, env-boundary, human-gate, CAPTCHA→task) so the gates
 * cannot be bypassed by an adapter.
 */
import type { EmitHumanTask } from '../guardrails/human-gate';

export type ConnectorMode = 'api' | 'oauth' | 'scim' | 'browser' | 'manual';

/** Minimal canonical business identity passed to register() (Sec. 4.1). PII stays vaulted. */
export interface BusinessIdentity {
  tenantId: string;
  legalName: string;
  entityType: string;
  /** Vault references for sensitive identity material — never raw values. */
  officerIdRef?: string;
  documentRefs?: string[];
  [k: string]: unknown;
}

export interface ProviderAccount {
  id: string;
  tenantId: string;
  providerId: string;
  status: string;
}

/** Per-job context threaded through every connector call. */
export interface JobContext {
  providerId: string;
  tenantId: string;
  accountId?: string;
  /** Sink for human_task emission when a gate trips. */
  emitHumanTask: EmitHumanTask;
  /** Environment for env-boundary (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Optional clock for deterministic tests. */
  now?: number;
  /** Called to mark an account degraded (e.g. OAuth refresh-token revoked, Sec. 4.5). */
  markDegraded?: (accountId: string, reason: string) => void;
}

export interface OperateAction {
  kind: string; // e.g. 'list_orders', 'route_cart'
  payload?: Record<string, unknown>;
}

export interface RegisterResult {
  status: 'submitted' | 'human_required' | 'active';
  accountId?: string;
  details?: Record<string, unknown>;
}
export interface VerifyResult {
  verified: boolean;
  details?: Record<string, unknown>;
}
export interface OperateResult {
  ok: boolean;
  data?: unknown;
}
export interface HealthResult {
  status: 'healthy' | 'degraded' | 'unknown';
  details?: Record<string, unknown>;
}

export interface Connector {
  mode(): ConnectorMode;
  register(identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult>;
  verify(ctx: JobContext): Promise<VerifyResult>;
  operate(action: OperateAction, ctx: JobContext): Promise<OperateResult>;
  healthCheck(account: ProviderAccount): Promise<HealthResult>;
}
