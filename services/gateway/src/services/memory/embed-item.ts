/**
 * Embed a just-written memory_items row in the background. Never throws: a
 * row left with a NULL embedding is picked up by AP-0910's backfill.
 */
export async function embedItemLater(id: string | undefined | null, text: string): Promise<void> {
  if (!id) return;
  try {
    const { embedMemoryText, toPgVector } = await import('../memory-embedding');
    const emb = await embedMemoryText(text);
    if (!emb.ok || !emb.embedding) return;
    const { getSupabase } = await import('../../lib/supabase');
    const sb = getSupabase();
    if (!sb) return;
    await sb.from('memory_items').update({ embedding: toPgVector(emb.embedding), embedding_model: emb.model, embedding_updated_at: new Date().toISOString() }).eq('id', id);
  } catch {
    /* AP-0910 backfills NULL embeddings */
  }
}
