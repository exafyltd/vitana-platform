/**
 * VTID-03498 (Aurora migration B1) — data-access seam for the specialists /
 * agent-persona domain.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Supabase→Aurora migration (VTID-03494, Option B: full platform
 * replacement) has to move 2,480 `.from()` call sites off PostgREST, which
 * Aurora does not provide. Rewriting those call sites in place, spread across
 * route handlers, would mean touching every route again at cutover.
 *
 * So the data access moves behind a seam first. Today these functions wrap
 * supabase-js and behave identically — this is a no-behaviour-change refactor,
 * shippable against the current stack. At cutover only this file changes.
 *
 * `routes/specialists-admin.ts` was the joint-heaviest file in the codebase
 * (45 Supabase call sites; see scripts/ci/aurora-migration-inventory.cjs).
 *
 * Pattern follows the existing `social-memory/social-memory-repository.ts`
 * rather than inventing a second convention.
 *
 * CONTRACT
 * --------
 *  - Reads return the row(s), or `null` / `[]` when genuinely absent.
 *  - Any *database error* throws `RepositoryError`. Callers translate that to
 *    HTTP; they no longer inspect `{ error }` tuples. This is the one
 *    deliberate behaviour change: previously several call sites destructured
 *    `{ data }` and dropped the error entirely, so a failed read was
 *    indistinguishable from an empty one — the same class of silent failure as
 *    VTID-03480.
 *  - Writes return the written row where the caller needs it.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** Thrown on any database-level failure. Carries the underlying message. */
export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly operation: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/** Personas carry a wide, evolving column set; keep the row type permissive. */
export interface PersonaRow {
  id: string;
  key: string;
  version: number;
  status?: string;
  handoff_keywords?: string[] | null;
  [column: string]: unknown;
}

export interface ToolBindingRow {
  tool_key: string;
  enabled: boolean;
  persona_id?: string;
  bound_at?: string;
}

export interface KbBindingRow {
  kb_scope: string;
  enabled: boolean;
  persona_id?: string;
  bound_at?: string;
}

export interface ConnectionRow {
  id?: string;
  persona_id?: string;
  provider: string;
  status: string;
  last_check_at?: string | null;
  created_at?: string;
}

export interface PersonaVersionRow {
  version: number;
  change_note: string | null;
  created_at: string;
  created_by: string | null;
  snapshot?: unknown;
}

export interface AuditRow {
  id: string;
  actor_user_id: string;
  persona_id: string | null;
  action: string;
  before_state: unknown;
  after_state: unknown;
  ts: string;
}

// ---------------------------------------------------------------------------
// Client. Deliberately the ONLY place in this domain that constructs one — the
// route file previously called createClient() itself, which is exactly the
// coupling this seam removes.
// ---------------------------------------------------------------------------

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Test seam: inject a stub client. */
export function __setClientForTest(c: SupabaseClient | null): void {
  client = c;
}

