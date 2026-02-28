#!/usr/bin/env node
/**
 * Sync Knowledge Base articles to the knowledge_docs table in Supabase.
 *
 * Reads all .md files from docs/knowledge-base/en/, parses YAML frontmatter,
 * and upserts each article into knowledge_docs via the upsert_knowledge_doc RPC.
 *
 * The knowledge_docs table uses PostgreSQL full-text search (tsvector) for retrieval.
 * The ORB's context-pack-builder queries this table via search_knowledge_docs RPC.
 *
 * Usage:
 *   node scripts/sync-kb-to-knowledge-hub.mjs                  # Sync all articles
 *   node scripts/sync-kb-to-knowledge-hub.mjs --dry-run        # Preview without writing
 *   node scripts/sync-kb-to-knowledge-hub.mjs --section 01     # Sync one section only
 *   node scripts/sync-kb-to-knowledge-hub.mjs --verbose        # Show detailed output
 *
 * Environment:
 *   SUPABASE_URL            - Supabase project URL (required)
 *   SUPABASE_SERVICE_ROLE   - Service role key (required)
 *
 * These can be set via environment variables or a .env file in the project root.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KB_ROOT = join(process.cwd(), 'docs', 'knowledge-base', 'en');
const CONCURRENCY = 5;
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Env loading (supports .env file)
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let val = trimmed.substring(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }

  // Also try services/gateway/.env
  const gwEnvPath = join(process.cwd(), 'services', 'gateway', '.env');
  if (existsSync(gwEnvPath)) {
    const lines = readFileSync(gwEnvPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let val = trimmed.substring(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function walkMd(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkMd(full));
    } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
      files.push(full);
    }
  }
  return files.sort();
}

function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const closingIdx = lines.indexOf('---', 1);
  if (closingIdx === -1) return null;
  const fmLines = lines.slice(1, closingIdx);
  const body = lines.slice(closingIdx + 1).join('\n').trim();

  // Simple YAML parser for flat key-value pairs
  const fm = {};
  for (const line of fmLines) {
    // Handle arrays: tags: ["tag1", "tag2"]
    const arrayMatch = line.match(/^(\w+):\s*\[([^\]]*)\]/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const values = arrayMatch[2]
        .split(',')
        .map(v => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      fm[key] = values;
      continue;
    }
    // Handle scalar: key: "value" or key: value
    const scalarMatch = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (scalarMatch) {
      fm[scalarMatch[1]] = scalarMatch[2];
    }
  }
  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Supabase RPC
// ---------------------------------------------------------------------------

async function upsertDoc(supabaseUrl, serviceRole, { title, path, content, sourceType, tags }) {
  const url = `${supabaseUrl}/rest/v1/rpc/upsert_knowledge_doc`;

  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: serviceRole,
          Authorization: `Bearer ${serviceRole}`,
        },
        body: JSON.stringify({
          p_title: title,
          p_path: path,
          p_content: content,
          p_source_type: sourceType,
          p_tags: tags,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const docId = await res.json();
      return { ok: true, id: docId };
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function runConcurrent(items, fn, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const sectionIdx = args.indexOf('--section');
  const sectionFilter = sectionIdx !== -1 ? args[sectionIdx + 1] : null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE;

  if (!dryRun && (!supabaseUrl || !serviceRole)) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE are required.');
    console.error('Set them as environment variables or in .env / services/gateway/.env');
    process.exit(1);
  }

  // Find all KB articles
  let files = walkMd(KB_ROOT);
  if (sectionFilter) {
    files = files.filter(f => {
      const rel = relative(KB_ROOT, f);
      return rel.startsWith(sectionFilter);
    });
  }

  console.log(`\n=== Sync KB to knowledge_docs ===\n`);
  console.log(`Source: docs/knowledge-base/en/`);
  console.log(`Target: knowledge_docs table via upsert_knowledge_doc RPC`);
  console.log(`Articles found: ${files.length}`);
  if (sectionFilter) console.log(`Section filter: ${sectionFilter}`);
  if (dryRun) console.log(`Mode: DRY RUN (no writes)`);
  console.log();

  // Parse all articles
  const articles = [];
  const parseErrors = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const parsed = parseFrontmatter(content);
    const relPath = relative(KB_ROOT, file);

    if (!parsed || !parsed.frontmatter.id || !parsed.frontmatter.title) {
      parseErrors.push({ file: relPath, error: 'Missing frontmatter (id or title)' });
      continue;
    }

    const fm = parsed.frontmatter;

    // Build the path for upsert (use article ID as unique key)
    const docPath = `kb/${relPath}`;

    // Build tags: combine frontmatter tags with category and tenant
    const tags = [
      ...(Array.isArray(fm.tags) ? fm.tags : []),
      fm.category || '',
      fm.tenant || 'all',
      fm.status || 'live',
    ].filter(Boolean);

    articles.push({
      filePath: relPath,
      title: fm.title,
      path: docPath,
      content: parsed.body,
      sourceType: 'markdown',
      tags,
      id: fm.id,
    });
  }

  if (parseErrors.length) {
    console.log(`Parse errors (${parseErrors.length}):`);
    parseErrors.forEach(e => console.log(`  ${e.file}: ${e.error}`));
    console.log();
  }

  if (dryRun) {
    console.log(`Would upsert ${articles.length} articles:\n`);
    for (const a of articles) {
      const wordCount = a.content.split(/\s+/).length;
      console.log(`  ${a.id.padEnd(14)} ${a.title.substring(0, 50).padEnd(52)} ${wordCount} words  [${a.tags.slice(0, 3).join(', ')}]`);
    }
    console.log(`\nDry run complete. Run without --dry-run to sync.`);
    return;
  }

  // Upsert all articles
  const startTime = Date.now();
  let succeeded = 0;
  let failed = 0;

  const results = await runConcurrent(
    articles,
    async (article, i) => {
      const result = await upsertDoc(supabaseUrl, serviceRole, article);
      if (result.ok) {
        succeeded++;
        if (verbose) {
          console.log(`  [${i + 1}/${articles.length}] OK  ${article.id} - ${article.title}`);
        }
      } else {
        failed++;
        console.log(`  [${i + 1}/${articles.length}] ERR ${article.id} - ${result.error}`);
      }
      return result;
    },
    CONCURRENCY
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n=== Sync Complete ===\n`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Skipped:   ${parseErrors.length}`);
  console.log(`  Time:      ${elapsed}s`);
  console.log();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
