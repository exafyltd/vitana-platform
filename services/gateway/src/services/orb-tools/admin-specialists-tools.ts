/**
 * Admin voice tools — Specialists / Personas (B10), Wave 6 (final wave) of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/specialists-admin.ts +
 * specialists-connections.ts (mounted at /api/v1/admin/specialists). Those
 * routes only check for a valid Bearer JWT (`ensureAuth`) — there is no
 * server-side role check at all. `adminGate()` here is therefore the only
 * real access control for these tools; treat it as mandatory.
 *
 * admin_approve_specialist_ticket is SKIPPED — there is no
 * specialist/persona lifecycle-ticket table or route anywhere in the
 * codebase. The only "approve a ticket" endpoints operate on the unrelated
 * general feedback pipeline (`feedback_tickets`), not personas. Faking this
 * against the wrong table would misrepresent what gets approved. Stays
 * `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

// ---------------------------------------------------------------------------
// 1. admin_list_specialists — GET /api/v1/admin/specialists
// ---------------------------------------------------------------------------

export const admin_list_specialists: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/specialists', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_specialists failed (${status}): ${String(body.error ?? 'unknown')}` };
  const personas = (Array.isArray(body.personas) ? body.personas : []) as Array<Record<string, unknown>>;
  return { ok: true, result: { personas }, text: `${personas.length} specialist personas.` };
};

// ---------------------------------------------------------------------------
// 2. admin_get_specialist — GET /api/v1/admin/specialists/:key
// ---------------------------------------------------------------------------

export const admin_get_specialist: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  if (!key) return { ok: false, error: 'admin_get_specialist requires key.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/specialists/${encodeURIComponent(key)}`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No specialist persona found with key "${key}".` }
      : { ok: false, error: `admin_get_specialist failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: body, text: `Specialist "${key}" retrieved.` };
};

// ---------------------------------------------------------------------------
// 3. admin_create_specialist — POST /api/v1/admin/specialists
// ---------------------------------------------------------------------------

export const admin_create_specialist: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  const displayName = String(args.display_name ?? '').trim();
  const role = String(args.role ?? '').trim();
  const systemPrompt = String(args.system_prompt ?? '').trim();
  if (!KEY_PATTERN.test(key) || !displayName || !role || !systemPrompt) {
    return { ok: false, error: 'admin_create_specialist requires key (lowercase, starts with a letter), display_name, role, and system_prompt.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, display_name: displayName },
      text: `About to create specialist persona "${key}" ("${displayName}"). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/specialists', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      key,
      display_name: displayName,
      role,
      system_prompt: systemPrompt,
      voice_id: typeof args.voice_id === 'string' ? args.voice_id : undefined,
      handles_kinds: Array.isArray(args.handles_kinds) ? args.handles_kinds : undefined,
      status: typeof args.status === 'string' ? args.status : undefined,
    },
  });
  if (!ok) {
    if (status === 409) return { ok: true, result: { created: false, reason: 'key_taken' }, text: `A specialist with key "${key}" already exists.` };
    return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the specialist: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { created: true, detail: body }, text: `Specialist "${key}" created.` };
};

// ---------------------------------------------------------------------------
// 4. admin_update_specialist — PUT /api/v1/admin/specialists/:key
// ---------------------------------------------------------------------------

export const admin_update_specialist: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  if (!key) return { ok: false, error: 'admin_update_specialist requires key.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key },
      text: `About to update specialist "${key}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/specialists/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: authHeaders(id),
    body: {
      display_name: typeof args.display_name === 'string' ? args.display_name : undefined,
      role: typeof args.role === 'string' ? args.role : undefined,
      system_prompt: typeof args.system_prompt === 'string' ? args.system_prompt : undefined,
      handles_kinds: Array.isArray(args.handles_kinds) ? args.handles_kinds : undefined,
      status: typeof args.status === 'string' ? args.status : undefined,
      change_note: typeof args.change_note === 'string' ? args.change_note : undefined,
    },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update "${key}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Specialist "${key}" updated.` };
};

// ---------------------------------------------------------------------------
// 5. admin_rollback_specialist — POST /api/v1/admin/specialists/:key/rollback/:version
// ---------------------------------------------------------------------------

export const admin_rollback_specialist: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  const version = Number(args.version);
  if (!key || !Number.isInteger(version)) return { ok: false, error: 'admin_rollback_specialist requires key and version (integer).' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, version },
      text: `About to roll back specialist "${key}" to version ${version}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/specialists/${encodeURIComponent(key)}/rollback/${version}`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { rolled_back: false, status, detail: body }, text: `Could not roll back "${key}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { rolled_back: true, detail: body }, text: `Specialist "${key}" rolled back to version ${version}.` };
};

// ---------------------------------------------------------------------------
// 6. admin_set_specialist_tools — PUT /api/v1/admin/specialists/:key/tools
// ---------------------------------------------------------------------------

export const admin_set_specialist_tools: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  const keys = Array.isArray(args.tool_keys) ? args.tool_keys : [];
  if (!key || keys.length === 0) return { ok: false, error: 'admin_set_specialist_tools requires key and a non-empty tool_keys array.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, tool_keys: keys },
      text: `About to bind ${keys.length} tools to specialist "${key}" (replaces existing bindings). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/specialists/${encodeURIComponent(key)}/tools`, {
    method: 'PUT',
    headers: authHeaders(id),
    body: { keys },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not bind tools to "${key}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, bindings: body.bindings }, text: `${keys.length} tools bound to "${key}".` };
};

// ---------------------------------------------------------------------------
// 7. admin_set_specialist_kb — PUT /api/v1/admin/specialists/:key/kb
// ---------------------------------------------------------------------------

export const admin_set_specialist_kb: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  const keys = Array.isArray(args.kb_keys) ? args.kb_keys : [];
  if (!key || keys.length === 0) return { ok: false, error: 'admin_set_specialist_kb requires key and a non-empty kb_keys array.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, kb_keys: keys },
      text: `About to bind ${keys.length} knowledge-base scopes to specialist "${key}" (replaces existing bindings). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/specialists/${encodeURIComponent(key)}/kb`, {
    method: 'PUT',
    headers: authHeaders(id),
    body: { keys },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not bind KB scopes to "${key}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, bindings: body.bindings }, text: `${keys.length} KB scopes bound to "${key}".` };
};

// ---------------------------------------------------------------------------
// 8. admin_set_specialist_status — PATCH /api/v1/admin/specialists/:key/status
// ---------------------------------------------------------------------------

export const admin_set_specialist_status: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  if (!key || typeof args.enabled !== 'boolean') return { ok: false, error: 'admin_set_specialist_status requires key and enabled (boolean).' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, enabled: args.enabled },
      text: `About to ${args.enabled ? 'enable' : 'disable'} specialist "${key}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/specialists/${encodeURIComponent(key)}/status`, {
    method: 'PATCH',
    headers: authHeaders(id),
    body: { enabled: args.enabled },
  });
  if (!ok) {
    if (status === 400 && String(body.error ?? '').includes('VITANA_ALWAYS_ON')) {
      return { ok: true, result: { updated: false, reason: 'vitana_always_on' }, text: `The "vitana" receptionist persona can't be disabled — it's always on.` };
    }
    return { ok: true, result: { updated: false, status, detail: body }, text: `Could not change status for "${key}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  if (body.unchanged) return { ok: true, result: { updated: false, unchanged: true }, text: `"${key}" was already ${args.enabled ? 'enabled' : 'disabled'}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Specialist "${key}" ${args.enabled ? 'enabled' : 'disabled'}.` };
};

// ---------------------------------------------------------------------------
// 9. admin_test_specialist_connection — POST /api/v1/admin/specialists/connections/:id/test
// ---------------------------------------------------------------------------

export const admin_test_specialist_connection: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const connectionId = String(args.connection_id ?? '').trim();
  if (!connectionId) return { ok: false, error: 'admin_test_specialist_connection requires connection_id (look it up via admin_get_specialist — its response includes connections[]).' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/specialists/connections/${encodeURIComponent(connectionId)}/test`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: false, error: `admin_test_specialist_connection failed (${status}): ${String(body.error ?? 'unknown')}` };
  return {
    ok: true,
    result: body,
    text: `${String(body.provider ?? 'connection')}: ${body.healthy ? 'healthy' : 'unhealthy'}${body.note ? ` (${body.note})` : ''}.`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_SPECIALISTS_TOOL_HANDLERS: Record<string, Handler> = {
  admin_list_specialists,
  admin_get_specialist,
  admin_create_specialist,
  admin_update_specialist,
  admin_rollback_specialist,
  admin_set_specialist_tools,
  admin_set_specialist_kb,
  admin_set_specialist_status,
  admin_test_specialist_connection,
};

export const ADMIN_SPECIALISTS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_list_specialists', description: 'ADMIN ONLY. List specialist personas.', parameters: { type: 'object', properties: {} } },
  { name: 'admin_get_specialist', description: 'ADMIN ONLY. One persona + version history.', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' } }, required: ['key'] } },
  {
    name: 'admin_create_specialist',
    description: 'ADMIN ONLY. Create a new specialist persona. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Lowercase, starts with a letter. Required.' },
        display_name: { type: 'string', description: 'Required.' },
        role: { type: 'string', description: 'Required.' },
        system_prompt: { type: 'string', description: 'Required.' },
        voice_id: { type: 'string' },
        handles_kinds: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', description: 'active, draft, or disabled.' },
        confirm: { type: 'boolean' },
      },
      required: ['key', 'display_name', 'role', 'system_prompt'],
    },
  },
  {
    name: 'admin_update_specialist',
    description: 'ADMIN ONLY. Edit a specialist persona (snapshots the prior version). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' }, display_name: { type: 'string' }, role: { type: 'string' }, system_prompt: { type: 'string' }, status: { type: 'string' }, change_note: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['key'] },
  },
  {
    name: 'admin_rollback_specialist',
    description: 'ADMIN ONLY. Roll back a specialist to a prior version. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' }, version: { type: 'number', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['key', 'version'] },
  },
  {
    name: 'admin_set_specialist_tools',
    description: 'ADMIN ONLY. Replace the set of voice tools bound to a specialist. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' }, tool_keys: { type: 'array', items: { type: 'string' }, description: 'Required, replaces existing bindings.' }, confirm: { type: 'boolean' } }, required: ['key', 'tool_keys'] },
  },
  {
    name: 'admin_set_specialist_kb',
    description: 'ADMIN ONLY. Replace the set of knowledge-base scopes bound to a specialist. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' }, kb_keys: { type: 'array', items: { type: 'string' }, description: 'Required, replaces existing bindings.' }, confirm: { type: 'boolean' } }, required: ['key', 'kb_keys'] },
  },
  {
    name: 'admin_set_specialist_status',
    description: 'ADMIN ONLY. Enable or disable a specialist (the "vitana" persona can never be disabled). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' }, enabled: { type: 'boolean', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['key', 'enabled'] },
  },
  {
    name: 'admin_test_specialist_connection',
    description: 'ADMIN ONLY. Test a specialist\'s third-party connection (stub providers only today).',
    parameters: { type: 'object', properties: { connection_id: { type: 'string', description: 'Required.' } }, required: ['connection_id'] },
  },
];
