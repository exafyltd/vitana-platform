#!/usr/bin/env node
/**
 * generate-kb-seed.mjs
 *
 * Reads all 116 Knowledge Base .md articles from docs/knowledge-base/en/,
 * parses their YAML frontmatter, and generates a SQL seed file that calls
 * upsert_knowledge_doc() for each article.
 *
 * Usage: node scripts/generate-kb-seed.mjs
 * Output: scripts/kb-seed.sql
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const KB_ROOT = join(process.cwd(), 'docs/knowledge-base/en');
const OUTPUT_FILE = join(process.cwd(), 'scripts/kb-seed.sql');

/** Simple YAML frontmatter parser (handles our known fields) */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('No frontmatter found');
  }

  const yamlStr = match[1];
  const body = match[2].trim();
  const meta = {};

  for (const line of yamlStr.split('\n')) {
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    // Handle arrays: ["tag1", "tag2", ...]
    if (value.startsWith('[')) {
      try {
        value = JSON.parse(value);
      } catch {
        // Try replacing single quotes with double quotes
        value = JSON.parse(value.replace(/'/g, '"'));
      }
    }
    // Handle quoted strings
    else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // Handle single-quoted strings
    else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    meta[key] = value;
  }

  return { meta, body };
}

/** Recursively find all .md files (excluding _ prefixed) */
async function findMarkdownFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

async function main() {
  const files = await findMarkdownFiles(KB_ROOT);
  console.log(`Found ${files.length} articles`);

  if (files.length !== 116) {
    console.warn(`WARNING: Expected 116 files, found ${files.length}`);
  }

  const sqlParts = [];

  // Header
  sqlParts.push(`-- =============================================================================
-- Knowledge Base Seed: Upsert all ${files.length} articles into knowledge_docs
-- Generated: ${new Date().toISOString().split('T')[0]}
--
-- This file inserts every Knowledge Base article from docs/knowledge-base/en/
-- into the knowledge_docs table via the upsert_knowledge_doc() RPC.
-- Each article's content is dollar-quoted with $kb$...$kb$ to avoid escaping.
-- =============================================================================

BEGIN;
`);

  let count = 0;

  for (const filePath of files) {
    const raw = await readFile(filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);

    const relPath = relative(KB_ROOT, filePath);
    const p_path = `kb/${relPath}`;
    const p_title = (meta.title || '').replace(/'/g, "''");

    // Combine tags + category + tenant + status into one array
    const allTags = [];
    if (Array.isArray(meta.tags)) {
      allTags.push(...meta.tags);
    }
    if (meta.category) allTags.push(meta.category);
    if (meta.tenant) allTags.push(meta.tenant);
    if (meta.status) allTags.push(meta.status);

    // Deduplicate
    const uniqueTags = [...new Set(allTags)];

    // Format tags as SQL array literal
    const tagsLiteral = `ARRAY[${uniqueTags.map(t => `'${t.replace(/'/g, "''")}'`).join(', ')}]`;

    count++;
    sqlParts.push(`-- [${count}/${files.length}] ${meta.id || relPath}
SELECT upsert_knowledge_doc(
  '${p_title}',
  '${p_path.replace(/'/g, "''")}',
  $kb$${body}$kb$,
  'markdown',
  ${tagsLiteral}
);
`);
  }

  // Footer
  sqlParts.push(`-- =============================================================================
-- Verification: Count all knowledge_docs rows
-- =============================================================================
SELECT count(*) AS total_knowledge_docs FROM knowledge_docs;

COMMIT;
`);

  const sql = sqlParts.join('\n');
  await writeFile(OUTPUT_FILE, sql, 'utf-8');
  console.log(`Wrote ${count} upsert calls to ${OUTPUT_FILE}`);
  console.log(`File size: ${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
