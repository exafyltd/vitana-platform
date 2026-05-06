/**
 * BOOTSTRAP-CMDHUB-I18N-OPS: Localization Operations API for Command Hub.
 *
 * Read-only state + workflow dispatch surface for the i18n closure pipeline.
 * Reads catalog state from vitana-v1 via GitHub Contents API, dispatches the
 * i18n-translate.yml and i18n-audit-llm.yml workflows on user demand, and
 * surfaces recent workflow runs.
 *
 * Mounted at /api/v1/admin/i18n-ops.
 *
 * Auth: exafy_admin only (operational surface, not tenant-scoped).
 *
 * Endpoints:
 *   GET  /locales                 — status of every locale (parsed from
 *                                   LanguageContext.tsx + counted catalog
 *                                   shards + audit verdict files)
 *   POST /translate               — dispatch i18n-translate.yml on vitana-v1
 *   POST /audit                   — dispatch i18n-audit-llm.yml on vitana-v1
 *   GET  /workflow-runs?workflow=…&limit=… — recent runs
 *   POST /promote-ga              — opens PR flipping `status: 'draft'` →
 *                                   `'ga'` for a locale (Phase 4 — stubbed
 *                                   for now to return 501)
 *
 * GitHub auth: process.env.GITHUB_SAFE_MERGE_TOKEN (preferred) or
 * GITHUB_TOKEN (fallback). Same convention used by dev-autopilot-bridge.ts.
 */

import { Router, Response as ExpressResponse, NextFunction } from 'express';
import { AuthenticatedRequest, verifyAndExtractIdentity } from '../middleware/auth-supabase-jwt';

// Disambiguate: Express's Response shadows the global Fetch Response within
// this file. Re-pin the Fetch one for our HTTP-call helpers.
type FetchResponse = globalThis.Response;

const router = Router();
const VTID = 'BOOTSTRAP-CMDHUB-I18N-OPS';

const REPO_OWNER = 'exafyltd';
const REPO_NAME = 'vitana-v1';
const REPO = `${REPO_OWNER}/${REPO_NAME}`;

function getGithubToken(): string {
  return (
    process.env.GITHUB_SAFE_MERGE_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ''
  );
}

async function ghFetch(path: string, init: RequestInit = {}): Promise<FetchResponse> {
  const token = getGithubToken();
  if (!token) throw new Error('No GitHub token configured (GITHUB_SAFE_MERGE_TOKEN/GITHUB_TOKEN)');
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

// --- Auth: exafy_admin only ---------------------------------------------
async function requireExafyAdmin(
  req: AuthenticatedRequest,
  res: ExpressResponse,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return;
  }
  const token = authHeader.slice(7);
  const result = await verifyAndExtractIdentity(token);
  if (!result) {
    res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
    return;
  }
  if (!result.identity.exafy_admin) {
    res.status(403).json({ ok: false, error: 'EXAFY_ADMIN_ONLY' });
    return;
  }
  req.identity = result.identity;
  req.auth_raw_claims = result.claims;
  req.auth_source = result.auth_source;
  next();
}

// --- helpers -------------------------------------------------------------

