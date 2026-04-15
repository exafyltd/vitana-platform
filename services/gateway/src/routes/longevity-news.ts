/**
 * VTID-01900: Longevity News Feed — Gateway Routes
 *
 * Serves paginated longevity news from the news_items table.
 * Items are ingested by the background longevity-news-fetcher service.
 *
 * Endpoints:
 * - GET  /              - Service status + feed count
 * - GET  /items         - Paginated feed (page, limit, tag, source, from/to)
 * - GET  /sources       - Distinct source names with item counts
 * - GET  /tags          - Available tag categories
 * - POST /fetch         - Manual trigger (admin/scheduler use)
 */

import { Router, Request, Response } from 'express';
import { runFetchCycle } from '../services/longevity-news-fetcher';

const router = Router();
const VTID = 'VTID-01900';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// ── Helper: Supabase REST query ──────────────────────────────────
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
  const count = countHeader
    ? parseInt(countHeader.split('/')[1] || '0', 10)
    : null;

  return { data, count, error: null };
}

// ── GET / — Service status ───────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { count, error } = await supabaseQuery('news_items', {
      select: 'id',
      limit: '0',
    });

    res.json({
      ok: true,
      vtid: VTID,
      service: 'longevity-news',
      total_items: count ?? 0,
      feeds_configured: 15,
      error: error || undefined,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /items — Paginated feed ──────────────────────────────────
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

    // Build PostgREST filter params
    const params: Record<string, string> = {
      select: 'id,source_name,source_url,title,link,summary,image_url,published_at,tags,source_type,language,created_at',
      order: 'published_at.desc',
      offset: String(offset),
      limit: String(limit),
    };

    // Tag filter: uses PostgREST array contains operator
    if (tag) {
      params['tags'] = `cs.{${tag}}`;
    }

    // Source filter
    if (source) {
      params['source_name'] = `eq.${source}`;
    }

    // Language filter (e.g., 'en', 'de')
    if (language) {
      params['language'] = `eq.${language}`;
    }

    // Date range filters
    if (from) {
      params['published_at'] = `gte.${from}`;
    }
    if (to) {
      // Combine with existing published_at filter if 'from' was also set
      if (from) {
        // PostgREST doesn't support multiple same-column filters in params easily;
        // use 'and' filter instead
        params['and'] = `(published_at.gte.${from},published_at.lte.${to})`;
        delete params['published_at'];
      } else {
        params['published_at'] = `lte.${to}`;
      }
    }

    const { data, count, error } = await supabaseQuery('news_items', params);

    if (error) {
      res.status(500).json({ ok: false, error });
      return;
    }

    res.json({
      ok: true,
      items: data || [],
      total: count ?? 0,
      page,
      limit,
      has_more: count !== null ? offset + limit < count : (data || []).length === limit,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /sources — Distinct sources with counts ──────────────────
router.get('/sources', async (_req: Request, res: Response) => {
  try {
    // Query all items grouped by source_name (PostgREST doesn't support GROUP BY natively)
    // Fetch distinct source names, then count per source
    const { data, error } = await supabaseQuery('news_items', {
      select: 'source_name',
      order: 'source_name',
    });

    if (error) {
      res.status(500).json({ ok: false, error });
      return;
    }

    // Count per source in-memory
    const sourceCounts: Record<string, number> = {};
    for (const row of (data || [])) {
      sourceCounts[row.source_name] = (sourceCounts[row.source_name] || 0) + 1;
    }

    const sources = Object.entries(sourceCounts).map(([name, count]) => ({
      source_name: name,
      item_count: count,
    }));

    res.json({ ok: true, sources });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /tags — Available tag categories ─────────────────────────
router.get('/tags', async (_req: Request, res: Response) => {
  // Static list of tag categories that the autoTag function produces
  res.json({
    ok: true,
    tags: [
      { key: 'supplements', label: 'Supplements', keywords: ['nmn', 'nad', 'resveratrol', 'rapamycin', 'fisetin', 'quercetin', 'spermidine', 'berberine', 'metformin'] },
      { key: 'functional', label: 'Functional', keywords: ['mitochondria', 'autophagy', 'sirtuins', 'senolytic', 'telomere'] },
      { key: 'mental_health', label: 'Mental Health', keywords: ['mental health', 'anxiety', 'depression', 'stress', 'mindfulness', 'meditation', 'cognitive', 'brain health', 'neuroplasticity', 'dementia', 'alzheimer', 'mood', 'psycholog', 'wellbeing', 'well-being', 'therapy'] },
      { key: 'natural', label: 'Natural', keywords: ['polyphenol', 'flavonoid', 'curcumin', 'egcg'] },
      { key: 'general', label: 'General', keywords: ['sleep', 'exercise', 'nutrition', 'hydration', 'metabolic', 'prevention', 'fasting', 'longevity', 'aging', 'healthspan', 'lifespan'] },
    ],
  });
});

// ── POST /fetch — Manual trigger ─────────────────────────────────
router.post('/fetch', async (_req: Request, res: Response) => {
  try {
    // Run fetch cycle asynchronously (don't block response)
    runFetchCycle().catch((err: Error) => {
      console.error(`[${VTID}] Manual fetch cycle error:`, err.message);
    });

    res.json({
      ok: true,
      message: 'Fetch cycle triggered. Check logs for progress.',
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
