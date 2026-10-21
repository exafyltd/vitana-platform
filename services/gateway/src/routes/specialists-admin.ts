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
 *
 * VTID-03498 (Aurora migration B1): all database access moved behind
 * `services/specialists/specialists-repository.ts`. This file no longer
 * imports supabase-js or constructs a client. HTTP behaviour is unchanged —
 * the only difference is that a database error now reliably produces a 502
 * instead of sometimes being swallowed into an empty result.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as repo from '../services/specialists/specialists-repository';
import { RepositoryError } from '../services/specialists/specialists-repository';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'VTID-02047-PH5';

// SECURITY (post-audit hardening): every route below mutates or reads
// agent personas / system prompts / tool bindings — Command Hub operator
// surface. Previously gated by a bespoke ensureAuth() that only
// base64-decoded the JWT's `sub` claim with NO signature verification and
// NO role check, so any caller with a forged Bearer token could rewrite
// every persona's system_prompt. requireAdminAuth verifies the JWT
// signature (jose.jwtVerify) and requires app_metadata.exafy_admin=true.
router.use(requireAdminAuth);

function ensureAuth(req: Request, res: Response): string | null {
  return (req as AuthenticatedRequest).identity?.user_id ?? null;
}

/**
 * Translate a RepositoryError into the 502 these routes already returned for
 * database failures. Anything else rethrows to the global error handler.
 */
function handleRepoError(err: unknown, res: Response): void {
  if (err instanceof RepositoryError) {
    res.status(502).json({ ok: false, error: err.message });
    return;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Roster + persona detail
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  try {
    const personas = await repo.listPersonas();
    const [tools, kbs, conns] = await Promise.all([
      repo.listAllToolBindings(),
      repo.listAllKbBindings(),
      repo.listAllConnections(),
    ]);

    const enrich = personas.map(p => ({
      ...p,
      tool_bindings: tools.filter(t => t.persona_id === p.id),
      kb_bindings: kbs.filter(k => k.persona_id === p.id),
      connections: conns.filter(c => c.persona_id === p.id),
    }));

    return res.json({ ok: true, personas: enrich });
  } catch (e) { return handleRepoError(e, res); }
});

router.get('/:key', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  try {
    const persona = await repo.getPersonaByKey(req.params.key);
    if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const [tools, kbs, conns, versions] = await Promise.all([
      repo.listToolBindings(persona.id),
      repo.listKbBindings(persona.id),
      repo.listConnections(persona.id),
      repo.listRecentVersions(persona.id, 20),
    ]);

    return res.json({ ok: true, persona, tool_bindings: tools, kb_bindings: kbs, connections: conns, versions });
  } catch (e) { return handleRepoError(e, res); }
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
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const v = PersonaCreateSchema.safeParse(req.body);
  if (!v.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });
  }

  try {
    // Reject if key already taken (clearer than letting the unique constraint fail).
    const existing = await repo.getPersonaFields(v.data.key, 'id');
    if (existing) {
      return res.status(409).json({ ok: false, error: 'KEY_TAKEN', details: `Persona key '${v.data.key}' already exists.` });
    }

    const { change_note, ...personaFields } = v.data;
    const created = await repo.createPersona({
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
    });

    // Initial version snapshot so versions list isn't empty.
    await repo.insertPersonaVersion({
      persona_id: created.id,
      version: 1,
      snapshot: created,
      change_note: change_note ?? 'Initial creation',
      created_by: userId,
    });

    await repo.writeAudit(userId, created.id, 'persona_create', null, created);

    return res.status(201).json({ ok: true, persona: created });
  } catch (e) { return handleRepoError(e, res); }
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
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const v = ToolRegisterSchema.safeParse(req.body);
  if (!v.success) {
    return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });
  }

  try {
    const existing = await repo.getToolKey(v.data.key);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'KEY_TAKEN' });
    }

    const created = await repo.createTool({
      key: v.data.key,
      display_name: v.data.display_name,
      description: v.data.description ?? null,
      input_schema: v.data.input_schema ?? {},
      blast_radius: v.data.blast_radius,
      enabled: v.data.enabled ?? true,
    });

    await repo.writeAudit(userId, null, 'tool_register', null, created);
    return res.status(201).json({ ok: true, tool: created });
  } catch (e) { return handleRepoError(e, res); }
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
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const v = PersonaUpdateSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });

  try {
    const existing = await repo.getPersonaByKey(req.params.key);
    if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    // 1. Snapshot current version
    await repo.insertPersonaVersion({
      persona_id: existing.id,
      version: existing.version,
      snapshot: existing,
      change_note: v.data.change_note ?? null,
      created_by: userId,
    });

    // 2. Apply update + bump version
    const { change_note, ...patch } = v.data;
    void change_note;
    const updated = await repo.updatePersona(existing.id, {
      ...patch,
      version: existing.version + 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    });

    // 3. Audit
    await repo.writeAudit(userId, existing.id, 'persona_edit', existing, updated);

    return res.json({ ok: true, persona: updated });
  } catch (e) { return handleRepoError(e, res); }
});