/** Read a file from vitana-v1 main via GitHub Contents API. */
async function readFile(path: string): Promise<string | null> {
  try {
    const r = await ghFetch(`/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`);
    if (!r.ok) return null;
    const data = (await r.json()) as { content?: string; encoding?: string };
    if (!data.content) return null;
    return Buffer.from(data.content, (data.encoding as BufferEncoding) || 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** List files under a directory in vitana-v1. */
async function listDir(path: string): Promise<Array<{ name: string; size: number; type: string }>> {
  try {
    const r = await ghFetch(`/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`);
    if (!r.ok) return [];
    const data = (await r.json()) as Array<{ name: string; size: number; type: string }>;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Parse `languageOptions` array from src/contexts/LanguageContext.tsx.
 * Returns entries with { value, status }.
 */
function parseLanguageOptions(src: string): Array<{ value: string; status: 'ga' | 'beta' | 'draft' }> {
  const out: Array<{ value: string; status: 'ga' | 'beta' | 'draft' }> = [];
  const rx = /value:\s*["']([a-z]{2}-[A-Z]{2})["']\s*,\s*status:\s*['"](\w+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) {
    const status = m[2] === 'ga' ? 'ga' : m[2] === 'beta' ? 'beta' : 'draft';
    out.push({ value: m[1], status });
  }
  // Fallback for catalogs without status field
  if (out.length === 0) {
    const fallbackRx = /value:\s*["']([a-z]{2}-[A-Z]{2})["']/g;
    while ((m = fallbackRx.exec(src)) !== null) {
      out.push({ value: m[1], status: 'draft' });
    }
  }
  return out;
}

/** Count translation keys in a JSON shard (recursively, excluding _meta). */
function countLeaves(obj: unknown): number {
  if (!obj || typeof obj !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) n += countLeaves(v);
    else if (typeof v === 'string') n++;
  }
  return n;
}

// --- routes --------------------------------------------------------------

/**
 * GET /locales
 *
 * Returns:
 *   {
 *     ok: true,
 *     source_lang: "en",
 *     locales: [
 *       { code, lang_code, status, en_total, locale_total, completeness_pct,
 *         audit_total, audit_ok, audit_flagged, audit_pass_rate_pct,
 *         last_audit_at? },
 *       ...
 *     ]
 *   }
 *
 * Strategy: parses LanguageContext.tsx for declared locales, lists shards
 * under src/i18n/<short>/ for each, counts keys, and reads audit files
 * (*._audit.json) when present. Heavy GitHub API usage — caches 60s.
 */
let LOCALES_CACHE: { at: number; payload: unknown } | null = null;
const LOCALES_TTL_MS = 60_000;

router.get('/locales', requireExafyAdmin, async (req, res) => {
  if (LOCALES_CACHE && Date.now() - LOCALES_CACHE.at < LOCALES_TTL_MS) {
    res.json(LOCALES_CACHE.payload);
    return;
  }
  try {
    const ctxSrc = await readFile('src/contexts/LanguageContext.tsx');
    if (!ctxSrc) {
      res.status(502).json({ ok: false, error: 'CATALOG_UNREADABLE' });
      return;
    }
    const declared = parseLanguageOptions(ctxSrc);

    // EN total (source of truth)
    const enShards = await listDir('src/i18n/en');
    let enTotal = 0;
    const enJsonShards = enShards.filter((f) => f.type === 'file' && f.name.endsWith('.json') && !f.name.endsWith('._audit.json'));
    // Read first 3 shards for count (cheap path); for accurate total, sum all
    for (const s of enJsonShards) {
      const txt = await readFile(`src/i18n/en/${s.name}`);
      if (txt) {
        try {
          enTotal += countLeaves(JSON.parse(txt));
        } catch {
          /* ignore */
        }
      }
    }

    const result: Array<Record<string, unknown>> = [];
    for (const { value, status } of declared) {
      const short = value.split('-')[0]; // de-DE → de
      const dir = `src/i18n/${short}`;
      const shards = await listDir(dir);
      const jsonShards = shards.filter((f) => f.type === 'file' && f.name.endsWith('.json') && !f.name.endsWith('._audit.json'));

      let localeTotal = 0;
      for (const s of jsonShards) {
        const txt = await readFile(`${dir}/${s.name}`);
        if (txt) {
          try {
            localeTotal += countLeaves(JSON.parse(txt));
          } catch {
            /* ignore */
          }
        }
      }

      // Audit files
      const auditFiles = shards.filter((f) => f.name.endsWith('._audit.json'));
      let auditOk = 0;
      let auditFlagged = 0;
      let auditTotal = 0;
      let lastAuditAt: string | null = null;
      for (const f of auditFiles) {
        const txt = await readFile(`${dir}/${f.name}`);
        if (!txt) continue;
        try {
          const a = JSON.parse(txt) as { generatedAt?: string; verdicts?: Record<string, { verdict: string }> };
          if (a.generatedAt && (!lastAuditAt || a.generatedAt > lastAuditAt)) lastAuditAt = a.generatedAt;
          for (const v of Object.values(a.verdicts || {})) {
            auditTotal++;
            if (v.verdict === 'OK') auditOk++;
            else auditFlagged++;
          }
        } catch {
          /* ignore */
        }
      }

      result.push({
        code: value,
        lang_code: short,
        status,
        en_total: enTotal,
        locale_total: localeTotal,
        completeness_pct: enTotal > 0 ? Math.round((100 * localeTotal) / enTotal) : 0,
        audit_total: auditTotal,
        audit_ok: auditOk,
        audit_flagged: auditFlagged,
        audit_pass_rate_pct: auditTotal > 0 ? Math.round((100 * auditOk) / auditTotal) : null,
        last_audit_at: lastAuditAt,
      });
    }

    const payload = {
      ok: true,
      vtid: VTID,
      source_lang: 'en',
      en_total: enTotal,
      generated_at: new Date().toISOString(),
      locales: result,
    };
    LOCALES_CACHE = { at: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'CATALOG_FETCH_FAILED', message: (e as Error).message });
  }
});

/**
 * POST /translate
 * Body: { locale: "es", provider?: "deepseek" | "gemini" | "anthropic" }
 *
 * Dispatches the i18n-translate.yml workflow on vitana-v1 main.
 */
router.post('/translate', requireExafyAdmin, async (req, res) => {
  const locale = String(req.body?.locale || '').trim();
  const provider = String(req.body?.provider || 'deepseek').trim();
  if (!/^[a-z]{2}$/.test(locale)) {
    res.status(400).json({ ok: false, error: 'INVALID_LOCALE', message: 'Expected a 2-letter ISO code (de, es, sr, etc.)' });
    return;
  }
  if (!['deepseek', 'gemini', 'anthropic'].includes(provider)) {
    res.status(400).json({ ok: false, error: 'INVALID_PROVIDER' });
    return;
  }
  try {
    const r = await ghFetch(`/repos/${REPO}/actions/workflows/i18n-translate.yml/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        ref: 'main',
        inputs: { provider, locale, batch: '40' },
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ ok: false, error: 'DISPATCH_FAILED', http_status: r.status, message: text.slice(0, 300) });
      return;
    }
    LOCALES_CACHE = null;
    res.json({ ok: true, vtid: VTID, dispatched: { workflow: 'i18n-translate.yml', locale, provider } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'DISPATCH_ERROR', message: (e as Error).message });
  }
});

/**
 * POST /audit
 * Body: { locale: "de", provider?: "gemini" | "anthropic" | "deepseek", shard?: string, threshold?: number }
 */
router.post('/audit', requireExafyAdmin, async (req, res) => {
  const locale = String(req.body?.locale || '').trim();
  const provider = String(req.body?.provider || 'gemini').trim();
  const shard = String(req.body?.shard || '').trim();
  const threshold = String(req.body?.threshold || '10');
  if (!/^[a-z]{2}$/.test(locale)) {
    res.status(400).json({ ok: false, error: 'INVALID_LOCALE' });
    return;
  }
  if (!['gemini', 'anthropic', 'deepseek'].includes(provider)) {
    res.status(400).json({ ok: false, error: 'INVALID_PROVIDER' });
    return;
  }
  try {
    const inputs: Record<string, string> = { locale, provider, threshold, resume: 'true' };
    if (shard) inputs.shard = shard;
    const r = await ghFetch(`/repos/${REPO}/actions/workflows/i18n-audit-llm.yml/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs }),
    });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ ok: false, error: 'DISPATCH_FAILED', http_status: r.status, message: text.slice(0, 300) });
      return;
    }
    LOCALES_CACHE = null;
    res.json({ ok: true, vtid: VTID, dispatched: { workflow: 'i18n-audit-llm.yml', locale, provider, shard: shard || null } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'DISPATCH_ERROR', message: (e as Error).message });
  }
});