function fail(operation: string, error: { message?: string } | null): never {
  throw new RepositoryError(error?.message ?? 'unknown database error', operation);
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export async function listPersonas(): Promise<PersonaRow[]> {
  const { data, error } = await db().from('agent_personas').select('*').order('key');
  if (error) fail('listPersonas', error);
  return (data ?? []) as PersonaRow[];
}

export async function getPersonaByKey(key: string): Promise<PersonaRow | null> {
  const { data, error } = await db()
    .from('agent_personas')
    .select('*')
    .eq('key', key)
    .maybeSingle();
  if (error) fail('getPersonaByKey', error);
  return (data as PersonaRow) ?? null;
}

/** Narrow lookup used where only the id (and sometimes a column or two) matter. */
export async function getPersonaFields(
  key: string,
  columns: string,
): Promise<PersonaRow | null> {
  const { data, error } = await db()
    .from('agent_personas')
    .select(columns)
    .eq('key', key)
    .maybeSingle();
  if (error) fail('getPersonaFields', error);
  return (data as unknown as PersonaRow) ?? null;
}

export async function getPersonaById(id: string): Promise<PersonaRow | null> {
  const { data, error } = await db()
    .from('agent_personas')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('getPersonaById', error);
  return (data as PersonaRow) ?? null;
}

export async function createPersona(fields: Record<string, unknown>): Promise<PersonaRow> {
  const { data, error } = await db().from('agent_personas').insert(fields).select('*').single();
  if (error || !data) fail('createPersona', error);
  return data as PersonaRow;
}

export async function updatePersona(
  id: string,
  patch: Record<string, unknown>,
  columns = '*',
): Promise<PersonaRow> {
  const { data, error } = await db()
    .from('agent_personas')
    .update(patch)
    .eq('id', id)
    .select(columns)
    .single();
  if (error || !data) fail('updatePersona', error);
  return data as unknown as PersonaRow;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function insertPersonaVersion(row: {
  persona_id: string;
  version: number;
  snapshot: unknown;
  change_note: string | null;
  created_by: string;
}): Promise<void> {
  const { error } = await db().from('agent_persona_versions').insert(row);
  if (error) fail('insertPersonaVersion', error);
}

export async function listVersions(personaId: string): Promise<PersonaVersionRow[]> {
  const { data, error } = await db()
    .from('agent_persona_versions')
    .select('*')
    .eq('persona_id', personaId)
    .order('version', { ascending: false });
  if (error) fail('listVersions', error);
  return (data ?? []) as PersonaVersionRow[];
}

export async function listRecentVersions(
  personaId: string,
  limit: number,
): Promise<PersonaVersionRow[]> {
  const { data, error } = await db()
    .from('agent_persona_versions')
    .select('version, change_note, created_at, created_by')
    .eq('persona_id', personaId)
    .order('version', { ascending: false })
    .limit(limit);
  if (error) fail('listRecentVersions', error);
  return (data ?? []) as PersonaVersionRow[];
}

export async function getVersionSnapshot(
  personaId: string,
  version: number,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db()
    .from('agent_persona_versions')
    .select('snapshot')
    .eq('persona_id', personaId)
    .eq('version', version)
    .maybeSingle();
  if (error) fail('getVersionSnapshot', error);
  if (!data) return null;
  return (data as { snapshot: Record<string, unknown> }).snapshot ?? null;
}

// ---------------------------------------------------------------------------
// Tools + bindings
// ---------------------------------------------------------------------------

export async function listTools(): Promise<Record<string, unknown>[]> {
  const { data, error } = await db()
    .from('agent_tools')
    .select('*')
    .order('blast_radius')
    .order('key');
  if (error) fail('listTools', error);
  return (data ?? []) as Record<string, unknown>[];
}

export async function getToolKey(key: string): Promise<{ key: string } | null> {
  const { data, error } = await db()
    .from('agent_tools')
    .select('key')
    .eq('key', key)
    .maybeSingle();
  if (error) fail('getToolKey', error);
  return (data as { key: string }) ?? null;
}

export async function createTool(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await db().from('agent_tools').insert(fields).select('*').single();
  if (error || !data) fail('createTool', error);
  return data as Record<string, unknown>;
}

export async function listAllToolBindings(): Promise<ToolBindingRow[]> {
  const { data, error } = await db()
    .from('agent_tool_bindings')
    .select('persona_id, tool_key, enabled');
  if (error) fail('listAllToolBindings', error);
  return (data ?? []) as ToolBindingRow[];
}

export async function listToolBindings(personaId: string): Promise<ToolBindingRow[]> {
  const { data, error } = await db()
    .from('agent_tool_bindings')
    .select('tool_key, enabled, bound_at')
    .eq('persona_id', personaId);
  if (error) fail('listToolBindings', error);
  return (data ?? []) as ToolBindingRow[];
}

/**
 * Replace a persona's tool bindings wholesale.
 *
 * NOTE: delete-then-insert without a transaction, preserving the previous
 * behaviour exactly. PostgREST cannot express a multi-statement transaction,
 * so a failure between the two steps leaves the persona with no bindings. This
 * is a real (pre-existing) hazard, and it is one of the things the Aurora move
 * can fix — a direct SQL connection can wrap both in BEGIN/COMMIT. Flagged
 * here rather than silently carried over.
 */
export async function replaceToolBindings(
  personaId: string,
  toolKeys: string[],
  boundBy: string,
): Promise<void> {
  const { error: delErr } = await db()
    .from('agent_tool_bindings')
    .delete()
    .eq('persona_id', personaId);
  if (delErr) fail('replaceToolBindings.delete', delErr);
  if (toolKeys.length === 0) return;
  const { error: insErr } = await db()
    .from('agent_tool_bindings')
    .insert(toolKeys.map((k) => ({ persona_id: personaId, tool_key: k, enabled: true, bound_by: boundBy })));
  if (insErr) fail('replaceToolBindings.insert', insErr);
}

// ---------------------------------------------------------------------------
// KB bindings
// ---------------------------------------------------------------------------

export async function listAllKbBindings(): Promise<KbBindingRow[]> {
  const { data, error } = await db()
    .from('agent_kb_bindings')
    .select('persona_id, kb_scope, enabled');
  if (error) fail('listAllKbBindings', error);
  return (data ?? []) as KbBindingRow[];
}

export async function listKbBindings(personaId: string): Promise<KbBindingRow[]> {
  const { data, error } = await db()
    .from('agent_kb_bindings')
    .select('kb_scope, enabled, bound_at')
    .eq('persona_id', personaId);
  if (error) fail('listKbBindings', error);
  return (data ?? []) as KbBindingRow[];
}

/** Same non-transactional caveat as replaceToolBindings above. */
export async function replaceKbBindings(personaId: string, scopes: string[]): Promise<void> {
  const { error: delErr } = await db()
    .from('agent_kb_bindings')
    .delete()
    .eq('persona_id', personaId);
  if (delErr) fail('replaceKbBindings.delete', delErr);
  if (scopes.length === 0) return;
  const { error: insErr } = await db()
    .from('agent_kb_bindings')
    .insert(scopes.map((s) => ({ persona_id: personaId, kb_scope: s, enabled: true })));
  if (insErr) fail('replaceKbBindings.insert', insErr);
}

// ---------------------------------------------------------------------------
// Third-party connections
// ---------------------------------------------------------------------------

export async function listAllConnections(): Promise<ConnectionRow[]> {
  const { data, error } = await db()
    .from('agent_third_party_connections')
    .select('persona_id, provider, status');
  if (error) fail('listAllConnections', error);
  return (data ?? []) as ConnectionRow[];
}

export async function listConnections(personaId: string): Promise<ConnectionRow[]> {
  const { data, error } = await db()
    .from('agent_third_party_connections')
    .select('id, provider, status, last_check_at, created_at')
    .eq('persona_id', personaId);
  if (error) fail('listConnections', error);
  return (data ?? []) as ConnectionRow[];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function writeAudit(
  actorUserId: string,
  personaId: string | null,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  // Audit writes stay best-effort: an audit failure must not fail the mutation
  // the operator just performed. Preserves prior behaviour (the old code
  // ignored the result), but now it is a stated decision rather than an
  // accident of destructuring.
  const { error } = await db().from('agent_audit_log').insert({
    actor_user_id: actorUserId,
    persona_id: personaId,
    action,
    before_state: before ?? null,
    after_state: after ?? null,
  });
  if (error) {
    console.warn(`[specialists-repository] audit write failed (${action}): ${error.message}`);
  }
}

export async function listAuditLog(limit: number, personaId?: string): Promise<AuditRow[]> {
  let q = db()
    .from('agent_audit_log')
    .select('id, actor_user_id, persona_id, action, before_state, after_state, ts')
    .order('ts', { ascending: false })
    .limit(limit);
  if (personaId) q = q.eq('persona_id', personaId);
  const { data, error } = await q;
  if (error) fail('listAuditLog', error);
  return (data ?? []) as AuditRow[];
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export async function buildSpecialistContext(userId: string): Promise<unknown> {
  const { data, error } = await db().rpc('build_specialist_context', { p_user_id: userId });
  if (error) fail('buildSpecialistContext', error);
  return data ?? null;
}