// ---------------------------------------------------------------------------
// Versions + rollback
// ---------------------------------------------------------------------------

router.get('/:key/versions', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  try {
    const persona = await repo.getPersonaFields(req.params.key, 'id');
    if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const versions = await repo.listVersions(persona.id);
    return res.json({ ok: true, versions });
  } catch (e) { return handleRepoError(e, res); }
});

router.post('/:key/rollback/:version', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const targetVersion = parseInt(req.params.version, 10);
  if (!Number.isFinite(targetVersion)) return res.status(400).json({ ok: false, error: 'BAD_VERSION' });

  try {
    const persona = await repo.getPersonaByKey(req.params.key);
    if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const snapshot = await repo.getVersionSnapshot(persona.id, targetVersion);
    if (!snapshot) return res.status(404).json({ ok: false, error: 'VERSION_NOT_FOUND' });

    // Snapshot current before rollback
    await repo.insertPersonaVersion({
      persona_id: persona.id,
      version: persona.version,
      snapshot: persona,
      change_note: `Auto-snapshot before rollback to v${targetVersion}`,
      created_by: userId,
    });

    // Apply snapshot fields (skip id/version/timestamps)
    const { id: _id, version: _v, created_at: _c, updated_at: _u, ...rest } = snapshot;
    void _id; void _v; void _c; void _u;
    const restored = await repo.updatePersona(persona.id, {
      ...rest,
      version: persona.version + 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    });

    await repo.writeAudit(userId, persona.id, 'rollback', persona, restored);
    return res.json({ ok: true, persona: restored, rolled_back_to: targetVersion });
  } catch (e) { return handleRepoError(e, res); }
});

// ---------------------------------------------------------------------------
// Tool registry + bindings
// ---------------------------------------------------------------------------

router.get('/tools', async (req: Request, res: Response) => {
  if (!ensureAuth(req, res)) return;
  try {
    const tools = await repo.listTools();
    return res.json({ ok: true, tools });
  } catch (e) { return handleRepoError(e, res); }
});

const KeyArraySchema = z.object({ keys: z.array(z.string()).max(100) });

router.put('/:key/tools', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const v = KeyArraySchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  try {
    const persona = await repo.getPersonaFields(req.params.key, 'id');
    if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const before = await repo.listToolBindings(persona.id);
    await repo.replaceToolBindings(persona.id, v.data.keys, userId);

    await repo.writeAudit(userId, persona.id, 'tool_bind', before, v.data.keys.map(k => ({ tool_key: k, enabled: true })));
    return res.json({ ok: true, bindings: v.data.keys });
  } catch (e) { return handleRepoError(e, res); }
});

router.put('/:key/kb', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const v = KeyArraySchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  try {
    const persona = await repo.getPersonaFields(req.params.key, 'id');
    if (!persona) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const before = await repo.listKbBindings(persona.id);
    await repo.replaceKbBindings(persona.id, v.data.keys);

    await repo.writeAudit(userId, persona.id, 'kb_bind', before, v.data.keys.map(s => ({ kb_scope: s, enabled: true })));
    return res.json({ ok: true, bindings: v.data.keys });
  } catch (e) { return handleRepoError(e, res); }
});

const KeywordsSchema = z.object({ keywords: z.array(z.string().max(200)).max(200) });

router.put('/:key/keywords', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const v = KeywordsSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  try {
    const existing = await repo.getPersonaFields(req.params.key, 'id, handoff_keywords');
    if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    await repo.updatePersona(
      existing.id,
      { handoff_keywords: v.data.keywords, updated_by: userId, updated_at: new Date().toISOString() },
      'id, key, handoff_keywords',
    );

    await repo.writeAudit(userId, existing.id, 'routing_rule_change', { handoff_keywords: existing.handoff_keywords }, { handoff_keywords: v.data.keywords });
    return res.json({ ok: true, keywords: v.data.keywords });
  } catch (e) { return handleRepoError(e, res); }
});

