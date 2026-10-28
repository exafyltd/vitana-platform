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
 * German is binding (VTID-04909, owner decision 2026-10-06, replacing O-3):
 * `content.de` and `content.en` (second language) need a title and body;
 * locale keys are the exact BCP-47 codes in SUPPORTED_TERMS_LOCALES
 * (`pt-BR`, `zh-CN` — never `pt`/`zh`). No terms text lives in code — the
 * owner/legal supplies it through this API.
 * Writes are refused for an AI assistant's delegated OAuth token, as for the
 * supplier's acceptance.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { BINDING_LOCALE, REQUIRED_TERMS_LOCALES, SUPPORTED_TERMS_LOCALES, isSupportedTermsLocale } from '../services/partner-terms';
import { requireOwnSession } from '../middleware/require-own-session';

const router = Router();
router.use(requireAuth, requireExafyAdmin);

const VERSION_FIELDS =
  'id, version, status, requires_reacceptance, binding_locale, content, content_sha256, baseline_version_id, created_by, created_at, updated_at, published_by, published_at';

const MAX_TITLE = 300;
const MAX_BODY = 200_000;

/** Locale keys that look like a supported language but are not its exact code. */
const NOT_THE_CODE: Record<string, string> = { pt: 'pt-BR', 'pt-br': 'pt-BR', pt_br: 'pt-BR', zh: 'zh-CN', 'zh-cn': 'zh-CN', zh_cn: 'zh-CN' };

/**
 * Validates `content`: keys are exactly the supported BCP-47 codes; German
 * (binding) and English (second language) need a title and body; every
 * locale given has a title and body.
 */
export function parseTermsContent(raw: unknown): { ok: true; content: Record<string, { title: string; body_md: string }> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'content must be an object of { <locale>: { title, body_md } }' };
  const content: Record<string, { title: string; body_md: string }> = {};
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSupportedTermsLocale(locale)) {
      const hint = NOT_THE_CODE[locale.toLowerCase()] ?? NOT_THE_CODE[locale];
      return {
        ok: false,
        error: hint
          ? `content locale "${locale}" is not a supported code — use "${hint}"`
          : `content locale "${locale}" is not supported (use one of ${SUPPORTED_TERMS_LOCALES.join(', ')})`,
      };
    }
    const v = (value ?? {}) as Record<string, unknown>;
    const title = typeof v.title === 'string' ? v.title.trim() : '';
    const body = typeof v.body_md === 'string' ? v.body_md.trim() : '';
    if (!title || !body) return { ok: false, error: `content.${locale} needs a title and body_md` };
    if (title.length > MAX_TITLE || body.length > MAX_BODY) return { ok: false, error: `content.${locale} is too long` };
    content[locale] = { title, body_md: body };
  }
  for (const req of REQUIRED_TERMS_LOCALES) {
    if (!content[req]) {
      const role = req === BINDING_LOCALE ? 'the binding German text' : 'the English text (second language)';
      return { ok: false, error: `content.${req} (${role}) is required` };
    }
  }
  return { ok: true, content };
}

const actorOf = (req: Request) => (req as AuthenticatedRequest).identity?.user_id ?? null;

// Writes come from the admin's own session, never an assistant's delegated token
// (shared with the supplier review routes since VTID-04933).

/** Who drafted which terms text is part of the audit trail, not only who published it. */
const draftEvent = (req: Request, row: { id: string; version: string }, action: 'created' | 'edited') => ({
  vtid: 'VTID-04895',
  type: 'partner_terms.draft_saved' as const,
  source: 'admin-partner-terms',
  status: 'info' as const,
  message: `Partner terms draft ${row.version} ${action}.`,
  payload: { terms_version_id: row.id, version: row.version, action },
  actor_id: actorOf(req) ?? undefined,
});

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
  await emitOasisEvent(draftEvent(req, data as { id: string; version: string }, 'created'));
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
  await emitOasisEvent(draftEvent(req, data as { id: string; version: string }, 'edited'));
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
