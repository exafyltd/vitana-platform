#!/usr/bin/env node
/**
 * Knowledge Base i18n Sync Tool
 *
 * English (en/) is the SINGLE SOURCE OF TRUTH for all KB content.
 * All other languages are derived translations that track their source via content hashes.
 *
 * Each translated file stores a `source_content_hash` in its YAML frontmatter.
 * This hash is a SHA-256 prefix of the English article's body content.
 * When the English source changes, the hash no longer matches → translation is outdated.
 *
 * Usage:
 *   node scripts/kb-i18n-sync.mjs check            # Report sync status across all languages
 *   node scripts/kb-i18n-sync.mjs update-hashes     # Stamp current English hashes into translated files
 *   node scripts/kb-i18n-sync.mjs outdated           # List only outdated/missing translations (CI-friendly)
 *
 * Workflow:
 *   1. Edit English articles in en/
 *   2. Run `check` to see which translations are now outdated
 *   3. Update the translations
 *   4. Run `update-hashes` to stamp the new source hashes
 *
 * Exit codes:
 *   0 = all translations up to date
 *   1 = missing or outdated translations found
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const KB_ROOT = join(process.cwd(), 'docs', 'knowledge-base');
const SOURCE_LANG = 'en';
const TARGET_LANGS = ['de']; // Add new languages here: ['de', 'fr', 'es', ...]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkMd(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkMd(full));
    } else if (entry.endsWith('.md')) {
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * Split a markdown file into frontmatter lines and body.
 * Returns null if the file doesn't have valid YAML frontmatter.
 */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const closingIdx = lines.indexOf('---', 1);
  if (closingIdx === -1) return null;
  return {
    fmLines: lines.slice(1, closingIdx),
    body: lines.slice(closingIdx + 1).join('\n'),
  };
}

function getFmValue(fmLines, key) {
  for (const line of fmLines) {
    const m = line.match(new RegExp(`^${key}:\\s*"?([^"]*)"?\\s*$`));
    if (m) return m[1];
  }
  return null;
}

function setFmValue(fmLines, key, value) {
  const idx = fmLines.findIndex((l) => l.startsWith(`${key}:`));
  const newLine = `${key}: "${value}"`;
  if (idx !== -1) {
    fmLines[idx] = newLine;
  } else {
    // Insert before related (or at end) to keep consistent ordering
    const relIdx = fmLines.findIndex((l) => l.startsWith('related:'));
    if (relIdx !== -1) {
      fmLines.splice(relIdx, 0, newLine);
    } else {
      fmLines.push(newLine);
    }
  }
  return fmLines;
}

function hashBody(body) {
  return createHash('sha256').update(body.trim()).digest('hex').substring(0, 16);
}

function reassemble(fmLines, body) {
  return `---\n${fmLines.join('\n')}\n---\n${body}`;
}

