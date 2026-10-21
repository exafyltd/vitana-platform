/**
 * VTID-05090 — publishing the partner data processing agreement (AVV)
 * (exafy_admin only, API only — the same shape and the same owner decision
 * O-2 as the partner terms: no admin screen).
 *
 * Mounted at /api/v1/admin/partner-dpa.
 *   GET  /            list versions (newest first)
 *   POST /            create a draft { version, content, requires_resign }
 *   PUT  /:id         edit a draft (published versions are immutable — the
 *                     database refuses it too)
 *   POST /:id/publish publish a draft: supersedes the current version in one
 *                     transaction (publish_partner_dpa_version)
 *
 * content = { <BCP-47 code>: { title, body_md, signing_declaration? } }.
 * German is binding and English is required, exactly as for the terms
 * (parseTermsContent). `signing_declaration` is the sentence the signer ticks;
 * it is legal text, supplied per version as data, and part of the German hash.
 *
 * No DPA text lives in code — the owner/legal supplies it through this API
 * after counsel sign-off. Writes are refused for an AI assistant's delegated
 * OAuth token (requireOwnSession).
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { BINDING_LOCALE } from '../services/partner-terms';
import { requireOwnSession } from '../middleware/require-own-session';
import { parseTermsContent } from './admin-partner-terms';

const router = Router();
router.use(requireAuth, requireExafyAdmin);

const VERSION_FIELDS =
  'id, version, status, requires_resign, binding_locale, content, content_sha256, baseline_version_id, created_by, created_at, updated_at, published_by, published_at';

const MAX_DECLARATION = 2_000;

type DpaContent = Record<string, { title: string; body_md: string; signing_declaration?: string }>;

/**
 * Validates `content`: the partner terms rules (exact BCP-47 keys, German and
 * English required, title + body for every locale given) plus an optional
 * `signing_declaration` string per locale.
 */
export function parseDpaContent(raw: unknown): { ok: true; content: DpaContent } | { ok: false; error: string } {
  const base = parseTermsContent(raw);
  if (!base.ok) return base;
  const content: DpaContent = {};
  for (const [locale, text] of Object.entries(base.content)) {
    const decl = ((raw as Record<string, Record<string, unknown>>)[locale] ?? {}).signing_declaration;
    if (decl === undefined || decl === null) {
      content[locale] = text;
      continue;
    }
    if (typeof decl !== 'string') return { ok: false, error: `content.${locale}.signing_declaration must be text` };
    const d = decl.trim();
    if (d.length > MAX_DECLARATION) return { ok: false, error: `content.${locale}.signing_declaration is too long` };
    content[locale] = d ? { ...text, signing_declaration: d } : text;
  }
  return { ok: true, content };
}

const actorOf = (req: Request) => (req as AuthenticatedRequest).identity?.user_id ?? null;

/** Who drafted which agreement text is part of the audit trail, not only who published it. */
const draftEvent = (req: Request, row: { id: string; version: string }, action: 'created' | 'edited') => ({
  vtid: 'VTID-05090',
  type: 'partner_dpa.draft_saved' as const,
  source: 'admin-partner-dpa',
  status: 'info' as const,
  message: `Partner DPA draft ${row.version} ${action}.`,
  payload: { dpa_version_id: row.id, version: row.version, action },
  actor_id: actorOf(req) ?? undefined,
});

router.get('/', async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await supabase.from('partner_dpa_versions').select(VERSION_FIELDS).order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, versions: data ?? [] });
});

router.post('/', requireOwnSession, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const version = typeof req.body?.version === 'string' ? req.body.version.trim() : '';
  if (!version || version.length > 40) return res.status(400).json({ ok: false, error: 'version is required (at most 40 characters)' });
  const parsed = parseDpaContent(req.body?.content);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  const requires = req.body?.requires_resign === undefined ? true : req.body.requires_resign === true;

  const { data, error } = await supabase
    .from('partner_dpa_versions')
    .insert({ version, content: parsed.content, requires_resign: requires, binding_locale: BINDING_LOCALE, created_by: actorOf(req) })
    .select(VERSION_FIELDS)
    .single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ ok: false, error: 'VERSION_EXISTS' });
    return res.status(500).json({ ok: false, error: error.message });
  }
  await emitOasisEvent(draftEvent(req, data as { id: string; version: string }, 'created'));
  return res.status(201).json({ ok: true, version: data });
});

