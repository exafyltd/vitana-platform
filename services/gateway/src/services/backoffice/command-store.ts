/**
 * VTID-03842 — persistence for BackOffice commands, approvals, the independent
 * audit log and per-tenant policy. Four tables (migration
 * supabase/migrations/20260913020000_vtid_03842_erp_commands_approvals_audit.sql,
 * NOT applied by the session that wrote it):
 *
 *   erp_commands      one row per command attempt (idempotent per tenant × key)
 *   erp_approvals     one row per High-risk request awaiting a different approver
 *   erp_audit_log     append-only; UPDATE/DELETE are revoked and trigger-blocked
 *   erp_policy_settings  amount threshold + MFA requirement per tenant
 *
 * Writes go through PostgREST with the service role (same posture as
 * routes/backoffice-access.ts / role-admin.ts); the browser never touches
 * these tables. A memory implementation backs the route tests.
 */
import type { CommandTier } from '../../constants/backoffice-commands';
import type { CommandChannel, TenantPolicy } from './command-policy';

export type CommandStatus = 'executed' | 'failed' | 'awaiting_approval' | 'rejected';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface CommandRow {
  id: string;
  tenant_id: string;
  requester_id: string;
  channel: CommandChannel;
  type: string;
  action: string;
  tier: CommandTier;
  status: CommandStatus;
  payload: Record<string, unknown>;
  resolved_payload: Record<string, unknown> | null;
  idempotency_key: string;
  request_hash: string;
  reason: string | null;
  approval_id: string | null;
  receipt: Record<string, unknown> | null;
  escalations: string[];
  created_at: string;
  updated_at: string;
  executed_at: string | null;
}

