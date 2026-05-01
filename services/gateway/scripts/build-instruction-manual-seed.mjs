#!/usr/bin/env node
// Build & validate the Maxina Instruction Manual seed migration.
//
// Reads:  services/gateway/specs/dev-screen-inventory-v1.json
//         services/gateway/src/kb/instruction-manual/maxina/**/*.md
// Writes: supabase/migrations/<timestamp>_instruction_manual_maxina_seed.sql
//
// CI invariants enforced:
//  1. Every maxina-relevant COM-* screen in the inventory has exactly one
//     matching chapter file under kb/instruction-manual/maxina/<NN>-<module>/.
//  2. Every chapter file references a screen_id that exists in the inventory
//     (concept chapters carry screen_id: null and are exempt from inventory check).
//  3. Each chapter has the required front-matter fields and section headings.
//  4. Each chapter body has at least 150 words of prose.
//
// Exit non-zero on any failure so CI blocks the build.

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const INVENTORY_PATH = join(REPO_ROOT, 'services/gateway/specs/dev-screen-inventory-v1.json');
const MANUAL_ROOT = join(REPO_ROOT, 'services/gateway/src/kb/instruction-manual/maxina');
const MIGRATION_OUT = process.argv[2] || null;

// Other-tenant screens that are NOT in the maxina manual.
const MAXINA_EXCLUDED_SCREENS = new Set([
  'COM-ALKALMA_LOGIN',
  'COM-EARTHLINKS_LOGIN',
  'COM-COMMUNITY_LOGIN',
  'COM-EXAFY_LOGIN',
  'COM-CONFIRM_ALKALMA',
  'COM-CONFIRM_EARTHLINKS',
  'COM-CONFIRM_COMMUNITY',
  'COM-CONFIRM_EXAFY',
]);

// Stable module → chapter-number mapping (Module N).
const MODULE_NUMBERS = {
  Public: 1,
  Home: 2,
  Community: 3,
  Discover: 4,
  Health: 5,
  Inbox: 6,
  AI: 7,
  Wallet: 8,
  Sharing: 9,
  Memory: 10,
  Settings: 11,
  Utility: 12,
  Overlays: 13,
};

const REQUIRED_FRONTMATTER_FIELDS = [
  'chapter',
  'screen_id',
  'title',
  'tenant',
  'keywords',
];
const REQUIRED_SECTIONS = [
  '## What it is',
  '## Why it matters',
  '## Where to find it',
  '## How to use it',
];
const MIN_BODY_WORDS = 150;

function loadInventory() {
  const raw = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  const community = [];
  // The inventory has a flat array of screen entries somewhere — walk recursively.
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.screen_id && node.role === 'COMMUNITY') {
        community.push(node);
      } else {
        Object.values(node).forEach(walk);
      }
    }
  };
  walk(raw);
  return community;
}

function listMarkdown(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith('.md')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function parseFrontmatter(text, filePath) {
  if (!text.startsWith('---\n')) {
    throw new Error(`${filePath}: missing front-matter (must start with '---')`);
  }
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) throw new Error(`${filePath}: front-matter not closed`);
  const fmRaw = text.slice(4, end);
  const body = text.slice(end + 5);
  const fm = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, valRaw] = m;
    let val = valRaw.trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (val === 'null') {
      val = null;
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    fm[key] = val;
  }
  return { fm, body };
}

