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

// Parse the SQL file to extract upsert_knowledge_doc calls
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

let success = 0;
let failed = 0;

for (const art of articles) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_knowledge_doc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_ROLE,
      "Authorization": `Bearer ${SERVICE_ROLE}`,
      "Prefer": "return=representation",
    },
    body: JSON.stringify({
      p_title: art.title,
      p_path: art.path,
      p_content: art.content,
      p_source_type: art.sourceType,
      p_tags: art.tags,
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
