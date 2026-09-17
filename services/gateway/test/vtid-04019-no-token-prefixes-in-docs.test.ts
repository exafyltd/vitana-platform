/**
 * VTID-04019 (W7a): no credential material in the rules file or the docs.
 *
 * CLAUDE.md §16 printed the first characters of two live GitHub PATs for
 * months — the one file every session force-loads. This scans CLAUDE.md,
 * README.md and every markdown file under docs/ for token-shaped prefixes
 * (GitHub fine-grained/classic PATs, OAuth/app tokens, AWS access key ids,
 * OpenAI/Anthropic-style keys, Supabase service-role JWT prefixes) and fails
 * the build on any hit. Shapes only — nothing in this test is a real token.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const TOKEN_SHAPES: Array<{ name: string; re: RegExp }> = [
  { name: 'GitHub fine-grained PAT', re: /github_pat_[A-Za-z0-9_]{6,}/ },
  { name: 'GitHub classic token', re: /\bgh[pousr]_[A-Za-z0-9]{6,}/ },
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{12,}\b/ },
  { name: 'OpenAI/Anthropic-style key', re: /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/ },
  { name: 'JWT (three base64url segments)', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...markdownFiles(p)); }
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

export function findTokenShapes(text: string): Array<{ name: string; excerpt: string }> {
  const hits: Array<{ name: string; excerpt: string }> = [];
  for (const shape of TOKEN_SHAPES) {
    const m = shape.re.exec(text);
    if (m) hits.push({ name: shape.name, excerpt: `${m[0].slice(0, 6)}…` });
  }
  return hits;
}

describe('VTID-04019: no token-shaped strings in CLAUDE.md, README.md or docs/', () => {
  const files = [path.join(REPO_ROOT, 'CLAUDE.md'), path.join(REPO_ROOT, 'README.md'), ...markdownFiles(path.join(REPO_ROOT, 'docs'))]
    .filter((f) => fs.existsSync(f));

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [path.relative(REPO_ROOT, f), f]))('%s carries no credential material', (_rel, abs) => {
    const hits = findTokenShapes(fs.readFileSync(abs, 'utf8'));
    expect(hits).toEqual([]);
  });

  it('CLAUDE.md §16 explains where the tokens live instead of printing them', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('### GitHub access for API operations (VTID-04019 — no token material in this file)');
    expect(text).not.toContain('### GitHub PATs for API Access');
    expect(text).toMatch(/GITHUB_SAFE_MERGE_TOKEN`\)\*\* — AWS Secrets Manager/);
    expect(text).toMatch(/treat it as leaked/);
  });

  it('the detector itself recognises the shapes it is meant to (fixtures, not real tokens)', () => {
    expect(findTokenShapes('token github_pat_ABCDEFGHIJKLMNOP here').map((h) => h.name)).toEqual(['GitHub fine-grained PAT']);
    expect(findTokenShapes('ghp_ABCDEFGHIJ1234').map((h) => h.name)).toEqual(['GitHub classic token']);
    expect(findTokenShapes('AKIAABCDEFGHIJKLMNOP').map((h) => h.name)).toEqual(['AWS access key id']);
    expect(findTokenShapes('sk-ant-abcdefghijklmnopqrstuvwxyz').map((h) => h.name)).toEqual(['OpenAI/Anthropic-style key']);
    expect(findTokenShapes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop').map((h) => h.name)).toEqual(['JWT (three base64url segments)']);
    expect(findTokenShapes('GITHUB_SAFE_MERGE_TOKEN, FRONTEND_DEPLOY_TOKEN, `github_pat_…` in prose')).toEqual([]);
  });
});