router.put('/:id', requireOwnSession, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data: row, error: readErr } = await supabase.from('partner_dpa_versions').select('id, status').eq('id', req.params.id).maybeSingle();
  if (readErr) return res.status(500).json({ ok: false, error: readErr.message });
  if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if ((row as { status: string }).status !== 'draft') return res.status(409).json({ ok: false, error: 'PARTNER_DPA_IMMUTABLE' });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (req.body?.content !== undefined) {
    const parsed = parseDpaContent(req.body.content);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
    patch.content = parsed.content;
  }
  if (req.body?.requires_resign !== undefined) patch.requires_resign = req.body.requires_resign === true;
  if (req.body?.version !== undefined) {
    const v = typeof req.body.version === 'string' ? req.body.version.trim() : '';
    if (!v || v.length > 40) return res.status(400).json({ ok: false, error: 'version must be 1–40 characters' });
    patch.version = v;
  }

  const { data, error } = await supabase
    .from('partner_dpa_versions')
    .update(patch)
    .eq('id', req.params.id)
    .eq('status', 'draft')
    .select(VERSION_FIELDS)
    .maybeSingle();
  if (error) return res.status(error.code === '23505' ? 409 : 500).json({ ok: false, error: error.code === '23505' ? 'VERSION_EXISTS' : error.message });
  if (!data) return res.status(409).json({ ok: false, error: 'PARTNER_DPA_IMMUTABLE' });
  await emitOasisEvent(draftEvent(req, data as { id: string; version: string }, 'edited'));
  return res.json({ ok: true, version: data });
});

router.post('/:id/publish', requireOwnSession, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const actor = actorOf(req);
  const { data, error } = await (supabase as any).rpc('publish_partner_dpa_version', { p_id: req.params.id, p_actor: actor });
  if (error) {
    const msg = String(error.message ?? '');
    if (msg.includes('PARTNER_DPA_NOT_FOUND')) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (msg.includes('PARTNER_DPA_NOT_DRAFT')) return res.status(409).json({ ok: false, error: 'NOT_A_DRAFT' });
    if (msg.includes('PARTNER_DPA_ENGLISH_MISSING')) return res.status(409).json({ ok: false, error: 'ENGLISH_MISSING' });
    return res.status(500).json({ ok: false, error: msg });
  }
  const published = data as {
    id: string;
    version: string;
    content_sha256: string;
    requires_resign: boolean;
    baseline_version_id: string;
    superseded_id: string | null;
  };

  await emitOasisEvent({
    vtid: 'VTID-05090',
    type: 'partner_dpa.version_published',
    source: 'admin-partner-dpa',
    status: 'success',
    message: `Partner DPA ${published.version} published${published.requires_resign ? ' (re-signing required)' : ' (editorial update)'}.`,
    payload: { ...published },
    actor_id: actor ?? undefined,
  });

  // A material update after an earlier version: every org that signed before
  // must sign again. The step reopens; nothing else changes.
  let affectedOrgs = 0;
  if (published.requires_resign && published.superseded_id) {
    const { data: rows } = await supabase.from('partner_dpa_signatures').select('partner_organization_id');
    affectedOrgs = new Set(((rows ?? []) as Array<{ partner_organization_id: string }>).map((r) => r.partner_organization_id)).size;
    await emitOasisEvent({
      vtid: 'VTID-05090',
      type: 'partner_dpa.resign_required',
      source: 'admin-partner-dpa',
      status: 'info',
      message: `Partner DPA ${published.version} needs re-signing by ${affectedOrgs} organization(s).`,
      payload: { dpa_version_id: published.id, version: published.version, affected_orgs: affectedOrgs },
      actor_id: actor ?? undefined,
    });
  }

  return res.json({ ok: true, published, affected_orgs: affectedOrgs });
});

export default router;
