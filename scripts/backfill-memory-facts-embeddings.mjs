#!/usr/bin/env node
/**
 * VTID-01225: Backfill embeddings for existing memory_facts
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... GOOGLE_GEMINI_API_KEY=... node scripts/backfill-memory-facts-embeddings.mjs
 *
 * Options:
 *   --batch-size=N   Number of facts per batch (default: 50)
 *   --dry-run        Show what would be embedded without writing
 *
 * This script:
 * 1. Fetches memory_facts without embeddings via memory_facts_needing_embeddings() RPC
 * 2. Generates embeddings via Gemini text-embedding-004 (1536 dimensions)
 * 3. Updates the embedding column on each fact
 * 4. Repeats until all facts have embeddings
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('Missing GOOGLE_GEMINI_API_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 50;

const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIMENSIONS = 1536;

const headers = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

async function fetchFactsNeedingEmbeddings() {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/memory_facts_needing_embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_batch_size: BATCH_SIZE }),
  });
  if (!resp.ok) {
    throw new Error(`RPC failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function generateEmbedding(text) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    }
  );
  if (!resp.ok) {
    throw new Error(`Gemini API error: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  const embedding = data.embedding?.values;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('No embedding returned from Gemini');
  }
  return embedding;
}

async function updateFactEmbedding(factId, embedding) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/memory_facts?id=eq.${factId}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      embedding: JSON.stringify(embedding),
      embedding_model: EMBEDDING_MODEL,
      embedding_updated_at: new Date().toISOString(),
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.warn(`  Failed to update fact ${factId}: ${resp.status} ${errText}`);
    return false;
  }
  return true;
}

async function main() {
  console.log(`Backfill memory_facts embeddings (model=${EMBEDDING_MODEL}, dims=${EMBEDDING_DIMENSIONS}, batch_size=${BATCH_SIZE}, dry_run=${dryRun})`);
  let totalProcessed = 0;
  let totalFailed = 0;

  while (true) {
    const facts = await fetchFactsNeedingEmbeddings();
    if (!facts || facts.length === 0) {
      console.log('No more facts needing embeddings.');
      break;
    }

    console.log(`Batch: ${facts.length} facts to embed`);

    if (dryRun) {
      for (const f of facts) {
        console.log(`  [dry-run] Would embed: ${f.fact_key}: ${f.fact_value}`);
      }
      totalProcessed += facts.length;
      break;
    }

    // Generate and store embeddings one at a time (Gemini doesn't batch)
    for (const f of facts) {
      try {
        const text = `${f.fact_key}: ${f.fact_value}`;
        const embedding = await generateEmbedding(text);
        const success = await updateFactEmbedding(f.id, embedding);
        if (success) {
          totalProcessed++;
          console.log(`  ✓ ${f.fact_key}: ${f.fact_value.substring(0, 40)}`);
        } else {
          totalFailed++;
        }
      } catch (err) {
        console.warn(`  ✗ Failed ${f.fact_key}: ${err.message}`);
        totalFailed++;
      }
      // Small delay between calls to avoid rate limits
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`  Batch complete: ${totalProcessed} processed, ${totalFailed} failed total`);

    // Delay between batches
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone. Total: ${totalProcessed} embedded, ${totalFailed} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
