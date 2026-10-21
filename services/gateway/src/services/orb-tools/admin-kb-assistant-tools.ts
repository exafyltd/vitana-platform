/**
 * Admin voice tools — Knowledge Base Admin (B8) + Assistant & Voice Config
 * (B9), Wave 4 of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * B8 is a thin dispatch layer over routes/tenant-admin/knowledge.ts
 * (mounted at /api/v1/admin/tenants/:tenantId/kb, requireTenantAdmin) plus
 * routes/admin-system-kb.ts (mounted at /api/v1/admin/system-kb,
 * requireExafyAdmin) for the system-scope edit tool.
 *
 * B9 covers routes/tenant-admin/assistant-config.ts (surface personality
 * config), routes/tenant-admin/assistant-speeches.ts (canned speeches), and
 * routes/awareness-config.ts (the global awareness signal registry — note
 * this one is NOT tenant-scoped; it's a platform-wide registry gated by
 * requireAdminAuth).
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

// ---------------------------------------------------------------------------
// B8.1 admin_kb_search — GET .../kb/search
// ---------------------------------------------------------------------------

export const admin_kb_search: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const q = String(args.query ?? '').trim();
  if (!q) return { ok: false, error: 'admin_kb_search requires query.' };
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/kb/search?q=${encodeURIComponent(q)}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_kb_search failed (${status}): ${String(body.error ?? 'unknown')}` };
  const results = (Array.isArray(body.results) ? body.results : []) as Array<Record<string, unknown>>;
  if (results.length === 0) return { ok: true, result: { results: [] }, text: `No KB docs matched "${q}".` };
  return { ok: true, result: { results }, text: `${results.length} matches for "${q}".` };
};

// ---------------------------------------------------------------------------
// B8.2 admin_kb_list_docs — GET .../kb/documents
// ---------------------------------------------------------------------------

export const admin_kb_list_docs: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const params = new URLSearchParams();
  if (typeof args.source === 'string') params.set('source', args.source);
  if (typeof args.status === 'string') params.set('status', args.status);
  if (typeof args.q === 'string') params.set('q', args.q);
  const qs = params.toString();
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/kb/documents${qs ? `?${qs}` : ''}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_kb_list_docs failed (${status}): ${String(body.error ?? 'unknown')}` };
  const documents = (Array.isArray(body.documents) ? body.documents : []) as Array<Record<string, unknown>>;
  if (documents.length === 0) return { ok: true, result: { documents: [] }, text: 'No KB documents found.' };
  return { ok: true, result: { documents }, text: `${documents.length} KB documents.` };
};

// ---------------------------------------------------------------------------
// B8.3 admin_kb_create_doc — POST .../kb/documents
// ---------------------------------------------------------------------------

export const admin_kb_create_doc: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const title = String(args.title ?? '').trim();
  if (!title) return { ok: false, error: 'admin_kb_create_doc requires title.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, title },
      text: `About to create KB doc "${title}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/kb/documents`,
    {
      method: 'POST',
      headers: authHeaders(id),
      body: {
        title,
        body: typeof args.body === 'string' ? args.body : undefined,
        source: typeof args.source === 'string' ? args.source : undefined,
        topics: Array.isArray(args.topics) ? args.topics : undefined,
      },
    },
  );
  if (!ok) return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the doc: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { created: true, detail: body }, text: `KB doc "${title}" created.` };
};

// ---------------------------------------------------------------------------
// B8.4 admin_kb_update_doc — PUT .../kb/documents/:id
// ---------------------------------------------------------------------------

export const admin_kb_update_doc: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const docId = String(args.document_id ?? '').trim();
  if (!docId) return { ok: false, error: 'admin_kb_update_doc requires document_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, document_id: docId },
      text: `About to update KB doc ${docId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/kb/documents/${encodeURIComponent(docId)}`,
    {
      method: 'PUT',
      headers: authHeaders(id),
      body: {
        title: typeof args.title === 'string' ? args.title : undefined,
        body: typeof args.body === 'string' ? args.body : undefined,
        topics: Array.isArray(args.topics) ? args.topics : undefined,
        status: typeof args.status === 'string' ? args.status : undefined,
      },
    },
  );
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the doc: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `KB doc ${docId} updated.` };
};

// ---------------------------------------------------------------------------
// B8.5 admin_kb_delete_doc — DELETE .../kb/documents/:id
// ---------------------------------------------------------------------------

export const admin_kb_delete_doc: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const docId = String(args.document_id ?? '').trim();
  if (!docId) return { ok: false, error: 'admin_kb_delete_doc requires document_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, document_id: docId },
      text: `About to permanently delete KB doc ${docId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/kb/documents/${encodeURIComponent(docId)}`,
    { method: 'DELETE', headers: authHeaders(id) },
  );
  if (!ok) return { ok: true, result: { deleted: false, status, detail: body }, text: `Could not delete the doc: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { deleted: true }, text: `KB doc ${docId} deleted.` };
};

// ---------------------------------------------------------------------------
// B8.6 admin_kb_reindex — POST .../kb/documents/:id/reindex
// ---------------------------------------------------------------------------

export const admin_kb_reindex: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const docId = String(args.document_id ?? '').trim();
  if (!docId) return { ok: false, error: 'admin_kb_reindex requires document_id.' };
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/kb/documents/${encodeURIComponent(docId)}/reindex`,
    { method: 'POST', headers: authHeaders(id) },
  );
  if (!ok) return { ok: true, result: { queued: false, status, detail: body }, text: `Could not queue re-indexing: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { queued: true }, text: `Re-indexing queued for doc ${docId}.` };
};

// ---------------------------------------------------------------------------
// B8.7 admin_kb_baseline_optout — POST .../kb/baseline/:documentId/optout
// ---------------------------------------------------------------------------

export const admin_kb_baseline_optout: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const docId = String(args.document_id ?? '').trim();
  if (!docId) return { ok: false, error: 'admin_kb_baseline_optout requires document_id.' };
  const optIn = args.opt_in === true;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, document_id: docId, opt_in: optIn },
      text: `About to ${optIn ? 'opt back in to' : 'opt out of'} baseline doc ${docId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/kb/baseline/${encodeURIComponent(docId)}/optout`,
    { method: optIn ? 'DELETE' : 'POST', headers: authHeaders(id) },
  );
  if (!ok) return { ok: true, result: { changed: false, status, detail: body }, text: `Could not change baseline opt-out: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { changed: true }, text: `Baseline doc ${docId} ${optIn ? 'opted back in' : 'opted out'}.` };
};

// ---------------------------------------------------------------------------
// B8.8 admin_system_kb_update — PUT /api/v1/admin/system-kb/docs/:id
// (exafy_admin only, per the route's own gate)
// ---------------------------------------------------------------------------

export const admin_system_kb_update: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'admin_system_kb_update requires an exafy_admin session (operator-only).' };
  }
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const docId = String(args.document_id ?? '').trim();
  if (!docId) return { ok: false, error: 'admin_system_kb_update requires document_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, document_id: docId },
      text: `About to edit system KB doc ${docId} — this changes grounding for every tenant. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/system-kb/docs/${encodeURIComponent(docId)}`, {
    method: 'PUT',
    headers: authHeaders(id),
    body: {
      title: typeof args.title === 'string' ? args.title : undefined,
      content: typeof args.content === 'string' ? args.content : undefined,
      tags: Array.isArray(args.tags) ? args.tags : undefined,
    },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the system doc: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `System KB doc ${docId} updated.` };
};

// ---------------------------------------------------------------------------
// B9.1 admin_get_assistant_config — GET .../assistant/:surfaceKey
// ---------------------------------------------------------------------------

export const admin_get_assistant_config: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const surfaceKey = String(args.surface_key ?? '').trim();
  if (!surfaceKey) return { ok: false, error: 'admin_get_assistant_config requires surface_key.' };
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/assistant/${encodeURIComponent(surfaceKey)}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_get_assistant_config failed (${status}): ${String(body.error ?? 'unknown')}` };
  return {
    ok: true,
    result: body,
    text: `Surface "${surfaceKey}": ${body.has_tenant_override ? 'has a tenant override' : 'using global defaults'}.`,
  };
};

// ---------------------------------------------------------------------------
// B9.2 admin_set_assistant_config — PUT .../assistant/:surfaceKey
// ---------------------------------------------------------------------------

export const admin_set_assistant_config: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const surfaceKey = String(args.surface_key ?? '').trim();
  if (!surfaceKey) return { ok: false, error: 'admin_set_assistant_config requires surface_key.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, surface_key: surfaceKey },
      text: `About to update the assistant config override for "${surfaceKey}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/assistant/${encodeURIComponent(surfaceKey)}`,
    {
      method: 'PUT',
      headers: authHeaders(id),
      body: {
        system_prompt_override: typeof args.system_prompt_override === 'string' ? args.system_prompt_override : undefined,
        voice_config_override: typeof args.voice_config_override === 'object' && args.voice_config_override ? args.voice_config_override : undefined,
        extra_config: typeof args.extra_config === 'object' && args.extra_config ? args.extra_config : undefined,
      },
    },
  );
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the config: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Assistant config for "${surfaceKey}" updated.` };
};

// ---------------------------------------------------------------------------
// B9.3 admin_list_assistant_speeches — GET .../assistant/speeches
// ---------------------------------------------------------------------------

export const admin_list_assistant_speeches: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/assistant/speeches`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_list_assistant_speeches failed (${status}): ${String(body.error ?? 'unknown')}` };
  const speeches = (Array.isArray(body.speeches) ? body.speeches : []) as Array<Record<string, unknown>>;
  if (speeches.length === 0) return { ok: true, result: { speeches: [] }, text: 'No canned speeches registered.' };
  return { ok: true, result: { speeches }, text: `${speeches.length} canned speeches.` };
};

// ---------------------------------------------------------------------------
// B9.4 admin_set_assistant_speech — PUT .../assistant/speeches/:speechKey
// ---------------------------------------------------------------------------

export const admin_set_assistant_speech: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const speechKey = String(args.speech_key ?? '').trim();
  const text = String(args.text ?? '').trim();
  if (!speechKey || !text) return { ok: false, error: 'admin_set_assistant_speech requires speech_key and text.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, speech_key: speechKey },
      text: `About to set speech "${speechKey}" to: "${text}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/assistant/speeches/${encodeURIComponent(speechKey)}`,
    { method: 'PUT', headers: authHeaders(id), body: { text } },
  );
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the speech: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Speech "${speechKey}" updated.` };
};

// ---------------------------------------------------------------------------
// B9.5 admin_get_awareness_config — GET /api/v1/awareness/config
// (platform-wide registry, requireAdminAuth — not tenant-scoped)
// ---------------------------------------------------------------------------

export const admin_get_awareness_config: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/awareness/config', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_get_awareness_config failed (${status}): ${String(body.error ?? 'unknown')}` };
  const resolved = (body.resolved ?? {}) as Record<string, unknown>;
  const keys = Object.keys(resolved);
  return { ok: true, result: body, text: `${keys.length} awareness signals configured.` };
};

// ---------------------------------------------------------------------------
// B9.6 admin_set_awareness_config — POST /api/v1/awareness/config
// ---------------------------------------------------------------------------

export const admin_set_awareness_config: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const key = String(args.key ?? '').trim();
  if (!key || typeof args.enabled !== 'boolean') {
    return { ok: false, error: 'admin_set_awareness_config requires key and enabled (boolean).' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, enabled: args.enabled },
      text: `About to ${args.enabled ? 'enable' : 'disable'} awareness signal "${key}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/awareness/config', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      key,
      enabled: args.enabled,
      params: typeof args.params === 'object' && args.params ? args.params : undefined,
    },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the signal: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Awareness signal "${key}" ${args.enabled ? 'enabled' : 'disabled'}.` };
};

// ---------------------------------------------------------------------------
// B9.7 admin_bulk_set_awareness — POST /api/v1/awareness/config/bulk
// ---------------------------------------------------------------------------

export const admin_bulk_set_awareness: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const changes = Array.isArray(args.changes) ? args.changes : [];
  if (changes.length === 0) return { ok: false, error: 'admin_bulk_set_awareness requires a non-empty changes array of {key, enabled, params?}.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, count: changes.length },
      text: `About to bulk-update ${changes.length} awareness signals. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/awareness/config/bulk', {
    method: 'POST',
    headers: authHeaders(id),
    body: { changes },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Bulk update failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  const succeeded = (Array.isArray(body.succeeded) ? body.succeeded : []) as unknown[];
  const failures = (Array.isArray(body.failures) ? body.failures : []) as unknown[];
  return {
    ok: true,
    result: body,
    text: `${succeeded.length} updated${failures.length ? `, ${failures.length} failed` : ''}.`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_KB_ASSISTANT_TOOL_HANDLERS: Record<string, Handler> = {
  admin_kb_search,
  admin_kb_list_docs,
  admin_kb_create_doc,
  admin_kb_update_doc,
  admin_kb_delete_doc,
  admin_kb_reindex,
  admin_kb_baseline_optout,
  admin_system_kb_update,
  admin_get_assistant_config,
  admin_set_assistant_config,
  admin_list_assistant_speeches,
  admin_set_assistant_speech,
  admin_get_awareness_config,
  admin_set_awareness_config,
  admin_bulk_set_awareness,
};

export const ADMIN_KB_ASSISTANT_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_kb_search', description: 'Search the tenant knowledge base.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Required.' } }, required: ['query'] } },
  { name: 'admin_kb_list_docs', description: 'List KB documents (tenant + baseline).', parameters: { type: 'object', properties: { source: { type: 'string', description: 'tenant or baseline.' }, status: { type: 'string' }, q: { type: 'string' } } } },
  {
    name: 'admin_kb_create_doc',
    description: 'Create a new tenant KB document. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { title: { type: 'string', description: 'Required.' }, body: { type: 'string' }, source: { type: 'string' }, topics: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' } }, required: ['title'] },
  },
  {
    name: 'admin_kb_update_doc',
    description: 'Update a tenant KB document. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { document_id: { type: 'string', description: 'Required.' }, title: { type: 'string' }, body: { type: 'string' }, topics: { type: 'array', items: { type: 'string' } }, status: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['document_id'] },
  },
  {
    name: 'admin_kb_delete_doc',
    description: 'Delete a tenant KB document. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { document_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['document_id'] },
  },
  { name: 'admin_kb_reindex', description: 'Queue re-indexing of a KB document.', parameters: { type: 'object', properties: { document_id: { type: 'string', description: 'Required.' } }, required: ['document_id'] } },
  {
    name: 'admin_kb_baseline_optout',
    description: 'Opt this tenant out of (or back into) a baseline KB doc.',
    parameters: { type: 'object', properties: { document_id: { type: 'string', description: 'Required.' }, opt_in: { type: 'boolean', description: 'true to opt back in, false/omit to opt out.' }, confirm: { type: 'boolean' } }, required: ['document_id'] },
  },
  {
    name: 'admin_system_kb_update',
    description: 'Edit a system-wide (vitana_system) KB doc — exafy_admin only, affects every tenant. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { document_id: { type: 'string', description: 'Required.' }, title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' } }, required: ['document_id'] },
  },
  { name: 'admin_get_assistant_config', description: 'Assistant personality config for one surface (global + tenant override).', parameters: { type: 'object', properties: { surface_key: { type: 'string', description: 'Required.' } }, required: ['surface_key'] } },
  {
    name: 'admin_set_assistant_config',
    description: 'Set a tenant override for an assistant surface config. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { surface_key: { type: 'string', description: 'Required.' }, system_prompt_override: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['surface_key'] },
  },
  { name: 'admin_list_assistant_speeches', description: 'List canned assistant speeches with effective text.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_set_assistant_speech',
    description: 'Set a tenant override for a canned speech. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { speech_key: { type: 'string', description: 'Required.' }, text: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['speech_key', 'text'] },
  },
  { name: 'admin_get_awareness_config', description: 'Platform-wide awareness signal registry (manifest + overrides + resolved).', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_set_awareness_config',
    description: 'Enable/disable one awareness signal (platform-wide). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' }, enabled: { type: 'boolean', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['key', 'enabled'] },
  },
  {
    name: 'admin_bulk_set_awareness',
    description: 'Bulk update multiple awareness signals at once. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        changes: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, enabled: { type: 'boolean' } } }, description: 'Required. Array of {key, enabled, params?}.' },
        confirm: { type: 'boolean' },
      },
      required: ['changes'],
    },
  },
];