/**
 * GET /workflow-runs?workflow=i18n-translate.yml&limit=10
 */
router.get('/workflow-runs', requireExafyAdmin, async (req, res) => {
  const workflow = String(req.query.workflow || 'i18n-translate.yml').trim();
  const limit = Math.min(20, parseInt(String(req.query.limit || '10'), 10) || 10);
  if (!['i18n-translate.yml', 'i18n-audit-llm.yml', 'i18n-check.yml'].includes(workflow)) {
    res.status(400).json({ ok: false, error: 'INVALID_WORKFLOW' });
    return;
  }
  try {
    const r = await ghFetch(`/repos/${REPO}/actions/workflows/${workflow}/runs?per_page=${limit}`);
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ ok: false, error: 'GH_FETCH_FAILED', http_status: r.status, message: text.slice(0, 300) });
      return;
    }
    const data = (await r.json()) as { workflow_runs?: Array<Record<string, unknown>> };
    const runs = (data.workflow_runs || []).map((run) => ({
      id: run.id,
      run_number: run.run_number,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      head_branch: run.head_branch,
      created_at: run.created_at,
      updated_at: run.updated_at,
      run_started_at: run.run_started_at,
      html_url: run.html_url,
      actor_login: (run.actor as { login?: string } | undefined)?.login,
      display_title: run.display_title,
    }));
    res.json({ ok: true, workflow, runs });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'GH_FETCH_ERROR', message: (e as Error).message });
  }
});

/**
 * POST /promote-ga
 * Body: { locale: "es" }
 *
 * Phase 4 — stubbed. Will open a PR on vitana-v1 flipping status: 'draft'
 * → 'ga' for the given locale in src/contexts/LanguageContext.tsx.
 * For now, returns instructions.
 */
router.post('/promote-ga', requireExafyAdmin, (_req, res) => {
  res.status(501).json({
    ok: false,
    error: 'NOT_IMPLEMENTED',
    message:
      'GA promotion is gated on the LLM audit pass-rate; flip manually for now via a PR editing src/contexts/LanguageContext.tsx (status: "draft" → "ga"). Phase 4 will automate this once an audit run has produced verdicts under threshold.',
  });
});

export default router;
