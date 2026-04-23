/**
 * secret-exposure-scanner-v1
 *
 * Regex-scans for hardcoded secrets. Each pattern has a name + a regex + an
 * optional false-positive guard (strings that, if present in the match, mean
 * we treat it as a placeholder rather than a live key).
 *
 * Excludes:
 *   - Files matching test fixture conventions (*.test.ts, *.spec.ts, fixtures/*)
 *   - Files in .git, node_modules (via walk's SKIP_SEGMENTS).
 *   - Lines containing `// secret-allow` sentinel.
 *
 * When the match looks like a clear placeholder (xxx, YOUR_KEY_HERE, dummy),
 * it's silently skipped so the scan doesn't flood.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo, SOURCE_EXTS } from './_shared.mjs';

export const meta = {
  scanner: 'secret-exposure-scanner-v1',
  signal_type: 'secret_exposure',
};

const PATTERNS = [
  {
    name: 'Anthropic API key',
    re: /\bsk-ant-[a-zA-Z0-9_-]{20,}/g,
  },
  {
    name: 'OpenAI API key',
    re: /\bsk-[a-zA-Z0-9]{20,}(?!-ant)/g,
    ignore: /\bsk-(ant|test|proj|live|fake|mock)-/,
  },
  {
    name: 'GitHub Personal Access Token',
    re: /\bghp_[a-zA-Z0-9]{30,}/g,
  },
  {
    name: 'GitHub fine-grained PAT',
    re: /\bgithub_pat_[A-Z0-9_]{40,}/g,
  },
  {
    name: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{30,}/g,
  },
  {
    name: 'Slack token',
    re: /\bxox[bapr]-[0-9A-Za-z-]{10,}/g,
  },
  {
    name: 'AWS access key id',
    re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'Stripe live key',
    re: /\bsk_live_[0-9a-zA-Z]{20,}/g,
  },
  {
    name: 'JWT with signing payload',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: 'URL with embedded credentials',
    re: /\b(?:https?|postgres|postgresql|mysql|mongodb):\/\/[^\s'"`]*:[^\s'"`@/]+@[^\s'"`]+/g,
  },
];

// Treat a hit as a false positive if the match contains any of these.
const GLOBAL_PLACEHOLDER_HINTS = [
  'xxx', 'xxxxx', 'YOUR_', 'PLACEHOLDER', 'EXAMPLE', 'DUMMY', 'FAKE',
  'MOCK', '<', '>', 'REDACTED', '...', 'replace-me', 'change-me',
];

function isPlaceholder(match) {
  const up = match.toUpperCase();
  return GLOBAL_PLACEHOLDER_HINTS.some(h => up.includes(h.toUpperCase()));
}

function isExcludedFile(rel) {
  if (/\.test\.(ts|tsx|js|mjs)$/.test(rel)) return true;
  if (/\.spec\.(ts|tsx|js|mjs)$/.test(rel)) return true;
  if (rel.includes('/fixtures/')) return true;
  if (rel.includes('/__fixtures__/')) return true;
  if (rel.includes('/__mocks__/')) return true;
  if (rel.includes('/mocks/')) return true;
  if (rel.endsWith('.snap')) return true;
  // .env.example / .env.template intentionally contain template strings that
  // look like credentials — they're documentation, not secrets. Real .env
  // files are gitignored.
  if (/\.env\.example$/.test(rel) || /\.env\.template$/.test(rel)) return true;
  // e2e test harness files may embed known test-user JWTs for Supabase auth.
  // These are public test fixtures, not real credentials.
  if (rel.startsWith('e2e/')) return true;
  return false;
}

export async function run({ repoRoot }) {
  // Scan more broadly than SCAN_ROOTS — secrets can land anywhere including
  // root-level scripts, .github workflows, etc.
  const roots = [
    'services',
    'scripts',
    '.github',
    'supabase/migrations',
    'e2e',
    'kb',
    'docs',
  ];
  const signals = [];
  for (const r of roots) {
    const abs = path.join(repoRoot, r);
    if (!fs.existsSync(abs)) continue;
    const files = walk(abs);
    for (const file of files) {
      const rel = relFromRepo(repoRoot, file);
      if (isExcludedFile(rel)) continue;
      const ext = path.extname(file);
      // Skip binaries and lock files
      if (ext === '.lock' || file.endsWith('package-lock.json') || file.endsWith('pnpm-lock.yaml')) continue;
      if (!SOURCE_EXTS.has(ext) && !['.yml','.yaml','.json','.md','.sh','.sql','.env','.example','.txt',''].includes(ext)) continue;

      const src = readFileSafe(file);
      if (!src) continue;
      if (src.length > 500_000) continue; // skip huge files

      for (const pattern of PATTERNS) {
        pattern.re.lastIndex = 0;
        let m;
        while ((m = pattern.re.exec(src)) !== null) {
          const match = m[0];
          if (pattern.ignore && pattern.ignore.test(match)) continue;
          if (isPlaceholder(match)) continue;
          // Skip lines with opt-out sentinel
          const lineStart = src.lastIndexOf('\n', m.index) + 1;
          const lineEnd = src.indexOf('\n', m.index);
          const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
          if (/\bsecret-allow\b/.test(line)) continue;
          const lineNumber = src.slice(0, m.index).split('\n').length;
          // Emit just enough to review but not the full secret — show first 8 chars + length.
          const preview = match.length > 12
            ? `${match.slice(0, 8)}…(${match.length - 8} more)`
            : match;
          signals.push({
            type: 'secret_exposure',
            severity: 'high',
            file_path: rel,
            line_number: lineNumber,
            message: `${pattern.name} appears hardcoded in ${rel}:${lineNumber} (preview: ${preview}).`,
            suggested_action: `Move this secret to a Cloud Run secret binding or a Supabase Studio env var, then replace the literal with process.env.X. If this is a known false positive, append \`// secret-allow\` to the line.`,
            scanner: 'secret-exposure-scanner-v1',
            raw: { pattern: pattern.name, preview },
          });
          // One signal per file+pattern is enough — break out of the pattern loop.
          break;
        }
      }
    }
  }
  return signals;
}
