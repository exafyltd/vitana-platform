#!/usr/bin/env node
/**
 * Seeds knowledge_docs via Supabase REST API (HTTPS — works from Cloud Shell).
 *
 * Usage:
 *   export SUPABASE_SERVICE_ROLE=$(gcloud secrets versions access latest --secret=SUPABASE_SERVICE_ROLE --project=lovable-vitana-vers1)
 *   node scripts/seed-kb-rest.mjs
 */
import { readFileSync } from "fs";

const SUPABASE_URL = "https://inmkhvwdcuyhnxkgfvsb.supabase.co";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SERVICE_ROLE) {
  console.error("Missing SUPABASE_SERVICE_ROLE. Run:\n  export SUPABASE_SERVICE_ROLE=$(gcloud secrets versions access latest --secret=SUPABASE_SERVICE_ROLE --project=lovable-vitana-vers1)");
  process.exit(1);
}

// Step 1: Fix the upsert_knowledge_doc function (missing updated_at value)
console.log("Patching upsert_knowledge_doc function...");
const fixSQL = `
CREATE OR REPLACE FUNCTION public.upsert_knowledge_doc(
  p_title text,
  p_path text,
  p_content text,
  p_source_type text DEFAULT 'markdown',
  p_tags text[] DEFAULT '{}'
)
RETURNS uuid AS $$
DECLARE
  result_id uuid;
BEGIN
  INSERT INTO public.knowledge_docs (title, path, content, source_type, tags, word_count, updated_at)
  VALUES (
    p_title,
    p_path,
    p_content,
    p_source_type,
    p_tags,
    array_length(regexp_split_to_array(p_content, '\\s+'), 1),
    now()
  )
  ON CONFLICT (path) DO UPDATE SET
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    source_type = EXCLUDED.source_type,
    tags = EXCLUDED.tags,
    word_count = array_length(regexp_split_to_array(EXCLUDED.content, '\\s+'), 1),
    updated_at = now()
  RETURNING id INTO result_id;

  RETURN result_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
`;

const fixRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "apikey": SERVICE_ROLE,
    "Authorization": `Bearer ${SERVICE_ROLE}`,
  },
  body: JSON.stringify({ query: fixSQL }),
});

// If RPC doesn't support raw SQL, patch via the query endpoint
if (!fixRes.ok) {
  // Use the Supabase SQL endpoint (management API alternative)
  const patchRes = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_ROLE,
      "Authorization": `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ query: fixSQL }),
  });
  if (!patchRes.ok) {
    console.warn("Could not auto-patch function. Falling back to direct table upsert.\n");
  } else {
    console.log("Function patched successfully.\n");
  }
}

// Step 2: Parse the SQL file to extract upsert_knowledge_doc calls
const sql = readFileSync(new URL("../scripts/kb-seed.sql", import.meta.url), "utf8");

const articles = [];
const pattern = /SELECT upsert_knowledge_doc\(\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)',\s*\$kb\$([\s\S]*?)\$kb\$,\s*'((?:[^']|'')+)',\s*ARRAY\[([\s\S]*?)\]\s*\)/g;

let match;
while ((match = pattern.exec(sql)) !== null) {
  const title = match[1].replace(/''/g, "'");
  const path = match[2].replace(/''/g, "'");
  const content = match[3];
  const sourceType = match[4].replace(/''/g, "'");
  const tagsRaw = match[5];
  const tags = tagsRaw.match(/'([^']+)'/g)?.map(t => t.slice(1, -1)) || [];
  articles.push({ title, path, content, sourceType, tags });
}

console.log(`Parsed ${articles.length} articles from kb-seed.sql`);

// Step 3: Upsert directly into the table via PostgREST (bypasses the broken function)
let success = 0;
let failed = 0;

for (const art of articles) {
  const wordCount = art.content.trim().split(/\s+/).length;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/knowledge_docs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_ROLE,
      "Authorization": `Bearer ${SERVICE_ROLE}`,
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      title: art.title,
      path: art.path,
      content: art.content,
      source_type: art.sourceType,
      tags: art.tags,
      word_count: wordCount,
      updated_at: new Date().toISOString(),
    }),
  });

  if (res.ok) {
    success++;
    if (success % 20 === 0) console.log(`  ... ${success} done`);
  } else {
    failed++;
    const body = await res.text();
    console.error(`FAIL [${res.status}] ${art.path}: ${body}`);
  }
}

console.log(`\nDone: ${success} succeeded, ${failed} failed (of ${articles.length} total)`);