// ---------------------------------------------------------------------------
// Forwarding-rules feature: Vitana-only Gate A phrase lists + per-specialist
// enable/disable toggle + shared user-context preview for the admin sandbox.
// ---------------------------------------------------------------------------

const PhrasesSchema = z.object({ phrases: z.array(z.string().min(1).max(200)).max(500) });

async function updateVitanaPhrases(
  req: Request,
  res: Response,
  column: 'forward_request_phrases' | 'stay_inline_phrases',
  action: string,
) {
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const v = PhrasesSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED', details: v.error.errors });

  try {
    const existing = await repo.getPersonaByKey('vitana');
    if (!existing) return res.status(404).json({ ok: false, error: 'VITANA_NOT_FOUND' });

    // Snapshot current version before mutating.
    await repo.insertPersonaVersion({
      persona_id: existing.id,
      version: existing.version,
      snapshot: existing,
      change_note: `Edit ${column} via admin endpoint`,
      created_by: userId,
    });

    const normalized = v.data.phrases.map(p => p.trim().toLowerCase()).filter(Boolean);
    const updated = await repo.updatePersona(existing.id, {
      [column]: normalized,
      version: existing.version + 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    });

    await repo.writeAudit(userId, existing.id, action, { [column]: existing[column] }, { [column]: normalized });
    return res.json({ ok: true, phrases: normalized, version: updated.version });
  } catch (e) { return handleRepoError(e, res); }
}

router.put('/vitana/forward-phrases', (req, res) =>
  updateVitanaPhrases(req, res, 'forward_request_phrases', 'forward_phrases_change')
);

router.put('/vitana/stay-inline-phrases', (req, res) =>
  updateVitanaPhrases(req, res, 'stay_inline_phrases', 'stay_inline_phrases_change')
);

// PATCH /:key/status — lightweight enable/disable toggle for the card-level
// switch on the Specialists tab. Vitana cannot be disabled — she's the
// always-on life companion.

const StatusSchema = z.object({ enabled: z.boolean() });

router.patch('/:key/status', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).identity!.user_id;
  const key = req.params.key;
  if (key === 'vitana') {
    return res.status(400).json({ ok: false, error: 'VITANA_ALWAYS_ON',
      message: 'Vitana is the always-on life companion and cannot be disabled.' });
  }
  const v = StatusSchema.safeParse(req.body);
  if (!v.success) return res.status(400).json({ ok: false, error: 'VALIDATION_FAILED' });

  try {
    const existing = await repo.getPersonaFields(key, 'id, key, status, version');
    if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const newStatus = v.data.enabled ? 'active' : 'disabled';
    if (existing.status === newStatus) {
      return res.json({ ok: true, key, status: newStatus, unchanged: true });
    }

    const full = await repo.getPersonaById(existing.id);
    await repo.insertPersonaVersion({
      persona_id: existing.id,
      version: existing.version,
      snapshot: full,
      change_note: `Status toggle → ${newStatus}`,
      created_by: userId,
    });

    const updated = await repo.updatePersona(
      existing.id,
      {
        status: newStatus,
        version: existing.version + 1,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      'id, key, status, version',
    );

    await repo.writeAudit(userId, existing.id, 'status_toggle',
      { status: existing.status }, { status: newStatus });
    return res.json({ ok: true, key, status: updated.status, version: updated.version });
  } catch (e) { return handleRepoError(e, res); }
});

// GET /context-preview?user_id=… — admin sandbox view of the shared
// specialist-context payload that every persona gets at swap time.
// Same payload regardless of which persona would receive it.

router.get('/context-preview', async (req: Request, res: Response) => {
  const userId = String(req.query.user_id || '').trim();
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
    return res.status(400).json({ ok: false, error: 'BAD_USER_ID',
      message: 'user_id must be a UUID. Resolve from vitana_id via app_users if needed.' });
  }
  try {
    const context = await repo.buildSpecialistContext(userId);
    return res.json({ ok: true, context });
  } catch (e) { return handleRepoError(e, res); }
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

router.get('/audit', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  const personaKey = req.query.persona_key as string | undefined;

  try {
    let personaId: string | undefined;
    if (personaKey) {
      const p = await repo.getPersonaFields(personaKey, 'id');
      // Unknown persona key → empty result, not an error (preserved behaviour).
      if (!p) return res.json({ ok: true, audit: [] });
      personaId = p.id;
    }
    const audit = await repo.listAuditLog(limit, personaId);
    return res.json({ ok: true, audit });
  } catch (e) { return handleRepoError(e, res); }
});

void VTID;
export default router;
