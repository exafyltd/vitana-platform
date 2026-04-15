/**
 * VTID-01900: Longevity News Feed — Gateway Routes
 *
 * Serves paginated longevity news from the news_items table.
 * Supports language filtering (?language=en or ?language=de).
 */

import { Router, Request, Response } from 'express';
import { runFetchCycle } from '../services/longevity-news-fetcher';

const router = Router();
const VTID = 'VTID-01900';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

async function supabaseQuery(
  tablePath: string,
  params: Record<string, string> = {},
  headers: Record<string, string> = {}
): Promise<{ data: any; count: number | null; error: string | null }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { data: null, count: null, error: 'Supabase credentials missing' };
  }
  const url = new URL(`${SUPABASE_URL}/rest/v1/${tablePath}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      'Prefer': 'count=exact',
      ...headers,
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    return { data: null, count: null, error: `${response.status}: ${errText}` };
  }
  const data = await response.json();
  const countHeader = response.headers.get('content-range');
  const count = countHeader ? parseInt(countHeader.split('/')[1] || '0', 10) : null;
  return { data, count, error: null };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const { count, error } = await supabaseQuery('news_items', { select: 'id', limit: '0' });
    res.json({ ok: true, vtid: VTID, service: 'longevity-news', total_items: count ?? 0, feeds_configured: 28, error: error || undefined });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/items', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const tag = req.query.tag as string | undefined;
    const source = req.query.source as string | undefined;
    const language = req.query.language as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const params: Record<string, string> = {
      select: 'id,source_name,source_url,title,link,summary,image_url,published_at,tags,source_type,language,created_at',
      order: 'published_at.desc',
      offset: String(offset),
      limit: String(limit),
    };

    if (tag) params['tags'] = `cs.{${tag}}`;
    if (source) params['source_name'] = `eq.${source}`;
    if (language) params['language'] = `eq.${language}`;

    if (from) params['published_at'] = `gte.${from}`;
    if (to) {
      if (from) {
        params['and'] = `(published_at.gte.${from},published_at.lte.${to})`;
        delete params['published_at'];
      } else {
        params['published_at'] = `lte.${to}`;
      }
    }

    const { data, count, error } = await supabaseQuery('news_items', params);
    if (error) { res.status(500).json({ ok: false, error }); return; }

    res.json({
      ok: true, items: data || [], total: count ?? 0, page, limit,
      has_more: count !== null ? offset + limit < count : (data || []).length === limit,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/sources', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseQuery('news_items', { select: 'source_name', order: 'source_name' });
    if (error) { res.status(500).json({ ok: false, error }); return; }
    const sourceCounts: Record<string, number> = {};
    for (const row of (data || [])) { sourceCounts[row.source_name] = (sourceCounts[row.source_name] || 0) + 1; }
    const sources = Object.entries(sourceCounts).map(([name, count]) => ({ source_name: name, item_count: count }));
    res.json({ ok: true, sources });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/tags', async (_req: Request, res: Response) => {
  res.json({
    ok: true,
    tags: [
      { key: 'supplements', label: 'Supplements' },
      { key: 'functional', label: 'Functional' },
      { key: 'mental_health', label: 'Mental Health' },
      { key: 'natural', label: 'Natural' },
      { key: 'general', label: 'General' },
    ],
  });
});

router.post('/fetch', async (_req: Request, res: Response) => {
  try {
    runFetchCycle().catch((err: Error) => { console.error(`[${VTID}] Manual fetch error:`, err.message); });
    res.json({ ok: true, message: 'Fetch cycle triggered. Check logs for progress.' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
