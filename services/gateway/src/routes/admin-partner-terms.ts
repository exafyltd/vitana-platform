/**
 * VTID-04895 — publishing the partner terms (exafy_admin only, API only:
 * owner decision O-2, 2026-10-05 — no admin screen yet).
 *
 * Mounted at /api/v1/admin/partner-terms.
 *   GET  /            list versions (newest first)
 *   POST /            create a draft { version, content, requires_reacceptance }
 *   PUT  /:id         edit a draft (published versions are immutable — the
 *                     database refuses it too)
 *   POST /:id/publish publish a draft: supersedes the current version in one
 *                     transaction (publish_partner_terms_version)
 *
 * English is binding (owner decision O-3): `content.en.title` and
 * `content.en.body_md` are required; other locales are translations. No terms
 * text lives in code — the owner/legal supplies it through this API.
 * Writes are refused for an AI assistant's delegated OAuth token, as for the
 * supplier's acceptance.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { BINDING_LOCALE, requestDelegation } from '../services/partner-terms';

const router = Router();
router.use(requireAuth, requireExafyAdmin);

const VERSION_FIELDS =
  'id, version, status, requires_reacceptance, binding_locale, content, content_sha256, baseline_version_id, created_by, created_at, updated_at, published_by, published_at';

const MAX_TITLE = 300;
const MAX_BODY = 200_000;

/** Validates `content`: English title + body required; each locale has a title and body. */
export function parseTermsContent(raw: unknown): { ok: true; content: Record<string, { title: string; body_md: string }> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'content must be an object of { <locale>: { title, body_md } }' };
  const content: Record<string, { title: string; body_md: string }> = {};
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z]{2}$/.test(locale)) return { ok: false, error: `content locale "${locale}" must be a two-letter code` };
    const v = (value ?? {}) as Record<string, unknown>;
    const title = typeof v.title === 'string' ? v.title.trim() : '';
    const body = typeof v.body_md === 'string' ? v.body_md.trim() : '';
    if (!title || !body) return { ok: false, error: `content.${locale} needs a title and body_md` };
    if (title.length > MAX_TITLE || body.length > MAX_BODY) return { ok: false, error: `content.${locale} is too long` };
    content[locale] = { title, body_md: body };
  }
  if (!content[BINDING_LOCALE]) return { ok: false, error: 'content.en (the binding English text) is required' };
  return { ok: true, content };
}

const actorOf = (req: Request) => (req as AuthenticatedRequest).identity?.user_id ?? null;

/** Writes come from the admin's own session, never an assistant's delegated token. */
async function requireOwnSession(req: Request, res: Response, next: NextFunction) {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const verdict = await requestDelegation(supabase, (req as AuthenticatedRequest).auth_raw_claims as Record<string, unknown> | undefined);
  if (verdict !== 'direct') return res.status(403).json({ ok: false, error: 'REQUIRES_OWN_SESSION' });
  return next();
}

router.get('/', async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data, error } = await supabase.from('partner_terms_versions').select(VERSION_FIELDS).order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, versions: data ?? [] });
});

router.post('/', requireOwnSession, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const version = typeof req.body?.version === 'string' ? req.body.version.trim() : '';
  if (!version || version.length > 40) return res.status(400).json({ ok: false, error: 'version is required (at most 40 characters)' });
  const parsed = parseTermsContent(req.body?.content);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  const requires = req.body?.requires_reacceptance === undefined ? true : req.body.requires_reacceptance === true;

  const { data, error } = await supabase
    .from('partner_terms_versions')
    .insert({ version, content: parsed.content, requires_reacceptance: requires, binding_locale: BINDING_LOCALE, created_by: actorOf(req) })
    .select(VERSION_FIELDS)
    .single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ ok: false, error: 'VERSION_EXISTS' });
    return res.status(500).json({ ok: false, error: error.message });
  }
  return res.status(201).json({ ok: true, version: data });
});

router.put('/:id', requireOwnSession, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const { data: row, error: readErr } = await supabase.from('partner_terms_versions').select('id, status').eq('id', req.params.id).maybeSingle();
  if (readErr) return res.status(500).json({ ok: false, error: readErr.message });
  if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  if ((row as { status: string }).status !== 'draft') return res.status(409).json({ ok: false, error: 'PARTNER_TERMS_IMMUTABLE' });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (req.body?.content !== undefined) {
    const parsed = parseTermsContent(req.body.content);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
    patch.content = parsed.content;
  }
  if (req.body?.requires_reacceptance !== undefined) patch.requires_reacceptance = req.body.requires_reacceptance === true;
  if (req.body?.version !== undefined) {
    const v = typeof req.body.version === 'string' ? req.body.version.trim() : '';
    if (!v || v.length > 40) return res.status(400).json({ ok: false, error: 'version must be 1–40 characters' });
    patch.version = v;
  }

  const { data, error } = await supabase
    .from('partner_terms_versions')
    .update(patch)
    .eq('id', req.params.id)
    .eq('status', 'draft')
    .select(VERSION_FIELDS)
    .maybeSingle();
  if (error) return res.status(error.code === '23505' ? 409 : 500).json({ ok: false, error: error.code === '23505' ? 'VERSION_EXISTS' : error.message });
  if (!data) return res.status(409).json({ ok: false, error: 'PARTNER_TERMS_IMMUTABLE' });
  return res.json({ ok: true, version: data });
});

router.post('/:id/publish', requireOwnSession, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const actor = actorOf(req);
  const { data, error } = await (supabase as any).rpc('publish_partner_terms_version', { p_id: req.params.id, p_actor: actor });
  if (error) {
    const msg = String(error.message ?? '');
    if (msg.includes('PARTNER_TERMS_NOT_FOUND')) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (msg.includes('PARTNER_TERMS_NOT_DRAFT')) return res.status(409).json({ ok: false, error: 'NOT_A_DRAFT' });
    return res.status(500).json({ ok: false, error: msg });
  }
  const published = data as {
    id: string;
    version: string;
    content_sha256: string;
    requires_reacceptance: boolean;
    baseline_version_id: string;
    superseded_id: string | null;
  };

  await emitOasisEvent({
    vtid: 'VTID-04895',
    type: 'partner_terms.version_published',
    source: 'admin-partner-terms',
    status: 'success',
    message: `Partner terms ${published.version} published${published.requires_reacceptance ? ' (re-acceptance required)' : ' (editorial update)'}.`,
    payload: { ...published },
    actor_id: actor ?? undefined,
  });

  // A material update after an earlier version: every org that accepted
  // before must accept again. Live suppliers stay live (owner decision O-1).
  let affectedOrgs = 0;
  if (published.requires_reacceptance && published.superseded_id) {
    const { data: rows } = await supabase.from('partner_terms_acceptances').select('partner_organization_id');
    affectedOrgs = new Set(((rows ?? []) as Array<{ partner_organization_id: string }>).map((r) => r.partner_organization_id)).size;
    await emitOasisEvent({
      vtid: 'VTID-04895',
      type: 'partner_terms.reacceptance_required',
      source: 'admin-partner-terms',
      status: 'info',
      message: `Partner terms ${published.version} need re-acceptance by ${affectedOrgs} organization(s).`,
      payload: { terms_version_id: published.id, version: published.version, affected_orgs: affectedOrgs },
      actor_id: actor ?? undefined,
    });
  }

  return res.json({ ok: true, published, affected_orgs: affectedOrgs });
});

export default router;