function targetPath(sourceFile, targetLang) {
  const rel = relative(join(KB_ROOT, SOURCE_LANG), sourceFile);
  return join(KB_ROOT, targetLang, rel);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function check({ quiet = false } = {}) {
  const sourceFiles = walkMd(join(KB_ROOT, SOURCE_LANG));
  const results = { missing: [], outdated: [], ok: [], errors: [] };

  for (const lang of TARGET_LANGS) {
    for (const src of sourceFiles) {
      const tgt = targetPath(src, lang);
      const rel = relative(KB_ROOT, src);

      const srcContent = readFileSync(src, 'utf-8');
      const srcParsed = parseFrontmatter(srcContent);
      if (!srcParsed) {
        results.errors.push({ file: rel, error: 'Bad source frontmatter' });
        continue;
      }

      const srcHash = hashBody(srcParsed.body);

      if (!existsSync(tgt)) {
        results.missing.push({ source: rel, lang, hash: srcHash });
        continue;
      }

      const tgtContent = readFileSync(tgt, 'utf-8');
      const tgtParsed = parseFrontmatter(tgtContent);
      if (!tgtParsed) {
        results.errors.push({ file: relative(KB_ROOT, tgt), error: 'Bad target frontmatter' });
        continue;
      }

      const stored = getFmValue(tgtParsed.fmLines, 'source_content_hash');
      if (!stored || stored !== srcHash) {
        results.outdated.push({
          source: rel,
          target: relative(KB_ROOT, tgt),
          lang,
          stored: stored || '(none)',
          current: srcHash,
        });
      } else {
        results.ok.push({ source: rel, lang });
      }
    }
  }

  if (!quiet) {
    console.log('\n=== KB Translation Sync Check ===\n');

    if (results.missing.length) {
      console.log(`MISSING (${results.missing.length} need translation):`);
      results.missing.forEach((r) => console.log(`  ${r.source} -> ${r.lang}/`));
      console.log();
    }

    if (results.outdated.length) {
      console.log(`OUTDATED (${results.outdated.length} need re-translation):`);
      results.outdated.forEach((r) => console.log(`  ${r.target}  (${r.stored} -> ${r.current})`));
      console.log();
    }

    if (results.ok.length) {
      console.log(`UP TO DATE: ${results.ok.length} articles\n`);
    }

    if (results.errors.length) {
      console.log(`ERRORS (${results.errors.length}):`);
      results.errors.forEach((r) => console.log(`  ${r.file}: ${r.error}`));
      console.log();
    }

    const total = results.missing.length + results.outdated.length + results.ok.length;
    console.log(`Total: ${total} articles checked, ${TARGET_LANGS.length} target lang(s)`);
    console.log(`  ${results.ok.length} up to date, ${results.outdated.length} outdated, ${results.missing.length} missing`);
  }

  if (results.missing.length || results.outdated.length) {
    if (!quiet) {
      console.log('\nRun translations for outdated/missing articles, then:');
      console.log('  node scripts/kb-i18n-sync.mjs update-hashes\n');
    }
    return { code: 1, results };
  }
  return { code: 0, results };
}

function updateHashes() {
  const sourceFiles = walkMd(join(KB_ROOT, SOURCE_LANG));
  let updated = 0;
  let skipped = 0;

  for (const lang of TARGET_LANGS) {
    for (const src of sourceFiles) {
      const tgt = targetPath(src, lang);
      if (!existsSync(tgt)) {
        skipped++;
        continue;
      }

      const srcContent = readFileSync(src, 'utf-8');
      const srcParsed = parseFrontmatter(srcContent);
      if (!srcParsed) continue;

      const srcHash = hashBody(srcParsed.body);

      const tgtContent = readFileSync(tgt, 'utf-8');
      const tgtParsed = parseFrontmatter(tgtContent);
      if (!tgtParsed) continue;

      const stored = getFmValue(tgtParsed.fmLines, 'source_content_hash');
      if (stored === srcHash) {
        skipped++;
        continue;
      }

      setFmValue(tgtParsed.fmLines, 'source_content_hash', srcHash);
      writeFileSync(tgt, reassemble(tgtParsed.fmLines, tgtParsed.body), 'utf-8');
      updated++;
      console.log(`Stamped: ${relative(KB_ROOT, tgt)}`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Already current: ${skipped}`);
}

function outdated() {
  const { results } = check({ quiet: true });
  const all = [...results.missing, ...results.outdated];
  if (all.length === 0) {
    console.log('All translations are up to date.');
    process.exit(0);
  }
  all.forEach((r) => {
    if ('stored' in r) {
      console.log(`OUTDATED  ${r.target}`);
    } else {
      console.log(`MISSING   ${r.source} -> ${r.lang}/`);
    }
  });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cmd = process.argv[2];
switch (cmd) {
  case 'check':
    check();
    break;
  case 'update-hashes':
    updateHashes();
    break;
  case 'outdated':
    outdated();
    break;
  default:
    console.log('KB i18n Sync Tool');
    console.log('');
    console.log('Usage: node scripts/kb-i18n-sync.mjs <command>');
    console.log('');
    console.log('Commands:');
    console.log('  check          Full sync report (missing, outdated, up to date)');
    console.log('  update-hashes  Stamp current English content hashes into translated files');
    console.log('  outdated       List only outdated/missing files (CI-friendly, exit code 1 if any)');
    process.exit(1);
}
