/**
 * VTID-02047 Phase 5: Specialist management endpoints (Command Hub)
 *
 * Mounted at /api/v1/admin/specialists. Powers the Command Hub Persona
 * Editor, Tool Binding Manager, KB Binding Manager, Audit Log, and
 * Routing Rules Editor UIs.
 *
 *   GET  /                                full roster with bindings
 *   GET  /:key                            single persona detail
 *   PUT  /:key                            update persona (creates new
 *                                         agent_persona_versions snapshot
 *                                         atomically; bumps version)
 *   GET  /:key/versions                   version history for diff/rollback
 *   POST /:key/rollback/:version          restore a prior version
 *   GET  /tools                           tool registry
 *   GET  /:key/tools                      bound tools for persona
 *   PUT  /:key/tools                      replace tool bindings (array of keys)
 *   GET  /:key/kb                         bound KB scopes
 *   PUT  /:key/kb                         replace KB scope bindings
 *   GET  /audit                           audit log (filterable)
 *   POST /:key/keywords                   replace handoff_keywords
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const router = Router();
const VTID = 'VTID-02047-PH5';

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!,
    { auth: { persistSession: false, autoRefreshToken: false } });
}

function getBearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

function decodeJwtSub(token: string): string | null {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub ?? null; }
  catch { return null; }
}

function ensureAuth(req: Request, res: Response): string | null {
  const token = getBearerToken(req);
  if (!token) { res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' }); return null; }
  const userId = decodeJwtSub(token);
  if (!userId) { res.status(401).json({ ok: false, error: 'INVALID_TOKEN' }); return null; }
  return userId;
}

async function writeAudit(actorUserId: string, personaId: string | null, action: string, before: unknown, after: unknown) {
  const supabase = getServiceClient();
  await supabase.from('agent_audit_log').insert({
    actor_user_id: actorUserId,
    persona_id: personaId,
    action,
    before_state: before ?? null,
    after_state: after ?? null,
  });
}

// ---------------------------------------------------------------------------
// Roster + persona detail
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data: personas, error } = await supabase
    .from('agent_personas')
    .select('*')
    .order('key');
  if (error) return res.status(502).json({ ok: false, error: error.message });

  // Tool bindings + KB bindings counts per persona
  const { data: tools } = await supabase.from('agent_tool_bindings').select('persona_id, tool_key, enabled');
  const { data: kbs } = await supabase.from('agent_kb_bindings').select('persona_id, kb_scope, enabled');
  const { data: conns } = await supabase.from('agent_third_party_connections').select('persona_id, provider, status');

  const enrich = (personas ?? []).map(p => ({
    ...p,
    tool_bindings: (tools ?? []).filter((t: any) => t.persona_id === p.id),
    kb_bindings: (kbs ?? []).filter((k: any) => k.persona_id === p.id),
    connections: (conns ?? []).filter((c: any) => c.persona_id === p.id),
  }));
  return res.json({ ok: true, personas: enrich });
});

router.get('/:key', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data: persona, error } = await supabase
    .from('agent_personas')
    .select('*')
    .eq('key', req.params.key)
    .maybeSingle();
  if (error || !persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const { data: tools } = await supabase.from('agent_tool_bindings').select('tool_key, enabled, bound_at').eq('persona_id', persona.id);
  const { data: kbs } = await supabase.from('agent_kb_bindings').select('kb_scope, enabled, bound_at').eq('persona_id', persona.id);
  const { data: conns } = await supabase.from('agent_third_party_connections').select('id, provider, status, last_check_at, created_at').eq('persona_id', persona.id);
  const { data: versions } = await supabase.from('agent_persona_versions').select('version, change_note, created_at, created_by').eq('persona_id', persona.id).order('version', { ascending: false }).limit(20);

  return res.json({ ok: true, persona, tool_bindings: tools ?? [], kb_bindings: kbs ?? [], connections: conns ?? [], versions: versions ?? [] });
});

// ---------------------------------------------------------------------------
// POST / — create a new persona from scratch (Command Hub +New specialist wizard)
// ---------------------------------------------------------------------------
// Phase 6 PR 29: Exafy operators build new specialists in Command Hub.
// Inserts into agent_personas + writes initial agent_persona_versions row +
// audits as 'persona_create'. After this completes, the new persona is a
// valid switch_persona target for all tenants by default (each tenant can
// then disable via the tenant overlay).

const PersonaCreateSchema = z.object({
  key: z.string().min(2).max(32).regex(/^[a-z][a-z0-9_]{1,31}$/, 'key must be lowercase, start with a letter, only [a-z0-9_]'),
  display_name: z.string().min(1).max(120),
  role: z.string().min(1).max(500),
  voice_id: z.string().max(200).nullable().optional(),
  voice_sample_url: z.string().url().max(2000).nullable().optional(),
  system_prompt: z.string().min(1).max(20_000),
  intake_schema_ref: z.string().max(120).nullable().optional(),
  handles_kinds: z.array(z.string().max(64)).max(20).optional(),
  handoff_keywords: z.array(z.string().max(200)).max(200).optional(),
  greeting_templates: z.record(z.string()).optional(),
  max_questions: z.number().int().min(1).max(20).optional(),
  max_duration_seconds: z.number().int().min(30).max(1800).optional(),
  status: z.enum(['active','draft','disabled']).optional(),
  change_note: z.string().max(500).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const v = PersonaCreateSchema.safeParse(req.body);
  if (!v.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });
  }
  const supabase = getServiceClient();

  // Reject if key already taken (clearer than letting the unique constraint fail).
  const { data: existing } = await supabase.from('agent_personas').select('id').eq('key', v.data.key).maybeSingle();
  if (existing) {
    return res.status(409).json({ ok: false, error: 'KEY_TAKEN', details: `Persona key '${v.data.key}' already exists.` });
  }

  const { change_note, ...personaFields } = v.data;
  const { data: created, error } = await supabase
    .from('agent_personas')
    .insert({
      ...personaFields,
      handles_kinds: personaFields.handles_kinds ?? [],
      handoff_keywords: personaFields.handoff_keywords ?? [],
      greeting_templates: personaFields.greeting_templates ?? {},
      max_questions: personaFields.max_questions ?? 6,
      max_duration_seconds: personaFields.max_duration_seconds ?? 240,
      status: personaFields.status ?? 'draft',
      version: 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (error || !created) return res.status(502).json({ ok: false, error: error?.message });

  // Initial version snapshot so versions list isn't empty.
  await supabase.from('agent_persona_versions').insert({
    persona_id: created.id,
    version: 1,
    snapshot: created,
    change_note: change_note ?? 'Initial creation',
    created_by: userId,
  });

  // Audit
  await writeAudit(userId, created.id, 'persona_create', null, created);

  return res.status(201).json({ ok: true, persona: created });
});

// ---------------------------------------------------------------------------
// POST /tools — register a new tool in the agent_tools registry
// ---------------------------------------------------------------------------
// Phase 6 PR 30 (compact): operators register a new tool here so any persona
// can be bound to it. Note: this only registers the tool DEFINITION; the
// EXECUTOR (the case in orb-live.ts's executeLiveApiToolInner) still has to
// be shipped in code. Until then, the tool is bindable but no-op when
// invoked. UI banner explains this caveat.

const ToolRegisterSchema = z.object({
  key: z.string().min(2).max(64).regex(/^[a-z][a-z0-9-]{1,63}$/, 'key must be lowercase kebab-case'),
  display_name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  input_schema: z.record(z.unknown()).optional(),
  blast_radius: z.enum(['read', 'write-low', 'write-high']),
  enabled: z.boolean().optional(),
});

router.post('/tools', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const v = ToolRegisterSchema.safeParse(req.body);
  if (!v.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });
  }
  const supabase = getServiceClient();

  const { data: existing } = await supabase.from('agent_tools').select('key').eq('key', v.data.key).maybeSingle();
  if (existing) {
    return res.status(409).json({ ok: false, error: 'KEY_TAKEN' });
  }

  const { data: created, error } = await supabase
    .from('agent_tools')
    .insert({
      key: v.data.key,
      display_name: v.data.display_name,
      description: v.data.description ?? null,
      input_schema: v.data.input_schema ?? {},
      blast_radius: v.data.blast_radius,
      enabled: v.data.enabled ?? true,
    })
    .select('*')
    .single();
  if (error || !created) return res.status(502).json({ ok: false, error: error?.message });

  await writeAudit(userId, null, 'tool_register', null, created);
  return res.status(201).json({ ok: true, tool: created });
});

// ---------------------------------------------------------------------------
// PUT /:key — update persona (with version snapshot)
// ---------------------------------------------------------------------------

const PersonaUpdateSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  role: z.string().min(1).max(500).optional(),
  voice_id: z.string().max(200).nullable().optional(),
  voice_sample_url: z.string().url().max(2000).nullable().optional(),
  system_prompt: z.string().max(20_000).optional(),
  intake_schema_ref: z.string().max(120).nullable().optional(),
  handles_kinds: z.array(z.string()).max(20).optional(),
  handoff_keywords: z.array(z.string()).max(200).optional(),
  max_questions: z.number().int().min(1).max(20).optional(),
  max_duration_seconds: z.number().int().min(30).max(1800).optional(),
  status: z.enum(['active','draft','disabled']).optional(),
  change_note: z.string().max(500).optional(),
});

router.put('/:key', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const v = PersonaUpdateSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });

  const supabase = getServiceClient();
  const { data: existing, error: readErr } = await supabase
    .from('agent_personas')
    .select('*')
    .eq('key', req.params.key)
    .maybeSingle();
  if (readErr || !existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  // 1. Snapshot current version
  await supabase.from('agent_persona_versions').insert({
    persona_id: existing.id,
    version: existing.version,
    snapshot: existing,
    change_note: v.data.change_note ?? null,
    created_by: userId,
  });

  // 2. Apply update + bump version
  const { change_note, ...patch } = v.data;
  const { data: updated, error: upErr } = await supabase
    .from('agent_personas')
    .update({
      ...patch,
      version: existing.version + 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select('*')
    .single();
  if (upErr || !updated) return res.status(502).json({ ok: false, error: upErr?.message });

  // 3. Audit
  await writeAudit(userId, existing.id, 'persona_edit', existing, updated);

  return res.json({ ok: true, persona: updated });
});

// ---------------------------------------------------------------------------
// Versions + rollback
// ---------------------------------------------------------------------------

router.get('/:key/versions', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data: persona } = await supabase.from('agent_personas').select('id').eq('key', req.params.key).maybeSingle();
  if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  const { data, error } = await supabase
    .from('agent_persona_versions')
    .select('*')
    .eq('persona_id', persona.id)
    .order('version', { ascending: false });
  if (error) return res.status(502).json({ ok: false, error: error.message });
  return res.json({ ok: true, versions: data ?? [] });
});

router.post('/:key/rollback/:version', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const targetVersion = parseInt(req.params.version, 10);
  if (!Number.isFinite(targetVersion)) return res.status(400).json({ ok: false, error: 'BAD_VERSION' });

  const supabase = getServiceClient();
  const { data: persona } = await supabase.from('agent_personas').select('*').eq('key', req.params.key).maybeSingle();
  if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const { data: snap } = await supabase
    .from('agent_persona_versions')
    .select('snapshot')
    .eq('persona_id', persona.id)
    .eq('version', targetVersion)
    .maybeSingle();
  if (!snap) return res.status(404).json({ ok: false, error: 'VERSION_NOT_FOUND' });

  // Snapshot current before rollback
  await supabase.from('agent_persona_versions').insert({
    persona_id: persona.id,
    version: persona.version,
    snapshot: persona,
    change_note: `Auto-snapshot before rollback to v${targetVersion}`,
    created_by: userId,
  });

  // Apply snapshot fields (skip id/version/timestamps)
  const s = snap.snapshot as Record<string, unknown>;
  const { id: _id, version: _v, created_at: _c, updated_at: _u, ...rest } = s;
  void _id; void _v; void _c; void _u;
  const { data: restored, error: upErr } = await supabase
    .from('agent_personas')
    .update({ ...rest, version: persona.version + 1, updated_by: userId, updated_at: new Date().toISOString() })
    .eq('id', persona.id)
    .select('*')
    .single();
  if (upErr || !restored) return res.status(502).json({ ok: false, error: upErr?.message });

  await writeAudit(userId, persona.id, 'rollback', persona, restored);
  return res.json({ ok: true, persona: restored, rolled_back_to: targetVersion });
});

// ---------------------------------------------------------------------------
// Tool registry + bindings
// ---------------------------------------------------------------------------

router.get('/tools', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('agent_tools').select('*').order('blast_radius').order('key');
  if (error) return res.status(502).json({ ok: false, error: error.message });
  return res.json({ ok: true, tools: data ?? [] });
});

const KeyArraySchema = z.object({ keys: z.array(z.string()).max(100) });

router.put('/:key/tools', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const v = KeyArraySchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  const supabase = getServiceClient();
  const { data: persona } = await supabase.from('agent_personas').select('id').eq('key', req.params.key).maybeSingle();
  if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const { data: before } = await supabase.from('agent_tool_bindings').select('tool_key, enabled').eq('persona_id', persona.id);

  await supabase.from('agent_tool_bindings').delete().eq('persona_id', persona.id);
  if (v.data.keys.length > 0) {
    await supabase.from('agent_tool_bindings').insert(
      v.data.keys.map(k => ({ persona_id: persona.id, tool_key: k, enabled: true, bound_by: userId }))
    );
  }

  await writeAudit(userId, persona.id, 'tool_bind', before ?? [], v.data.keys.map(k => ({ tool_key: k, enabled: true })));
  return res.json({ ok: true, bindings: v.data.keys });
});

router.put('/:key/kb', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const v = KeyArraySchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  const supabase = getServiceClient();
  const { data: persona } = await supabase.from('agent_personas').select('id').eq('key', req.params.key).maybeSingle();
  if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const { data: before } = await supabase.from('agent_kb_bindings').select('kb_scope, enabled').eq('persona_id', persona.id);

  await supabase.from('agent_kb_bindings').delete().eq('persona_id', persona.id);
  if (v.data.keys.length > 0) {
    await supabase.from('agent_kb_bindings').insert(
      v.data.keys.map(s => ({ persona_id: persona.id, kb_scope: s, enabled: true }))
    );
  }

  await writeAudit(userId, persona.id, 'kb_bind', before ?? [], v.data.keys.map(s => ({ kb_scope: s, enabled: true })));
  return res.json({ ok: true, bindings: v.data.keys });
});

const KeywordsSchema = z.object({ keywords: z.array(z.string().max(200)).max(200) });

router.put('/:key/keywords', async (req: Request, res: Response) => {
  const userId = ensureAuth(req, res); if (!userId) return;
  const v = KeywordsSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });
  const supabase = getServiceClient();
  const { data: existing } = await supabase.from('agent_personas').select('id, handoff_keywords').eq('key', req.params.key).maybeSingle();
  if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const { data: updated, error } = await supabase
    .from('agent_personas')
    .update({ handoff_keywords: v.data.keywords, updated_by: userId, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select('id, key, handoff_keywords')
    .single();
  if (error || !updated) return res.status(502).json({ ok: false, error: error?.message });

  await writeAudit(userId, existing.id, 'routing_rule_change', { handoff_keywords: existing.handoff_keywords }, { handoff_keywords: v.data.keywords });
  return res.json({ ok: true, keywords: v.data.keywords });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

router.get('/audit', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  const personaKey = req.query.persona_key as string | undefined;
  const supabase = getServiceClient();

  let q = supabase
    .from('agent_audit_log')
    .select('id, actor_user_id, persona_id, action, before_state, after_state, ts')
    .order('ts', { ascending: false })
    .limit(limit);

  if (personaKey) {
    const { data: p } = await supabase.from('agent_personas').select('id').eq('key', personaKey).maybeSingle();
    if (p) q = q.eq('persona_id', p.id);
    else return res.json({ ok: true, audit: [] });
  }

  const { data, error } = await q;
  if (error) return res.status(502).json({ ok: false, error: error.message });
  return res.json({ ok: true, audit: data ?? [] });
});

void VTID;
export default router;
