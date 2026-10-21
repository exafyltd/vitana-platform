/**
 * VTID-01973: Intent embedding helper (P2-A).
 *
 * Wraps the existing embedding-service.ts. Concatenates kind + category
 * + title + scope + key kind_payload fields into one text blob, then
 * embeds with the canonical 768-dim model. P2-A inlines on insert; P2-C
 * promotes to a NOTIFY-driven worker if write rate climbs.
 */

import { generateEmbedding, EMBEDDING_DIMENSIONS } from './embedding-service';
import type { IntentKind } from './intent-classifier';

interface IntentForEmbedding {
  intent_kind: IntentKind;
  category: string | null;
  title: string;
  scope: string;
  kind_payload: Record<string, unknown>;
}

/**
 * Build a deterministic text blob from an intent. The kind-payload fields
 * we include are the ones most discriminative for similarity (activity
 * name, topic, object_or_skill). Budget/age/time numbers are NOT included
 * — those are exact-overlap fields handled by the SQL match function.
 */
function intentToEmbeddingText(intent: IntentForEmbedding): string {
  const parts: string[] = [
    `kind:${intent.intent_kind}`,
    intent.category ? `category:${intent.category}` : '',
    intent.title || '',
    intent.scope || '',
  ];

  // Pull a few kind-specific discriminators.
  const p = intent.kind_payload || {};
  if (typeof p.activity === 'string') parts.push(`activity:${p.activity}`);
  if (typeof p.topic === 'string') parts.push(`topic:${p.topic}`);
  if (typeof p.object_or_skill === 'string') parts.push(`item:${p.object_or_skill}`);
  if (Array.isArray(p.skill_keywords)) parts.push(`skills:${p.skill_keywords.join(',')}`);
  if (Array.isArray(p.must_haves)) parts.push(`must_haves:${p.must_haves.join(',')}`);

  return parts.filter(Boolean).join(' | ');
}

export async function embedIntent(intent: IntentForEmbedding): Promise<number[] | null> {
  const text = intentToEmbeddingText(intent);
  if (!text) return null;
  try {
    const result = await generateEmbedding(text);
    if (result?.embedding && result.embedding.length === EMBEDDING_DIMENSIONS) {
      return result.embedding;
    }
    if (result?.embedding) {
      console.warn(`[VTID-01973] Embedding dim mismatch: got ${result.embedding.length}, expected ${EMBEDDING_DIMENSIONS}`);
    }
    return null;
  } catch (err: any) {
    console.warn(`[VTID-01973] embedIntent failed: ${err.message}`);
    return null;
  }
}
