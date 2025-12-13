#!/usr/bin/env npx ts-node
/**
 * VTID-0538: Knowledge Hub Doc Ingestion Script
 *
 * Walks selected markdown/text files in the repo and upserts them
 * into the knowledge_docs table in Supabase for full-text search.
 *
 * Sources:
 * - kb/*.json - Vitana KB documents (structured JSON with sections)
 * - docs/**\/*.md - Technical documentation
 * - specs/**\/*.md - Specifications
 * - README.md - Root readme
 *
 * Usage:
 *   npx ts-node scripts/knowledge/ingest-docs.ts
 *   # or with environment variables:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... npx ts-node scripts/knowledge/ingest-docs.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

interface KBSection {
  section_id: string;
  title: string;
  content: string;
  content_markdown?: string;
}

interface KBDocument {
  doc_id: string;
  title: string;
  family_id?: string;
  family_name?: string;
  tags?: string[];
  sections?: KBSection[];
}

interface IngestResult {
  path: string;
  title: string;
  success: boolean;
  error?: string;
}

/**
 * Recursively find files matching a pattern
 */
function findFiles(dir: string, patterns: string[]): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (patterns.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  };

  walk(dir);
  return results;
}

/**
 * Extract content from KB JSON document
 */
function extractKBContent(doc: KBDocument): string {
  const parts: string[] = [];

  // Add title
  parts.push(`# ${doc.title}\n`);

  // Add sections content
  if (doc.sections) {
    for (const section of doc.sections) {
      const content = section.content_markdown || section.content;
      if (content && content.trim()) {
        if (section.title) {
          parts.push(`\n## ${section.title}\n`);
        }
        parts.push(content);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Upsert a document to Supabase
 */
async function upsertDoc(
  title: string,
  docPath: string,
  content: string,
  sourceType: string,
  tags: string[]
): Promise<{ ok: boolean; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    // Use the RPC function for upsert
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_knowledge_doc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify({
        p_title: title,
        p_path: docPath,
        p_content: content,
        p_source_type: sourceType,
        p_tags: tags
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Supabase error: ${response.status} - ${errorText}` };
    }

    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

/**
 * Process KB JSON files
 */
async function processKBFiles(baseDir: string): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  const kbDir = path.join(baseDir, 'kb');

  if (!fs.existsSync(kbDir)) {
    console.log('  No kb/ directory found');
    return results;
  }

  const files = fs.readdirSync(kbDir).filter(f => f.endsWith('.json') && f !== 'index.json');

  for (const file of files) {
    const filePath = path.join(kbDir, file);
    const relativePath = `kb/${file}`;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const doc: KBDocument = JSON.parse(content);

      const extractedContent = extractKBContent(doc);
      const tags = doc.tags || [];
      if (doc.family_name) {
        tags.push(doc.family_name.toLowerCase());
      }

      const result = await upsertDoc(
        doc.title,
        relativePath,
        extractedContent,
        'json-kb',
        tags
      );

      results.push({
        path: relativePath,
        title: doc.title,
        success: result.ok,
        error: result.error
      });

      console.log(`  ${result.ok ? '✓' : '✗'} ${relativePath} - ${doc.title}`);
    } catch (error: any) {
      results.push({
        path: relativePath,
        title: file,
        success: false,
        error: error.message
      });
      console.log(`  ✗ ${relativePath} - Error: ${error.message}`);
    }
  }

  return results;
}

/**
 * Process markdown files from a directory
 */
async function processMarkdownFiles(baseDir: string, subDir: string, sourceType: string): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  const targetDir = path.join(baseDir, subDir);

  if (!fs.existsSync(targetDir)) {
    console.log(`  No ${subDir}/ directory found`);
    return results;
  }

  const files = findFiles(targetDir, ['.md', '.yml', '.yaml']);

  for (const filePath of files) {
    const relativePath = path.relative(baseDir, filePath);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Extract title from first H1 or filename
      let title = path.basename(filePath, path.extname(filePath));
      const h1Match = content.match(/^#\s+(.+)$/m);
      if (h1Match) {
        title = h1Match[1].trim();
      }

      // Extract tags from path
      const tags: string[] = [];
      const pathParts = relativePath.split(path.sep);
      if (pathParts.length > 1) {
        tags.push(pathParts[0]); // e.g., 'docs', 'specs'
        if (pathParts.length > 2) {
          tags.push(pathParts[1]); // e.g., 'vtids', 'governance'
        }
      }

      const result = await upsertDoc(
        title,
        relativePath,
        content,
        sourceType,
        tags
      );

      results.push({
        path: relativePath,
        title,
        success: result.ok,
        error: result.error
      });

      console.log(`  ${result.ok ? '✓' : '✗'} ${relativePath}`);
    } catch (error: any) {
      results.push({
        path: relativePath,
        title: path.basename(filePath),
        success: false,
        error: error.message
      });
      console.log(`  ✗ ${relativePath} - Error: ${error.message}`);
    }
  }

  return results;
}

/**
 * Process root README
 */
async function processRootReadme(baseDir: string): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  const readmePath = path.join(baseDir, 'README.md');

  if (!fs.existsSync(readmePath)) {
    console.log('  No README.md found');
    return results;
  }

  try {
    const content = fs.readFileSync(readmePath, 'utf-8');

    let title = 'Vitana Platform';
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
    }

    const result = await upsertDoc(
      title,
      'README.md',
      content,
      'markdown',
      ['readme', 'root']
    );

    results.push({
      path: 'README.md',
      title,
      success: result.ok,
      error: result.error
    });

    console.log(`  ${result.ok ? '✓' : '✗'} README.md - ${title}`);
  } catch (error: any) {
    results.push({
      path: 'README.md',
      title: 'README',
      success: false,
      error: error.message
    });
  }

  return results;
}

/**
 * Main ingestion function
 */
async function main() {
  console.log('VTID-0538: Knowledge Hub Doc Ingestion');
  console.log('=====================================\n');

  // Check environment
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE environment variables are required');
    console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... npx ts-node scripts/knowledge/ingest-docs.ts');
    process.exit(1);
  }

  const baseDir = path.resolve(__dirname, '../..');
  console.log(`Base directory: ${baseDir}\n`);

  const allResults: IngestResult[] = [];

  // Process KB JSON files
  console.log('Processing KB documents (kb/*.json):');
  const kbResults = await processKBFiles(baseDir);
  allResults.push(...kbResults);
  console.log();

  // Process docs
  console.log('Processing documentation (docs/**/*.md):');
  const docsResults = await processMarkdownFiles(baseDir, 'docs', 'markdown');
  allResults.push(...docsResults);
  console.log();

  // Process specs
  console.log('Processing specifications (specs/**/*):');
  const specsResults = await processMarkdownFiles(baseDir, 'specs', 'spec');
  allResults.push(...specsResults);
  console.log();

  // Process root README
  console.log('Processing root README:');
  const readmeResults = await processRootReadme(baseDir);
  allResults.push(...readmeResults);
  console.log();

  // Summary
  const succeeded = allResults.filter(r => r.success).length;
  const failed = allResults.filter(r => !r.success).length;

  console.log('=====================================');
  console.log(`Ingestion complete: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailed documents:');
    for (const result of allResults.filter(r => !r.success)) {
      console.log(`  - ${result.path}: ${result.error}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
