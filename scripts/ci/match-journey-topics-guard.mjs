#!/usr/bin/env node
/**
 * B0b acceptance check #7: match-journey OASIS topic strings appear
 * ONLY in central telemetry modules.
 *
 * Scans `services/gateway/src/` for raw string literals matching:
 *   - assistant.context.match_journey.*
 *   - assistant.continuation.match_journey.*
 *   - assistant.match.*
 *
 * The ONLY files allowed to contain these strings:
 *   - services/gateway/src/orb/context/telemetry.ts (B0b)
 *   - services/gateway/src/services/assistant-continuation/telemetry.ts (B0d, future)
 *
 * Plus the test files that exercise the constants.
 *
 * Any other file referencing one of the reserved topic strings as a raw
 * literal fails CI. This prevents naming drift when the concierge ships.
 *
 * Usage: node scripts/ci/match-journey-topics-guard.mjs
 * Exit code 1 on violation (CI fails).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC_ROOTS = ['services/gateway/src'];
const TOPIC_PATTERN = /['"`]assistant\.(context\.match_journey|continuation\.match_journey|match)\.[\w_]+['"`]/g;

const ALLOWED_FILES = new Set([
  'services/gateway/src/orb/context/telemetry.ts',
  'services/gateway/src/services/assistant-continuation/telemetry.ts', // future B0d
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__snapshots__']);
const ALLOWED_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) {
      walk(path, out);
    } else if (s.isFile()) {
      const ext = path.slice(path.lastIndexOf('.'));
      if (ALLOWED_EXT.has(ext)) out.push(path);
    }
  }
  return out;
}

const violations = [];

for (const root of SRC_ROOTS) {
  const absRoot = join(ROOT, root);
  let files;
  try {
    files = walk(absRoot);
  } catch (err) {
    console.error(`[match-journey-topics-guard] could not walk ${absRoot}: ${err.message}`);
    process.exit(1);
  }

  for (const file of files) {
    const rel = file.startsWith(ROOT + '/') ? file.slice(ROOT.length + 1) : file;
    if (ALLOWED_FILES.has(rel)) continue;
    const content = readFileSync(file, 'utf8');
    const matches = content.match(TOPIC_PATTERN);
    if (matches) {
      for (const m of matches) {
        violations.push({ file: rel, literal: m });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('');
  console.error('❌ match-journey OASIS topic guard failed.');
  console.error('   Reserved topic strings appeared in files outside the central registry.');
  console.error('   Import the named constant from one of the allowed telemetry modules instead.');
  console.error('');
  for (const v of violations) {
    console.error(`   ${v.file}: ${v.literal}`);
  }
  console.error('');
  console.error('   Allowed files:');
  for (const f of ALLOWED_FILES) {
    console.error(`     ${f}`);
  }
  console.error('');
  process.exit(1);
}

console.log('✅ match-journey OASIS topic guard passed — no stray literals.');
