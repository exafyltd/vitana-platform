#!/usr/bin/env node
/**
 * VTID-01225: Backfill embeddings for existing memory_facts
 *
 * Usage (Cloud Shell — uses gcloud ADC, no API key needed):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... node scripts/backfill-memory-facts-embeddings.mjs
 *
 * Options:
 *   --batch-size=N   Number of facts per batch (default: 50)
 *   --dry-run        Show what would be embedded without writing
 */

import { execSync } from 'child_process';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

const GCP_PROJECT = 'lovable-vitana-vers1';
const GCP_LOCATION = 'us-central1';
const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIMENSIONS = 768;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 50;

const supabaseHeaders = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

function getAccessToken() {
  return execSync('gcloud auth print-access-token', { encoding: 'utf-8' }).trim();
}

async function fetchFactsNeedingEmbeddings() {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/memory_facts_needing_embeddings`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ p_batch_size: BATCH_SIZE }),
  });
  if (!resp.ok) {
    throw new Error(`RPC failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function generateEmbedding(text, accessToken) {
  const url = `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      instances: [{ content: text }],
      parameters: { outputDimensionality: EMBEDDING_DIMENSIONS },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Vertex AI error: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const embedding = data.predictions?.[0]?.embeddings?.values;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('No embedding in Vertex AI response');
  }
  return embedding;
}

async function updateFactEmbedding(factId, embedding) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/memory_facts?id=eq.${factId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
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
  console.log(`Backfill memory_facts embeddings (model=vertex-ai/${EMBEDDING_MODEL}, dims=${EMBEDDING_DIMENSIONS}, batch=${BATCH_SIZE}, dry_run=${dryRun})`);

  console.log('Getting GCP access token...');
  let accessToken = getAccessToken();
  let tokenTime = Date.now();
  console.log('Access token obtained.');

  let totalProcessed = 0;
  let totalFailed = 0;

  while (true) {
    const facts = await fetchFactsNeedingEmbeddings();
    if (!facts || facts.length === 0) {
      console.log('No more facts needing embeddings.');
      break;
    }

    console.log(`\nBatch: ${facts.length} facts to embed`);

    if (dryRun) {
      for (const f of facts) {
        console.log(`  [dry-run] Would embed: ${f.fact_key}: ${f.fact_value}`);
      }
      totalProcessed += facts.length;
      break;
    }

    // Refresh token every 30 min
    if (Date.now() - tokenTime > 30 * 60 * 1000) {
      console.log('Refreshing access token...');
      accessToken = getAccessToken();
      tokenTime = Date.now();
    }

    for (const f of facts) {
      try {
        const text = `${f.fact_key}: ${f.fact_value}`;
        const embedding = await generateEmbedding(text, accessToken);
        const success = await updateFactEmbedding(f.id, embedding);
        if (success) {
          totalProcessed++;
          console.log(`  + ${f.fact_key}: ${f.fact_value.substring(0, 50)}`);
        } else {
          totalFailed++;
        }
      } catch (err) {
        console.warn(`  x Failed ${f.fact_key}: ${err.message}`);
        totalFailed++;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`  Batch done: ${totalProcessed} ok, ${totalFailed} failed`);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone. Total: ${totalProcessed} embedded, ${totalFailed} failed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