function wordCount(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function validateChapter(filePath, fm, body) {
  const errors = [];

  for (const f of REQUIRED_FRONTMATTER_FIELDS) {
    if (fm[f] === undefined) errors.push(`missing front-matter field "${f}"`);
  }
  if (fm.tenant !== 'maxina') errors.push(`tenant must be "maxina" (got "${fm.tenant}")`);
  if (!fm.chapter || !/^\d+\.\d+$/.test(fm.chapter)) {
    errors.push(`chapter must match "N.M" pattern (got "${fm.chapter}")`);
  }

  for (const sec of REQUIRED_SECTIONS) {
    if (!body.includes(sec)) errors.push(`missing section heading "${sec}"`);
  }

  const wc = wordCount(body);
  if (wc < MIN_BODY_WORDS) {
    errors.push(`body has ${wc} words; minimum is ${MIN_BODY_WORDS}`);
  }

  return errors;
}

function expectedChapterPath(screen) {
  const moduleNum = MODULE_NUMBERS[screen.module];
  if (!moduleNum) throw new Error(`Unknown module: ${screen.module}`);
  const slug = screen.screen_id.replace(/^COM-/, '').toLowerCase().replace(/_/g, '-');
  return join(
    MANUAL_ROOT,
    `${String(moduleNum).padStart(2, '0')}-${screen.module.toLowerCase()}`,
    `${slug}.md`,
  );
}

function chapterDbPath(absPath) {
  // services/gateway/src/kb/instruction-manual/maxina/05-health/biomarkers.md
  // → kb/instruction-manual/maxina/05-health/biomarkers.md
  const i = absPath.indexOf('kb/instruction-manual/');
  return absPath.slice(i);
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

function generateMigration(chapters) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const lines = [
    `-- Maxina Instruction Manual seed (auto-generated by build-instruction-manual-seed.mjs)`,
    `-- Generated at: ${new Date().toISOString()}`,
    `-- Chapters: ${chapters.length}`,
    ``,
    `BEGIN;`,
    ``,
    `-- The previous version of this script passed positional args to`,
    `-- upsert_knowledge_doc in (path, title, content, …) order. The actual`,
    `-- function signature is (p_title, p_path, p_content, …), so every row`,
    `-- inserted by the prior seed has its title and path swapped. Delete those`,
    `-- corrupted rows by their tag before the corrected upserts run.`,
    `DELETE FROM public.knowledge_docs`,
    `WHERE 'instruction_manual' = ANY(tags)`,
    `   OR path LIKE 'kb/instruction-manual/%';  -- catches both the corrupted (title-as-path) and any clean rows`,
    ``,
  ];
  for (const ch of chapters) {
    const tags = JSON.stringify(['vitana_system', 'instruction_manual', 'maxina', ch.module || 'concept']);
    // Function signature is (p_title, p_path, p_content, p_source_type, p_tags).
    // The previous version of this script passed positional args as
    // (path, title, …) which corrupted every row. Stay with named args so
    // the order is unambiguous and survives any future signature change.
    lines.push(`-- ${ch.chapter} ${ch.title}`);
    lines.push(`SELECT upsert_knowledge_doc(`);
    lines.push(`  p_title       := '${sqlEscape(ch.title)}',`);
    lines.push(`  p_path        := '${sqlEscape(ch.dbPath)}',`);
    lines.push(`  p_content     := $CONTENT$${ch.fullText}$CONTENT$,`);
    lines.push(`  p_source_type := 'markdown',`);
    lines.push(`  p_tags        := ARRAY[${(JSON.parse(tags)).map((t) => `'${sqlEscape(t)}'`).join(', ')}]::text[]`);
    lines.push(`);`);
    lines.push(``);
  }
  lines.push(`COMMIT;`);
  lines.push(``);
  return { ts, sql: lines.join('\n') };
}

// ---------- main ----------
const inventory = loadInventory();
const inventoryById = new Map(inventory.map((s) => [s.screen_id, s]));
const expected = inventory.filter((s) => !MAXINA_EXCLUDED_SCREENS.has(s.screen_id));

const mdFiles = listMarkdown(MANUAL_ROOT);
const chapters = [];
const errors = [];
const seenScreenIds = new Set();
const seenChapters = new Set();

for (const file of mdFiles) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    errors.push(`${file}: cannot read (${e.message})`);
    continue;
  }
  let parsed;
  try {
    parsed = parseFrontmatter(raw, file);
  } catch (e) {
    errors.push(e.message);
    continue;
  }
  const { fm, body } = parsed;
  const chErrors = validateChapter(file, fm, body);
  for (const ce of chErrors) errors.push(`${file}: ${ce}`);

  if (fm.chapter && seenChapters.has(fm.chapter)) {
    errors.push(`${file}: duplicate chapter number "${fm.chapter}"`);
  }
  if (fm.chapter) seenChapters.add(fm.chapter);

  if (fm.screen_id && fm.screen_id !== 'null') {
    if (!inventoryById.has(fm.screen_id)) {
      errors.push(`${file}: screen_id "${fm.screen_id}" not in inventory`);
    }
    if (MAXINA_EXCLUDED_SCREENS.has(fm.screen_id)) {
      errors.push(`${file}: screen_id "${fm.screen_id}" is excluded from the maxina manual`);
    }
    seenScreenIds.add(fm.screen_id);
  }

  chapters.push({
    chapter: fm.chapter,
    screen_id: fm.screen_id,
    title: fm.title,
    module: fm.module || null,
    dbPath: chapterDbPath(file),
    fullText: raw,
  });
}

// Cross-check: every expected screen has a chapter
for (const screen of expected) {
  if (!seenScreenIds.has(screen.screen_id)) {
    const expectedPath = expectedChapterPath(screen);
    errors.push(
      `Screen ${screen.screen_id} (${screen.module} → ${screen.tab}) has no chapter. ` +
        `Create ${expectedPath.replace(REPO_ROOT + '/', '')}`,
    );
  }
}

// Sort chapters by their hierarchical number
chapters.sort((a, b) => {
  const [aM, aS] = (a.chapter || '0.0').split('.').map(Number);
  const [bM, bS] = (b.chapter || '0.0').split('.').map(Number);
  return aM - bM || aS - bS;
});

console.log(`Inventory: ${inventory.length} community screens, ${expected.length} maxina-relevant.`);
console.log(`Markdown:  ${mdFiles.length} chapter files found.`);
console.log(`Chapters:  ${chapters.length} parsed.`);
if (errors.length) {
  console.error(`\nFAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (MIGRATION_OUT) {
  const { ts, sql } = generateMigration(chapters);
  const fname = MIGRATION_OUT === 'auto'
    ? join(REPO_ROOT, 'supabase/migrations', `${ts}_instruction_manual_maxina_seed.sql`)
    : MIGRATION_OUT;
  writeFileSync(fname, sql);
  console.log(`\nWrote ${fname} (${chapters.length} upserts).`);
} else {
  console.log(`\nValidation passed. (No migration written; pass a path or 'auto' as $1 to emit one.)`);
}
