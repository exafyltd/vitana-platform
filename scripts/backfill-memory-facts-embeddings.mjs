#!/usr/bin/env node
/**
 * VTID-01225: Backfill embeddings for existing memory_facts
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... OPENAI_API_KEY=... node scripts/backfill-memory-facts-embeddings.mjs
 *
 * Options:
 *   --batch-size=N   Number of facts per batch (default: 50)
 *   --dry-run        Show what would be embedded without writing
 *
 * This script:
 * 1. Fetches memory_facts without embeddings via memory_facts_needing_embeddings() RPC
 * 2. Generates embeddings via OpenAI text-embedding-3-small
 * 3. Updates the embedding column on each fact
 * 4. Repeats until all facts have embeddings
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 50;

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

async function generateEmbeddings(texts) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: 'text-embedding-3-small',
      encoding_format: 'float',
    }),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI API error: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

async function updateFactEmbedding(factId, embedding) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/memory_facts?id=eq.${factId}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      embedding: JSON.stringify(embedding),
      embedding_model: 'text-embedding-3-small',
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
  console.log(`Backfill memory_facts embeddings (batch_size=${BATCH_SIZE}, dry_run=${dryRun})`);
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
      break; // Only show one batch in dry-run
    }

    // Generate embeddings for the batch
    const texts = facts.map(f => `${f.fact_key}: ${f.fact_value}`);
    const embeddings = await generateEmbeddings(texts);

    // Update each fact
    for (let i = 0; i < facts.length; i++) {
      const success = await updateFactEmbedding(facts[i].id, embeddings[i]);
      if (success) {
        totalProcessed++;
      } else {
        totalFailed++;
      }
    }

    console.log(`  Batch complete: ${facts.length} processed, ${totalFailed} failed total`);

    // Small delay between batches to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone. Total: ${totalProcessed} embedded, ${totalFailed} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
