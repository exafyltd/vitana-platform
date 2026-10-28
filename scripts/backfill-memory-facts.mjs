#!/usr/bin/env node
/**
 * VTID-01225-READ-FIX: Backfill memory_facts from existing memory_items
 *
 * Recovers structured facts from historical conversations stored as raw text
 * in memory_items. Uses the same Gemini Flash extraction prompt as the inline
 * fact extractor, and writes via the same write_fact() RPC.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... GOOGLE_GEMINI_API_KEY=... \
 *     node scripts/backfill-memory-facts.mjs <user-email>
 *
 * Options:
 *   --dry-run    Show what would be extracted without writing to DB
 *   --limit N    Max memory_items to process (default: 200)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
  process.exit(1);
}

if (!GOOGLE_GEMINI_API_KEY) {
  console.error('Missing GOOGLE_GEMINI_API_KEY (required for Gemini Flash extraction)');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const maxItems = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 200;
const userEmail = args.find(a => !a.startsWith('--') && (limitIdx === -1 || a !== args[limitIdx + 1]));

if (!userEmail) {
  console.error('Usage: node scripts/backfill-memory-facts.mjs <user-email> [--dry-run] [--limit N]');
  process.exit(1);
}

// Same extraction prompt as inline-fact-extractor.ts
const EXTRACTION_PROMPT = `You extract structured facts from a conversation turn.

Given a conversation between a User and Assistant, extract any personal facts the user reveals about themselves or others.

Return ONLY a JSON array of facts. Each fact must have:
- "fact_key": semantic key (e.g. "user_name", "user_residence", "user_favorite_color", "spouse_name", "user_occupation")
- "fact_value": the value (e.g. "Dusan", "Amsterdam", "blue", "Maria", "engineer")
- "entity": "self" if about the user, "disclosed" if about someone else
- "fact_value_type": "text", "date", or "number"

Common fact keys:
- user_name, user_residence, user_hometown, user_birthday, user_occupation, user_company
- user_favorite_color, user_favorite_food, user_favorite_drink, user_favorite_*
- user_allergy, user_medication, user_health_condition
- user_preference_*, user_goal_*
- spouse_name, fiancee_name, partner_name, mother_name, father_name, child_name, friend_name_*

Rules:
- Only extract facts the USER explicitly states (not assistant assumptions)
- If no facts are present, return an empty array: []
- Do NOT invent facts. Only extract what is clearly stated.
- Keep fact_value concise (1-5 words)
- For preferences, use "user_favorite_X" or "user_preference_X" as the key`;

async function supabaseQuery(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function extractFacts(text) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Gemini API returned ${resp.status}`);
  }

  const data = await resp.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

  // Parse JSON array from response
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd === -1) return [];

  const parsed = JSON.parse(cleaned.substring(arrayStart, arrayEnd + 1));
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(f =>
    f && typeof f.fact_key === 'string' && f.fact_key.length > 0 &&
    typeof f.fact_value === 'string' && f.fact_value.length > 0
  );
}

async function writeFact(tenantId, userId, fact) {
  return supabaseQuery('rpc/write_fact', {
    method: 'POST',
    body: {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_fact_key: fact.fact_key,
      p_fact_value: fact.fact_value,
      p_entity: fact.entity || 'self',
      p_fact_value_type: fact.fact_value_type || 'text',
      p_provenance_source: 'assistant_inferred',
      p_provenance_confidence: 0.80,
    },
  });
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`MEMORY FACTS BACKFILL ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(70)}\n`);

  // Step 1: Find user
  console.log(`Looking up user: ${userEmail}`);
  const profiles = await supabaseQuery(
    `profiles?select=id,tenant_id,email&email=eq.${encodeURIComponent(userEmail)}`
  );

  if (!profiles || profiles.length === 0) {
    console.error(`User not found: ${userEmail}`);
    process.exit(1);
  }

  const { id: userId, tenant_id: tenantId } = profiles[0];
  console.log(`User ID: ${userId}`);
  console.log(`Tenant ID: ${tenantId}\n`);

  // Step 2: Check existing facts
  const existingFacts = await supabaseQuery(
    `memory_facts?select=fact_key,fact_value&tenant_id=eq.${tenantId}&user_id=eq.${userId}&superseded_by=is.null&order=fact_key.asc`
  );
  console.log(`Existing facts in memory_facts: ${existingFacts.length}`);
  if (existingFacts.length > 0) {
    for (const f of existingFacts) {
      console.log(`  - ${f.fact_key}: ${f.fact_value}`);
    }
    console.log('');
  }

  // Step 3: Fetch memory_items with personal content
  console.log(`Fetching memory_items (limit ${maxItems}, personal/relationships/high importance)...`);
  const items = await supabaseQuery(
    `memory_items?select=id,content,category_key,importance,source,occurred_at&tenant_id=eq.${tenantId}&user_id=eq.${userId}&order=importance.desc,occurred_at.desc&limit=${maxItems}`
  );

  if (!items || items.length === 0) {
    console.log('No memory_items found. Nothing to backfill.');
    return;
  }

  console.log(`Found ${items.length} memory_items to process\n`);

  // Step 4: Filter to items likely containing facts (user direction, personal categories, high importance)
  const candidateItems = items.filter(item => {
    // Skip very short items
    if (item.content.length < 30) return false;
    // Prefer personal/relationships/high importance
    const isPersonal = ['personal', 'relationships', 'company', 'health', 'preferences'].includes(item.category_key);
    const isHighImportance = item.importance >= 40;
    return isPersonal || isHighImportance;
  });

  console.log(`${candidateItems.length} items pass filtering (personal categories or high importance)\n`);

  // Step 5: Batch items into chunks for extraction (to reduce API calls)
  // Group consecutive items into batches of ~5
  const BATCH_SIZE = 5;
  const batches = [];
  for (let i = 0; i < candidateItems.length; i += BATCH_SIZE) {
    batches.push(candidateItems.slice(i, i + BATCH_SIZE));
  }

  console.log(`Processing ${batches.length} batches...\n`);

  let totalExtracted = 0;
  let totalPersisted = 0;
  let totalFailed = 0;
  const allFacts = new Map(); // fact_key -> fact_value (dedup)

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchText = batch.map(item => item.content).join('\n\n---\n\n');

    process.stdout.write(`  Batch ${batchIdx + 1}/${batches.length} (${batch.length} items)... `);

    try {
      const facts = await extractFacts(batchText);

      if (facts.length === 0) {
        console.log('no facts found');
        continue;
      }

      console.log(`${facts.length} facts extracted`);

      for (const fact of facts) {
        totalExtracted++;

        // Dedup: skip if we've already seen this fact_key with same value
        const existing = allFacts.get(fact.fact_key);
        if (existing === fact.fact_value) {
          console.log(`    [skip] ${fact.fact_key}: "${fact.fact_value}" (duplicate)`);
          continue;
        }
        allFacts.set(fact.fact_key, fact.fact_value);

        if (dryRun) {
          console.log(`    [dry-run] ${fact.fact_key}: "${fact.fact_value}" (entity: ${fact.entity})`);
        } else {
          try {
            await writeFact(tenantId, userId, fact);
            console.log(`    [persisted] ${fact.fact_key}: "${fact.fact_value}"`);
            totalPersisted++;
          } catch (err) {
            console.log(`    [FAILED] ${fact.fact_key}: "${fact.fact_value}" - ${err.message}`);
            totalFailed++;
          }
        }
      }

      // Rate limit: 100ms between batches to avoid hitting Gemini rate limits
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  // Step 6: Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`BACKFILL COMPLETE ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  Items processed: ${candidateItems.length}`);
  console.log(`  Facts extracted: ${totalExtracted}`);
  console.log(`  Unique facts:    ${allFacts.size}`);
  if (!dryRun) {
    console.log(`  Facts persisted: ${totalPersisted}`);
    console.log(`  Facts failed:    ${totalFailed}`);
  }
  console.log('');

  // Show final state
  if (!dryRun) {
    const finalFacts = await supabaseQuery(
      `memory_facts?select=fact_key,fact_value&tenant_id=eq.${tenantId}&user_id=eq.${userId}&superseded_by=is.null&order=fact_key.asc`
    );
    console.log(`Final facts in memory_facts: ${finalFacts.length}`);
    for (const f of finalFacts) {
      console.log(`  - ${f.fact_key}: ${f.fact_value}`);
    }
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