export interface ApprovalRow {
  id: string;
  command_id: string;
  tenant_id: string;
  requester_id: string;
  approve_capability: string;
  status: ApprovalStatus;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_role: string | null;
  channel: string | null;
  event: string;
  command_id: string | null;
  approval_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface PolicyRow extends TenantPolicy {
  tenant_id: string;
  updated_by: string | null;
  updated_at: string;
}

export type NewCommand = Omit<CommandRow, 'created_at' | 'updated_at'>;
export type NewApproval = Omit<ApprovalRow, 'created_at'>;
export type NewAudit = Omit<AuditRow, 'id' | 'created_at'>;

export interface CommandStore {
  findByIdempotency(tenantId: string, key: string): Promise<CommandRow | null>;
  insertCommand(row: NewCommand): Promise<CommandRow>;
  updateCommand(id: string, patch: Partial<CommandRow>): Promise<CommandRow>;
  getCommand(tenantId: string, id: string): Promise<CommandRow | null>;
  /** VTID-03887 — batch read for the approvals list (the approver must see WHAT they approve) */
  getCommandsByIds(tenantId: string, ids: string[]): Promise<CommandRow[]>;
  listCommands(tenantId: string, opts: { status?: CommandStatus; limit: number }): Promise<CommandRow[]>;
  insertApproval(row: NewApproval): Promise<ApprovalRow>;
  getApproval(tenantId: string, id: string): Promise<ApprovalRow | null>;
  updateApproval(id: string, patch: Partial<ApprovalRow>): Promise<ApprovalRow>;
  listApprovals(tenantId: string, opts: { status?: ApprovalStatus; limit: number }): Promise<ApprovalRow[]>;
  appendAudit(row: NewAudit): Promise<void>;
  listAudit(tenantId: string, opts: { limit: number; command_id?: string }): Promise<AuditRow[]>;
  getPolicy(tenantId: string): Promise<PolicyRow | null>;
  upsertPolicy(row: Omit<PolicyRow, 'updated_at'>): Promise<PolicyRow>;
  /** user ids holding an explicit grant of `capability` in the tenant */
  explicitHolders(tenantId: string, capability: string): Promise<string[]>;
  /** user ids whose membership role in the tenant is `admin` (role defaults) */
  tenantAdmins(tenantId: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// PostgREST implementation
// ---------------------------------------------------------------------------

function creds(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SERVICE_CONFIG');
  return { url, key };
}

async function rest<T>(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<T> {
  const { url, key } = creds();
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (init.prefer) headers.Prefer = init.prefer;
  const response = await fetch(`${url}/rest/v1/${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`POSTGREST_${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const enc = encodeURIComponent;

export class PostgrestCommandStore implements CommandStore {
  async findByIdempotency(tenantId: string, key: string) {
    const rows = await rest<CommandRow[]>(`erp_commands?tenant_id=eq.${enc(tenantId)}&idempotency_key=eq.${enc(key)}&limit=1`);
    return rows[0] ?? null;
  }
  async insertCommand(row: NewCommand) {
    const rows = await rest<CommandRow[]>('erp_commands', { method: 'POST', body: row, prefer: 'return=representation' });
    return rows[0];
  }
  async updateCommand(id: string, patch: Partial<CommandRow>) {
    const rows = await rest<CommandRow[]>(`erp_commands?id=eq.${enc(id)}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() }, prefer: 'return=representation' });
    return rows[0];
  }
  async getCommand(tenantId: string, id: string) {
    const rows = await rest<CommandRow[]>(`erp_commands?tenant_id=eq.${enc(tenantId)}&id=eq.${enc(id)}&limit=1`);
    return rows[0] ?? null;
  }
  async getCommandsByIds(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids.filter((x) => typeof x === 'string' && x.length > 0))];
    if (unique.length === 0) return [];
    // PostgREST `in.(...)`: each id is a UUID (never user text) but is still encoded per value.
    return rest<CommandRow[]>(`erp_commands?tenant_id=eq.${enc(tenantId)}&id=in.(${unique.map(enc).join(',')})`);
  }
  async listCommands(tenantId: string, opts: { status?: CommandStatus; limit: number }) {
    let q = `erp_commands?tenant_id=eq.${enc(tenantId)}&order=created_at.desc&limit=${opts.limit}`;
    if (opts.status) q += `&status=eq.${enc(opts.status)}`;
    return rest<CommandRow[]>(q);
  }
  async insertApproval(row: NewApproval) {
    const rows = await rest<ApprovalRow[]>('erp_approvals', { method: 'POST', body: row, prefer: 'return=representation' });
    return rows[0];
  }
  async getApproval(tenantId: string, id: string) {
    const rows = await rest<ApprovalRow[]>(`erp_approvals?tenant_id=eq.${enc(tenantId)}&id=eq.${enc(id)}&limit=1`);
    return rows[0] ?? null;
  }
  async updateApproval(id: string, patch: Partial<ApprovalRow>) {
    const rows = await rest<ApprovalRow[]>(`erp_approvals?id=eq.${enc(id)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
    return rows[0];
  }
  async listApprovals(tenantId: string, opts: { status?: ApprovalStatus; limit: number }) {
    let q = `erp_approvals?tenant_id=eq.${enc(tenantId)}&order=created_at.desc&limit=${opts.limit}`;
    if (opts.status) q += `&status=eq.${enc(opts.status)}`;
    return rest<ApprovalRow[]>(q);
  }
  async appendAudit(row: NewAudit) {
    await rest<unknown>('erp_audit_log', { method: 'POST', body: row, prefer: 'return=minimal' });
  }
  async listAudit(tenantId: string, opts: { limit: number; command_id?: string }) {
    let q = `erp_audit_log?tenant_id=eq.${enc(tenantId)}&order=created_at.desc&limit=${opts.limit}`;
    if (opts.command_id) q += `&command_id=eq.${enc(opts.command_id)}`;
    return rest<AuditRow[]>(q);
  }
  async getPolicy(tenantId: string) {
    const rows = await rest<PolicyRow[]>(`erp_policy_settings?tenant_id=eq.${enc(tenantId)}&limit=1`);
    return rows[0] ?? null;
  }
  async upsertPolicy(row: Omit<PolicyRow, 'updated_at'>) {
    const rows = await rest<PolicyRow[]>('erp_policy_settings?on_conflict=tenant_id', { method: 'POST', body: { ...row, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=representation' });
    return rows[0];
  }
  async explicitHolders(tenantId: string, capability: string) {
    const rows = await rest<Array<{ user_id: string }>>(`erp_capability_grants?tenant_id=eq.${enc(tenantId)}&capability=eq.${enc(capability)}&select=user_id`);
    return rows.map((r) => r.user_id);
  }
  async tenantAdmins(tenantId: string) {
    const rows = await rest<Array<{ user_id: string }>>(`memberships?tenant_id=eq.${enc(tenantId)}&role=eq.admin&select=user_id`);
    return rows.map((r) => r.user_id);
  }
}

// ---------------------------------------------------------------------------
// Memory implementation (tests)
// ---------------------------------------------------------------------------

export class MemoryCommandStore implements CommandStore {
  commands: CommandRow[] = [];
  approvals: ApprovalRow[] = [];
  audit: AuditRow[] = [];
  policies: PolicyRow[] = [];
  grants: Array<{ tenant_id: string; user_id: string; capability: string }> = [];
  admins: Array<{ tenant_id: string; user_id: string }> = [];
  private seq = 0;
  private now() { return new Date().toISOString(); }
  private nextId(prefix: string) { this.seq += 1; return `${prefix}-${String(this.seq).padStart(4, '0')}`; }

  async findByIdempotency(t: string, k: string) { return this.commands.find((c) => c.tenant_id === t && c.idempotency_key === k) ?? null; }
  async insertCommand(row: NewCommand) { const r: CommandRow = { ...row, created_at: this.now(), updated_at: this.now() }; this.commands.push(r); return r; }
  async updateCommand(id: string, patch: Partial<CommandRow>) { const r = this.commands.find((c) => c.id === id)!; Object.assign(r, patch, { updated_at: this.now() }); return r; }
  async getCommand(t: string, id: string) { return this.commands.find((c) => c.tenant_id === t && c.id === id) ?? null; }
  async getCommandsByIds(t: string, ids: string[]) { const want = new Set(ids); return this.commands.filter((c) => c.tenant_id === t && want.has(c.id)); }
  async listCommands(t: string, o: { status?: CommandStatus; limit: number }) { return this.commands.filter((c) => c.tenant_id === t && (!o.status || c.status === o.status)).slice(-o.limit).reverse(); }
  async insertApproval(row: NewApproval) { const r: ApprovalRow = { ...row, created_at: this.now() }; this.approvals.push(r); return r; }
  async getApproval(t: string, id: string) { return this.approvals.find((a) => a.tenant_id === t && a.id === id) ?? null; }
  async updateApproval(id: string, patch: Partial<ApprovalRow>) { const r = this.approvals.find((a) => a.id === id)!; Object.assign(r, patch); return r; }
  async listApprovals(t: string, o: { status?: ApprovalStatus; limit: number }) { return this.approvals.filter((a) => a.tenant_id === t && (!o.status || a.status === o.status)).slice(-o.limit).reverse(); }
  async appendAudit(row: NewAudit) { this.audit.push({ ...row, id: this.nextId('aud'), created_at: this.now() }); }
  async listAudit(t: string, o: { limit: number; command_id?: string }) { return this.audit.filter((a) => a.tenant_id === t && (!o.command_id || a.command_id === o.command_id)).slice(-o.limit).reverse(); }
  async getPolicy(t: string) { return this.policies.find((p) => p.tenant_id === t) ?? null; }
  async upsertPolicy(row: Omit<PolicyRow, 'updated_at'>) { const r: PolicyRow = { ...row, updated_at: this.now() }; this.policies = this.policies.filter((p) => p.tenant_id !== row.tenant_id).concat(r); return r; }
  async explicitHolders(t: string, cap: string) { return this.grants.filter((g) => g.tenant_id === t && g.capability === cap).map((g) => g.user_id); }
  async tenantAdmins(t: string) { return this.admins.filter((a) => a.tenant_id === t).map((a) => a.user_id); }
}

let override: CommandStore | null = null;
export function getCommandStore(): CommandStore { return override ?? new PostgrestCommandStore(); }
export function __setCommandStoreForTests(store: CommandStore | null): void { override = store; }
