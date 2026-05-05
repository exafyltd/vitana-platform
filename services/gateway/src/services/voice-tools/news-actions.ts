/**
 * VTID-02773 — Voice Tool Expansion P1k: News read tools.
 *
 * Reads from news_items table (longevity news feed). Privacy: news is
 * public; no user_id filtering needed.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export async function browseNewsFeed(
  sb: SupabaseClient,
  args: { tag?: string; language?: string; limit?: number },
): Promise<{ ok: true; items: any[]; count: number } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  let q = sb
    .from('news_items')
    .select('id, source_name, title, link, summary, image_url, published_at, tags, language')
    .order('published_at', { ascending: false })
    .limit(limit);
  if (args.tag) q = q.contains('tags', [args.tag]);
  if (args.language) q = q.eq('language', args.language);
  const { data, error } = await q;
  if (error) return { ok: false, error: `news_query_failed: ${error.message}` };
  return { ok: true, items: data || [], count: (data || []).length };
}

export async function listNewsSources(
  sb: SupabaseClient,
): Promise<{ ok: true; sources: Array<{ name: string; count: number }>; count: number } | { ok: false; error: string }> {
  const { data, error } = await sb
    .from('news_items')
    .select('source_name')
    .limit(1000);
  if (error) return { ok: false, error: `sources_query_failed: ${error.message}` };
  const counts = new Map<string, number>();
  for (const r of (data || []) as any[]) {
    const s = String(r.source_name || '').trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const sources = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { ok: true, sources, count: sources.length };
}

export async function listNewsTags(
  sb: SupabaseClient,
): Promise<{ ok: true; tags: Array<{ tag: string; count: number }>; count: number } | { ok: false; error: string }> {
  const { data, error } = await sb
    .from('news_items')
    .select('tags')
    .limit(1000);
  if (error) return { ok: false, error: `tags_query_failed: ${error.message}` };
  const counts = new Map<string, number>();
  for (const r of (data || []) as any[]) {
    const arr = Array.isArray(r.tags) ? r.tags : [];
    for (const t of arr) {
      const tag = String(t || '').trim();
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const tags = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  return { ok: true, tags, count: tags.length };
}
