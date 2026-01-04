/**
 * Check Memory First Skill - VTID-01164
 *
 * Enforces memory-first governance before any apply_patch operation.
 * Searches internal memory/indexer endpoints and OASIS/task spec history.
 */

import {
  CheckMemoryFirstParams,
  CheckMemoryFirstResult,
  MemoryReference,
  SkillContext,
} from './types';

/**
 * Search OASIS events for related VTIDs
 */
async function searchOasisHistory(
  query: string,
  vtid: string
): Promise<MemoryReference[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[CheckMemoryFirst] Supabase not configured - skipping OASIS search');
    return [];
  }

  const refs: MemoryReference[] = [];

  try {
    // Search VtidLedger for similar titles/descriptions
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const searchTerms = keywords.slice(0, 5).join(' | ');

    // Use full-text search on title and summary
    const ledgerUrl = `${supabaseUrl}/rest/v1/vtid_ledger?or=(title.ilike.*${encodeURIComponent(keywords[0] || '')}*,summary.ilike.*${encodeURIComponent(keywords[0] || '')}*)&vtid=neq.${vtid}&limit=10&order=created_at.desc`;

    const ledgerResp = await fetch(ledgerUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (ledgerResp.ok) {
      const vtids = await ledgerResp.json() as any[];
      for (const v of vtids) {
        // Calculate basic relevance score based on keyword matches
        const titleLower = (v.title || '').toLowerCase();
        const summaryLower = (v.summary || '').toLowerCase();
        const matchCount = keywords.filter(
          kw => titleLower.includes(kw) || summaryLower.includes(kw)
        ).length;
        const relevance = Math.min(matchCount / keywords.length, 1.0);

        if (relevance > 0.2) {
          refs.push({
            type: 'vtid',
            id: v.vtid,
            title: v.title || v.vtid,
            relevance_score: relevance,
            summary: v.summary || v.title || 'No summary available',
          });
        }
      }
    }

    // Search OASIS events for patterns
    const eventsUrl = `${supabaseUrl}/rest/v1/oasis_events?message.ilike.*${encodeURIComponent(keywords[0] || '')}*&vtid=neq.${vtid}&limit=20&order=created_at.desc`;

    const eventsResp = await fetch(eventsUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (eventsResp.ok) {
      const events = await eventsResp.json() as any[];
      const seenVtids = new Set(refs.map(r => r.id));

      for (const e of events) {
        if (!seenVtids.has(e.vtid)) {
          const messageLower = (e.message || '').toLowerCase();
          const matchCount = keywords.filter(kw => messageLower.includes(kw)).length;
          const relevance = Math.min(matchCount / keywords.length, 0.8); // Cap event relevance

          if (relevance > 0.2) {
            refs.push({
              type: 'event',
              id: e.id,
              title: `${e.vtid}: ${e.topic}`,
              relevance_score: relevance,
              summary: e.message || 'No message',
            });
            seenVtids.add(e.vtid);
          }
        }
      }
    }
  } catch (error) {
    console.error('[CheckMemoryFirst] Error searching OASIS:', error);
  }

  // Sort by relevance
  return refs.sort((a, b) => b.relevance_score - a.relevance_score);
}

/**
 * Search for patterns in target paths
 */
async function searchPathPatterns(
  targetPaths: string[],
  query: string
): Promise<MemoryReference[]> {
  const refs: MemoryReference[] = [];

  // Extract domain from paths
  const domains: string[] = [];
  for (const path of targetPaths) {
    if (path.includes('frontend')) domains.push('frontend');
    if (path.includes('routes') || path.includes('services')) domains.push('backend');
    if (path.includes('supabase') || path.includes('migration')) domains.push('memory');
  }

  // Add pattern references based on detected domains
  const uniqueDomains = [...new Set(domains)];
  for (const domain of uniqueDomains) {
    refs.push({
      type: 'pattern',
      id: `pattern-${domain}`,
      title: `${domain.charAt(0).toUpperCase() + domain.slice(1)} Domain Patterns`,
      relevance_score: 0.5,
      summary: `Standard patterns for ${domain} domain work. Check existing implementations before creating new ones.`,
    });
  }

  return refs;
}

/**
 * Determine recommendation based on findings
 */
function determineRecommendation(
  refs: MemoryReference[],
  confidence: number
): CheckMemoryFirstResult['recommendation'] {
  if (refs.length === 0) {
    return 'proceed';
  }

  const vtidRefs = refs.filter(r => r.type === 'vtid');
  const highRelevance = refs.filter(r => r.relevance_score > 0.7);

  if (highRelevance.length > 0 && vtidRefs.length > 0) {
    // Check if any high-relevance match looks like a duplicate
    const maxRelevance = Math.max(...refs.map(r => r.relevance_score));
    if (maxRelevance > 0.9) {
      return 'duplicate_detected';
    }
    return 'consult_prior_vtid';
  }

  if (vtidRefs.length > 0) {
    return 'review_prior_work';
  }

  return 'proceed';
}

/**
 * Main skill handler
 */
export async function checkMemoryFirst(
  params: CheckMemoryFirstParams,
  context: SkillContext
): Promise<CheckMemoryFirstResult> {
  const { vtid, query, target_paths, include_oasis_history, include_kb } = params;

  // Emit start event
  await context.emitEvent('start', 'info', `Memory check started for: ${query.slice(0, 50)}...`, {
    query_length: query.length,
    target_paths_count: target_paths?.length || 0,
  });

  try {
    const allRefs: MemoryReference[] = [];

    // Search OASIS history if enabled
    if (include_oasis_history !== false) {
      const oasisRefs = await searchOasisHistory(query, vtid);
      allRefs.push(...oasisRefs);
    }

    // Search path patterns if target paths provided
    if (target_paths && target_paths.length > 0) {
      const pathRefs = await searchPathPatterns(target_paths, query);
      allRefs.push(...pathRefs);
    }

    // KB search would go here if enabled and we had a KB endpoint
    // For now, we'll skip this as it requires additional infrastructure

    // Calculate overall confidence
    const hasHits = allRefs.length > 0;
    const maxRelevance = hasHits ? Math.max(...allRefs.map(r => r.relevance_score)) : 0;
    const confidence = hasHits ? maxRelevance : 0;

    // Determine recommendation
    const recommendation = determineRecommendation(allRefs, confidence);

    // Extract prior VTIDs
    const priorVtids = [...new Set(
      allRefs
        .filter(r => r.type === 'vtid')
        .map(r => r.id)
    )];

    const result: CheckMemoryFirstResult = {
      ok: true,
      memory_hit: hasHits,
      confidence,
      relevant_refs: allRefs.slice(0, 10), // Limit to top 10
      recommendation,
      prior_vtids: priorVtids,
    };

    // Emit success event
    await context.emitEvent('success', 'success', `Memory check completed: ${recommendation}`, {
      memory_hit: hasHits,
      confidence,
      refs_count: allRefs.length,
      prior_vtids_count: priorVtids.length,
      recommendation,
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Emit failed event
    await context.emitEvent('failed', 'error', `Memory check failed: ${errorMsg}`, {
      error: errorMsg,
    });

    return {
      ok: false,
      error: errorMsg,
      memory_hit: false,
      confidence: 0,
      relevant_refs: [],
      recommendation: 'proceed', // Default to proceed on error
      prior_vtids: [],
    };
  }
}
