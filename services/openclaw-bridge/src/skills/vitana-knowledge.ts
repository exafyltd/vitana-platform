/**
 * Vitana Knowledge Skill for OpenClaw
 *
 * RAG-style knowledge base queries, content indexing, and i18n
 * content delivery. Integrates with Cognee entity extraction
 * and the existing knowledge base tables.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SearchSchema = z.object({
  tenant_id: z.string().uuid(),
  query: z.string().min(1).max(2000),
  locale: z.string().default('en'),
  category: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

const GetArticleSchema = z.object({
  tenant_id: z.string().uuid(),
  article_id: z.string().uuid(),
  locale: z.string().default('en'),
});

const IndexContentSchema = z.object({
  tenant_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
  category: z.string().min(1).max(100),
  locale: z.string().default('en'),
  tags: z.array(z.string()).default([]),
  author_id: z.string().uuid().optional(),
});

const ExtractEntitiesSchema = z.object({
  tenant_id: z.string().uuid(),
  text: z.string().min(1).max(10000),
});

const SuggestSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  context: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(10).default(3),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Search the knowledge base using text similarity.
   * Uses Supabase full-text search with locale-aware ranking.
   */
  async search(input: unknown) {
    const { tenant_id, query, locale, category, limit } = SearchSchema.parse(input);
    const supabase = getSupabase();

    let rpcParams: Record<string, unknown> = {
      p_tenant_id: tenant_id,
      p_query: query,
      p_locale: locale,
      p_limit: limit,
    };
    if (category) rpcParams.p_category = category;

    const { data, error } = await supabase.rpc('kb_search', rpcParams);

    if (error) {
      // Fallback to basic ILIKE search if RPC not available
      let fallbackQuery = supabase
        .from('knowledge_articles')
        .select('id, title, body, category, locale, tags, created_at')
        .eq('tenant_id', tenant_id)
        .eq('locale', locale)
        .eq('status', 'published')
        .ilike('title', `%${query}%`)
        .limit(limit);

      if (category) fallbackQuery = fallbackQuery.eq('category', category);

      const { data: fallbackData, error: fbError } = await fallbackQuery;
      if (fbError) throw new Error(`search failed: ${fbError.message}`);
      return { success: true, results: fallbackData, count: fallbackData?.length ?? 0, method: 'fallback' };
    }

    return { success: true, results: data, count: data?.length ?? 0, method: 'semantic' };
  },

  /**
   * Get a specific article by ID with locale support.
   */
  async get_article(input: unknown) {
    const { tenant_id, article_id, locale } = GetArticleSchema.parse(input);
    const supabase = getSupabase();

    // Try exact locale first, then fall back to 'en'
    let { data, error } = await supabase
      .from('knowledge_articles')
      .select('*')
      .eq('id', article_id)
      .eq('tenant_id', tenant_id)
      .eq('locale', locale)
      .single();

    if (error && locale !== 'en') {
      const fallback = await supabase
        .from('knowledge_articles')
        .select('*')
        .eq('id', article_id)
        .eq('tenant_id', tenant_id)
        .eq('locale', 'en')
        .single();
      data = fallback.data;
      error = fallback.error;
    }

    if (error || !data) throw new Error(`Article ${article_id} not found`);
    return { success: true, article: data };
  },

  /**
   * Index new content into the knowledge base.
   */
  async index_content(input: unknown) {
    const { tenant_id, title, body, category, locale, tags, author_id } =
      IndexContentSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('knowledge_articles')
      .insert({
        tenant_id,
        title,
        body,
        category,
        locale,
        tags,
        author_id,
        status: 'published',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`index_content failed: ${error.message}`);

    // Trigger entity extraction asynchronously via Cognee
    const cogneeUrl = process.env.COGNEE_EXTRACTOR_URL;
    if (cogneeUrl) {
      fetch(`${cogneeUrl}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${title}\n\n${body}`, source_id: data.id, tenant_id }),
      }).catch(() => {});
    }

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'knowledge.content_indexed',
      actor: 'openclaw-autopilot',
      details: { article_id: data.id, category, locale },
      created_at: new Date().toISOString(),
    });

    return { success: true, article: data };
  },

  /**
   * Extract entities from text using Cognee.
   */
  async extract_entities(input: unknown) {
    const { tenant_id, text } = ExtractEntitiesSchema.parse(input);

    const cogneeUrl = process.env.COGNEE_EXTRACTOR_URL;
    if (!cogneeUrl) {
      return { success: false, error: 'COGNEE_EXTRACTOR_URL not configured' };
    }

    const res = await fetch(`${cogneeUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, tenant_id }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Entity extraction failed (${res.status}): ${errText}`);
    }

    const entities = await res.json();
    return { success: true, entities };
  },

  /**
   * Suggest relevant articles for a user based on their context.
   */
  async suggest(input: unknown) {
    const { tenant_id, user_id, context, limit } = SuggestSchema.parse(input);
    const supabase = getSupabase();

    // Get user's recent activity for context
    const { data: recentActivity } = await supabase
      .from('autopilot_logs')
      .select('action, details')
      .eq('tenant_id', tenant_id)
      .ilike('details->>user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(5);

    // Build search query from context + activity
    const searchTerms = context ?? (recentActivity?.map((a) => a.action).join(' ') ?? '');

    if (!searchTerms) {
      // Return popular articles as fallback
      const { data } = await supabase
        .from('knowledge_articles')
        .select('id, title, category, locale')
        .eq('tenant_id', tenant_id)
        .eq('status', 'published')
        .order('view_count', { ascending: false })
        .limit(limit);

      return { success: true, suggestions: data ?? [], method: 'popular' };
    }

    const results = await actions.search({
      tenant_id,
      query: searchTerms,
      limit,
    });

    return { success: true, suggestions: results.results ?? [], method: 'contextual' };
  },
};

export const SKILL_META = {
  name: 'vitana-knowledge',
  description: 'Knowledge base search, content indexing, entity extraction, and article suggestions',
  actions: Object.keys(actions),
};
