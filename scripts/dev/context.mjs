#!/usr/bin/env node
/**
 * context.mjs — find the right context in vitana-platform + vitana-v1 in one command (plan context-map).
 *
 * Read-only and git-only: every answer is a list of `file:line` links into the source of truth (the code, the rule
 * files, git history, the spec and validation folders). Nothing is copied into a second document, so nothing here can
 * go stale on its own; `check` reports the places where the linked sources themselves point at things that are gone.
 *
 *   node scripts/dev/context.mjs route  <url path>      gateway: mount → router file:line → handler; atlas domain; tests
 *   node scripts/dev/context.mjs screen <url path>      vitana-v1: App.tsx route → page file; nav registry, manifest, parity
 *   node scripts/dev/context.mjs domain <word>          the developer atlas entry (route files, code, tables, flags, docs)
 *   node scripts/dev/context.mjs vtid   <VTID-xxxxx>    prior work: commits (both repos), specs/lanes, validation, changelog
 *   node scripts/dev/context.mjs why    <term>          rules and decisions that mention a term, with their headings
 *   node scripts/dev/context.mjs uses   <file>          who imports a file (code / tests) and which rule files name it
 *   node scripts/dev/context.mjs check  [--strict]      stale links: atlas pointers, rule-file paths, CONTEXT-MAP, indexes
 *
 * Options: --json (machine output), --prs (vtid: also search PRs with `gh api`), --v1 <dir> / VITANA_V1_DIR,
 * --platform <dir>. Map of questions to commands and sources: docs/CONTEXT-MAP.md.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMMANDS = ['route', 'screen', 'domain', 'vtid', 'why', 'uses', 'check'];

// ------------------------------------------------------------------------------------------------ helpers
export function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

/** `git grep -n` → [{file, line, text}]; pathspecs are git pathspecs, missing ones are skipped by git. */
export function grep(root, pattern, pathspecs = [], { fixed = true, icase = false, extended = false } = {}) {
  const args = ['grep', '-n', '-I', '--no-color'];
  if (fixed) args.push('-F'); else if (extended) args.push('-E');
  if (icase) args.push('-i');
  args.push('-e', pattern, '--', ...pathspecs);
  const r = git(root, args);
  if (r.status !== 0) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    return m ? { file: m[1], line: Number(m[2]), text: m[3].trim() } : null;
  }).filter(Boolean);
}

/** Minimal glob for pointer checks: `*` inside one path segment, trailing `/` = directory, `**` = any depth. */
export function globExists(root, pattern) {
  const wantDir = pattern.endsWith('/');
  let base = root;
  let clean = pattern.replace(/\/$/, '');
  while (clean.startsWith('../')) { base = path.dirname(base); clean = clean.slice(3); }
  if (!/[*]/.test(clean)) {
    const p = path.join(base, clean);
    try { return wantDir ? statSync(p).isDirectory() : existsSync(p); } catch { return false; }
  }
  const parts = clean.split('/');
  const walk = (dir, i) => {
    if (i === parts.length) return true;
    const part = parts[i];
    const last = i === parts.length - 1;
    if (part === '**') return walk(dir, i + 1) || listDir(dir).some((e) => e.dir && walk(path.join(dir, e.name), i));
    const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return listDir(dir).some((e) => re.test(e.name) && ((last && !wantDir) || e.dir) && walk(path.join(dir, e.name), i + 1));
  };
  return walk(base, 0);
}
function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })); } catch { return []; }
}

export function findRoots({ platform, v1, env = process.env } = {}) {
  const p = path.resolve(platform || env.VITANA_PLATFORM_DIR || path.join(HERE, '..', '..'));
  const cands = [v1, env.VITANA_V1_DIR, path.join(path.dirname(p), 'vitana-v1')].filter(Boolean).map((d) => path.resolve(d));
  const v = cands.find((d) => existsSync(path.join(d, 'src', 'App.tsx'))) || null;
  return { platform: p, v1: v };
}

// ------------------------------------------------------------------------------------------------ atlas
export const ATLAS_FILE = 'services/gateway/src/orb/developer/domain-atlas.ts';
const strings = (s) => [...(s || '').matchAll(/'((?:\\.|[^'\\])*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));

/** Parse DOMAIN_ATLAS out of domain-atlas.ts (the developer Vitana's map; drift-guarded by the VTID-04560 suite). */
export function parseAtlas(text) {
  if (!text) return [];
  const starts = [...text.matchAll(/^\s*key:\s*'([^']+)'/gm)];
  return starts.map((m, i) => {
    const block = text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : text.length);
    const field = (name) => (new RegExp(`\\b${name}:\\s*\\[([\\s\\S]*?)\\],\\s*\\n`).exec(block) || [])[1] || '';
    const scalar = (name) => { const r = new RegExp(`\\b${name}:\\s*\\n?\\s*'((?:\\\\.|[^'\\\\])*)'`).exec(block); return r ? r[1].replace(/\\'/g, "'") : ''; };
    const routes = [...field('routes').matchAll(/\/((?:\\.|[^/\\\n])+)\/([a-z]*)/g)].map((r) => r[1]);
    // Line of a pointer string inside this domain's block (for `check` to cite the exact line).
    const at = (s) => { const i = block.indexOf(`'${s}'`); return i < 0 ? lineOf(text, m.index) : lineOf(text, m.index + i); };
    return { key: m[1], line: lineOf(text, m.index), at, title: scalar('title'), summary: scalar('summary'), routes,
      code: strings(field('code')), tables: strings(field('tables')), flags: strings(field('flags')),
      docs: strings(field('docs')), aliases: strings(field('aliases')) };
  });
}
function routeFiles(platform) {
  const base = path.join(platform, 'services/gateway/src/routes');
  const out = [];
  const walk = (d) => listDir(d).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.dir) walk(p); else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(rel(base, p).replace(/\.ts$/, ''));
  });
  walk(base);
  return out.sort();
}
const atlasOf = (roots) => parseAtlas(read(path.join(roots.platform, ATLAS_FILE)));
const claims = (domain, routeName) => domain.routes.some((r) => new RegExp(r).test(routeName));

// ------------------------------------------------------------------------------------------------ route
/** Mount table of the gateway: [{prefix, file, line}] from services/gateway/src/index.ts. */
export function parseMounts(indexText) {
  const vars = new Map();
  const reqRe = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:[^;\n]*?\?\s*)?require\(\s*['"]\.\/routes\/([^'"]+)['"]\s*\)/g;
  for (const m of indexText.matchAll(reqRe)) {
    const names = m[1].startsWith('{')
      ? m[1].slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.includes(':') ? s.split(':')[1] : s).trim())
      : [m[1]];
    names.forEach((n) => vars.set(n, m[2]));
  }
  for (const m of indexText.matchAll(/^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]\.\/routes\/([^'"]+)['"]/gm)) {
    if (m[1]) vars.set(m[1], m[3]);
    (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => vars.set((s.includes(' as ') ? s.split(' as ')[1] : s).trim(), m[3]));
  }
  const mounts = [];
  const mRe = /(?:mountRouterSync\(\s*app\s*,|app\.use\()\s*['"`]([^'"`]+)['"`]\s*,\s*([^,)]+)/g;
  for (const m of indexText.matchAll(mRe)) {
    const target = m[2].trim();
    const inline = /require\(\s*['"]\.\/routes\/([^'"]+)['"]/.exec(target);
    const file = inline ? inline[1] : vars.get(target.split('.')[0].replace(/^\(|\)$/g, ''));
    if (file) mounts.push({ prefix: m[1], file, line: lineOf(indexText, m.index) });
  }
  return mounts;
}
/** Handlers in a router file: [{method, path, line}]. */
export function parseHandlers(text) {
  const out = [];
  const re = /^\s*[A-Za-z_$][\w$]*\s*\.(get|post|put|patch|delete|all|options|use)\(\s*\[?\s*['"`]([^'"`]+)['"`]/gm;
  for (const m of text.matchAll(re)) out.push({ method: m[1].toUpperCase(), path: m[2], line: lineOf(text, m.index) });
  return out;
}
export function pathMatches(pattern, actual) {
  const rx = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*|\*/g, '.*').replace(/:(\w+)\\\?/g, '([^/]*)').replace(/:(\w+)/g, '[^/]+');
  return new RegExp(`^${rx}/?$`).test(actual);
}
function routeFile(platform, file) {
  for (const c of [`${file}.ts`, `${file}/index.ts`, `${file}.js`]) {
    const p = path.join(platform, 'services/gateway/src/routes', c);
    if (existsSync(p)) return p;
  }
  return null;
}
/** Keep the most specific matches: literal paths beat `:param` paths, which beat wildcards. */
export function mostSpecific(items, key) {
  const score = (p) => (/\*/.test(p) ? 2 : /:/.test(p) ? 1 : 0);
  const best = Math.min(...items.map((x) => score(key(x))));
  return items.filter((x) => score(key(x)) === best);
}
export function route(roots, query) {
  const mm = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(.+)$/i.exec((query || '').trim());
  const method = mm ? mm[1].toUpperCase() : null;
  const q = (mm ? mm[2] : query || '').split('?')[0].replace(/\/+$/, '') || '/';
  const idxRel = 'services/gateway/src/index.ts';
  const mounts = parseMounts(read(path.join(roots.platform, idxRel)) || '');
  const hits = mounts.filter((m) => m.prefix === '/' || q === m.prefix || q.startsWith(`${m.prefix.replace(/\/$/, '')}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const atlas = atlasOf(roots);
  const results = [];
  for (const m of hits) {
    const abs = routeFile(roots.platform, m.file);
    if (!abs) continue;
    const rest = m.prefix === '/' ? q : q.slice(m.prefix.replace(/\/$/, '').length) || '/';
    let handlers = parseHandlers(read(abs)).filter((h) => h.method !== 'USE' && pathMatches(h.path, rest)
      && (method ? h.method === method || h.method === 'ALL' : h.method !== 'OPTIONS'));
    if (handlers.length) handlers = mostSpecific(handlers, (h) => h.path);
    if (!handlers.length && results.length) continue;
    results.push({ mount: `${idxRel}:${m.line}`, prefix: m.prefix, file: rel(roots.platform, abs),
      handlers: handlers.map((h) => ({ method: h.method, path: h.path, at: `${rel(roots.platform, abs)}:${h.line}` })),
      domains: atlas.filter((d) => claims(d, m.file)).map((d) => `${d.key} (${ATLAS_FILE}:${d.line})`) });
    if (handlers.length) break;
  }
  const tests = new Set();
  grep(roots.platform, q, ['services/gateway/test', 'scripts/ci/staging-verify', 'e2e']).forEach((h) => tests.add(h.file));
  results.forEach((r) => grep(roots.platform, `routes/${path.basename(r.file).replace(/\.ts$/, '')}`, ['services/gateway/test'])
    .forEach((h) => tests.add(h.file)));
  return { query: q, matches: results, tests: [...tests].sort().slice(0, 25),
    note: results.length ? null : 'no mount prefix matches; try `uses` on a route file or `git grep` the last segment' };
}

// ------------------------------------------------------------------------------------------------ screen (vitana-v1)
const WRAPPERS = new Set(['AuthGuard', 'ProtectedRoute', 'Suspense', 'Navigate', 'RoleGuard', 'ErrorBoundary', 'Fragment',
  'RouteFallback', 'DelayedLoader', 'Outlet']);
export function screen(roots, query) {
  if (!roots.v1) return { query, error: 'vitana-v1 checkout not found (sibling ../vitana-v1, --v1 or VITANA_V1_DIR)' };
  const app = read(path.join(roots.v1, 'src/App.tsx')) || '';
  const lines = app.split('\n');
  const q = (query || '').split('?')[0];
  const routes = [];
  lines.forEach((l, i) => {
    const m = /<Route\s+[^>]*?path=["']([^"']+)["']/.exec(l);
    if (!m || !(m[1] === q || pathMatches(m[1], q))) return;
    const block = lines.slice(i, i + 12).join('\n');
    const end = block.indexOf('/>') >= 0 && /element=\{\s*<\w+[^>]*\/>\s*\}/.test(l) ? l : block.slice(0, (block.search(/\}\s*\/>/) + 1) || block.length);
    const comps = [...new Set([...end.matchAll(/<([A-Z]\w*)/g)].map((c) => c[1]).filter((c) => !WRAPPERS.has(c) && c !== 'Route'))];
    const redirect = /<Navigate\s+to=["']([^"']+)["']/.exec(end);
    const pages = comps.map((c) => {
      const imp = new RegExp(`(?:const\\s+${c}\\s*=[^\\n]*import\\(\\s*["']([^"']+)["']|import\\s+${c}\\s+from\\s+["']([^"']+)["'])`).exec(app);
      const spec = imp ? (imp[1] || imp[2]) : null;
      return { component: c, import: spec, file: spec ? resolveSpec(roots.v1, 'src/App.tsx', spec) : null };
    });
    routes.push({ at: `src/App.tsx:${i + 1}`, path: m[1], redirect: redirect ? redirect[1] : null, pages });
  });
  const shown = routes.length ? mostSpecific(routes, (x) => x.path) : routes;
  routes.splice(0, routes.length, ...shown);
  const reg = (file, key) => grep(roots.v1, `"${key}": "${q}"`, [file]).map((h) => `${file}:${h.line}`);
  const excl = (() => {
    const j = (() => { try { return JSON.parse(read(path.join(roots.v1, 'src/navigation/registry/exclusions.json'))); } catch { return {}; } })();
    const all = [...(j.prefixes || []).map((e) => ({ ...e, kind: 'prefix' })), ...(j.routes || []).map((e) => ({ ...e, kind: 'route' }))];
    return all.filter((e) => (e.prefix && q.startsWith(e.prefix)) || e.route === q || e.path === q).map((e) => `${e.kind} ${e.prefix || e.route || e.path}: ${e.reason || ''}`.trim());
  })();
  const tests = new Set();
  grep(roots.v1, q, ['tests', 'e2e', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'docs/validation/**/staging-tests.json']).forEach((h) => tests.add(h.file));
  return { query: q, routes, navRegistry: reg('src/navigation/registry/screens.json', 'route'), exclusions: excl,
    manifest: reg('src/design/screen-manifest.json', 'path'), parity: reg('apps/mobile/parity/ledger.json', 'web_path'),
    tests: [...tests].sort().slice(0, 15), moreTests: Math.max(0, tests.size - 15) };
}

// ------------------------------------------------------------------------------------------------ uses
/** Resolve an import specifier from `fromRel` (repo-relative) to an existing repo-relative file, or null. */
export function resolveSpec(root, fromRel, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(root, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.join(root, path.dirname(fromRel), spec);
  else return null;
  const exts = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  const noJs = base.replace(/\.(js|mjs|cjs)$/, '');
  for (const b of [base, noJs]) for (const e of exts) { const p = b + e; if (existsSync(p) && statSync(p).isFile()) return rel(root, p); }
  return null;
}
const isTest = (f) => /(^|\/)(test|tests|__tests__|e2e)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/rules/*.md', 'docs/DEPLOYMENT-PIPELINE.md', '.kiro/steering/*.md'];
export function uses(roots, fileArg) {
  const repos = [['vitana-platform', roots.platform], ['vitana-v1', roots.v1]].filter((r) => r[1]);
  const absArg = path.resolve(fileArg);
  const owner = repos.find(([, r]) => absArg.startsWith(r + path.sep)) || repos.find(([, r]) => existsSync(path.join(r, fileArg)));
  if (!owner) return { file: fileArg, error: 'file not found in either checkout' };
  const [repoName, root] = owner;
  const target = absArg.startsWith(root + path.sep) ? rel(root, absArg) : fileArg.replace(/^\.\//, '');
  const stem = path.basename(target).replace(/\.[cm]?[jt]sx?$/, '');
  const pat = `(from|require\\(|import\\()\\s*['"][^'"]*/${stem.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}(\\.[cm]?[jt]sx?)?['"]`;
  const importers = grep(root, pat, [], { fixed: false, extended: true })
    .filter((h) => { const s = /['"]([^'"]+)['"]/.exec(h.text.slice(h.text.search(/from|require\(|import\(/))); return s && resolveSpec(root, h.file, s[1]) === target; });
  const code = importers.filter((h) => !isTest(h.file)).map((h) => `${h.file}:${h.line}`);
  const tests = importers.filter((h) => isTest(h.file)).map((h) => `${h.file}:${h.line}`);
  const rules = repos.flatMap(([name, r]) => grep(r, path.basename(target), RULE_FILES).map((h) => `${name}/${h.file}:${h.line}`));
  return { file: `${repoName}/${target}`, code, tests, rules,
    hint: existsSync(path.join(root, 'graphify-out/graph.json')) ? `graphify explain "${path.basename(target)}" (graph, both directions)` : null };
}

// ------------------------------------------------------------------------------------------------ domain / why / vtid
export function domain(roots, word) {
  const w = (word || '').toLowerCase();
  const atlas = atlasOf(roots);
  const files = routeFiles(roots.platform);
  const hit = atlas.filter((d) => d.key === w || d.title.toLowerCase().includes(w) || d.aliases.some((a) => a.toLowerCase() === w || a.toLowerCase().includes(w)));
  return { query: word, source: ATLAS_FILE, domains: hit.map((d) => ({ key: d.key, at: `${ATLAS_FILE}:${d.line}`, title: d.title,
    summary: d.summary, routeFiles: files.filter((f) => claims(d, f)).map((f) => `services/gateway/src/routes/${f}.ts`),
    code: d.code, tables: d.tables, flags: d.flags, docs: d.docs })) };
}

const WHY_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/rules/*.md', 'docs/CHANGELOG.md', 'docs/CHANGELOG-ARCHIVE.md',
  'docs/decisions', '.repowise/decisions.yaml', 'docs/DEPLOYMENT-PIPELINE.md', 'docs/design-system/SPOTLIGHT_RULES.md'];
function headingAt(root, file, line, cache) {
  if (!cache.has(file)) cache.set(file, (read(path.join(root, file)) || '').split('\n'));
  const ls = cache.get(file);
  for (let i = line - 1; i >= 0; i--) if (/^#{1,4}\s/.test(ls[i])) return ls[i].replace(/^#+\s*/, '').slice(0, 90);
  return null;
}
export function why(roots, term, { perFile = 4, total = 40 } = {}) {
  const repos = [['vitana-platform', roots.platform], ['vitana-v1', roots.v1]].filter((r) => r[1]);
  const out = [];
  const rank = (f) => { const i = WHY_FILES.findIndex((w) => (w.includes('*') ? f.startsWith(w.split('*')[0]) : f === w || f.startsWith(`${w}/`))); return i < 0 ? 99 : i; };
  for (const [name, root] of repos) {
    const cache = new Map();
    const byFile = new Map();
    const hits = grep(root, term, WHY_FILES, { icase: true }).sort((a, b) => rank(a.file) - rank(b.file) || a.line - b.line);
    for (const h of hits) {
      if ((byFile.get(h.file) || 0) >= perFile) continue;
      byFile.set(h.file, (byFile.get(h.file) || 0) + 1);
      out.push({ at: `${name}/${h.file}:${h.line}`, heading: headingAt(root, h.file, h.line, cache), text: h.text.slice(0, 160) });
    }
  }
  return { query: term, hits: out.slice(0, total), more: Math.max(0, out.length - total),
    next: `git log -S '${term}' --oneline -- <file>  (when the rule text does not say why)` };
}

export function vtid(roots, id, { prs = false, run = spawnSync } = {}) {
  if (!/^VTID-\d{5}$/.test(id || '')) return { error: 'usage: vtid VTID-12345' };
  const repos = [['vitana-platform', roots.platform], ['vitana-v1', roots.v1]].filter((r) => r[1]);
  const res = { vtid: id, commits: [], specs: [], validation: [], changelog: [], prs: null };
  for (const [name, root] of repos) {
    const log = git(root, ['log', '--all', '-n', '15', '--format=%h %cs %s', `--grep=${id}\\b`, '--extended-regexp']);
    log.out.split('\n').filter(Boolean).forEach((l) => res.commits.push(`${name} ${l}`));
    const specFiles = new Set(grep(root, id, ['.kiro/specs']).map((h) => h.file));
    for (const f of specFiles) {
      const fm = (read(path.join(root, f)) || '').match(/^state:\s*(\S+)/m);
      res.specs.push(`${name}/${f}${fm ? ` (state: ${fm[1]})` : ''}`);
    }
    const vdir = path.join(root, 'docs/validation', id);
    if (existsSync(vdir)) res.validation.push(`${name}/docs/validation/${id}/ [${listDir(vdir).map((e) => e.name + (e.dir ? '/' : '')).join(', ')}]`);
    grep(root, id, ['docs/CHANGELOG.md', 'docs/CHANGELOG-ARCHIVE.md', 'CLAUDE.md']).slice(0, 6)
      .forEach((h) => res.changelog.push(`${name}/${h.file}:${h.line}`));
  }
  if (prs) {
    const r = run('gh', ['api', '-X', 'GET', 'search/issues', '-f', `q=${id} org:exafyltd is:pr`, '-f', 'per_page=20',
      '--jq', '.items[] | "\\(.state) \\(.html_url) \\(.title)"'], { encoding: 'utf8' });
    res.prs = r.status === 0 ? (r.stdout || '').split('\n').filter(Boolean) : [`gh search failed: ${(r.stderr || '').trim().slice(0, 120)}`];
  }
  res.ledger = process.env.DEV_MEMORY_PACK_TOKEN ? `scripts/dev/resume-vtid.sh ${id}` : 'ledger row: needs DEV_MEMORY_PACK_TOKEN (scripts/dev/resume-vtid.sh); git above is complete for merged work';
  return res;
}

// ------------------------------------------------------------------------------------------------ check
const PATH_RE = /`((?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.*@-]+)+\.(?:ts|tsx|mjs|cjs|js|md|json|yml|yaml|sh|sql|py))`/g;
const SKIP_REF = /^(graphify-out|\.agents|node_modules|dist)\/|<|\$|^~|^\/(tmp|home|projects)\//;
/** Repo-like backticked paths in a markdown file that resolve nowhere. */
export function deadRefs(text, resolvers) {
  const out = [];
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    if (SKIP_REF.test(p)) continue;
    if (!resolvers.some((fn) => fn(p))) out.push({ ref: p, line: lineOf(text, m.index) });
  }
  return out;
}
function resolversFor(roots) {
  const bases = [];
  for (const r of [roots.platform, roots.v1].filter(Boolean)) {
    bases.push(r, path.dirname(r), path.join(r, 'services/gateway'), path.join(r, 'services/gateway/src'),
      path.join(r, 'services/gateway/src/services'), path.join(r, 'services/gateway/src/orb'), path.join(r, 'src'));
  }
  const named = (p) => [['vitana-platform/', roots.platform], ['vitana-v1/', roots.v1]]
    .some(([pre, r]) => r && p.startsWith(pre) && globExists(r, p.slice(pre.length)));
  // (c) a short form in prose (`session/live-session-controller.ts`) is the suffix of a tracked file.
  let tracked = null;
  const suffix = (p) => {
    if (/[*]/.test(p)) return false;
    tracked ||= [roots.platform, roots.v1].filter(Boolean).flatMap((r) => git(r, ['ls-files']).out.split('\n'));
    return tracked.some((f) => f === p || f.endsWith(`/${p}`));
  };
  return [named, (p) => !/^vitana-(v1|platform)\//.test(p) && (bases.some((b) => globExists(b, p)) || suffix(p))];
}
export function check(roots) {
  const findings = [];
  const add = (level, area, at, msg) => findings.push({ level, area, at, msg });
  // 1. The developer atlas: every pointer resolves and every route regex claims a file.
  const atlas = atlasOf(roots);
  const files = routeFiles(roots.platform);
  const src = path.join(roots.platform, 'services/gateway/src');
  const codeBases = [src, path.join(roots.platform, 'services/gateway'), roots.platform];
  for (const d of atlas) {
    // Atlas pointers (plan §3.1, R2-F1): a trailing `/` is a directory, `*`/`**` a glob (zero matches = dead), `../` is
    // relative to the base it is tried against; bases in order services/gateway/src, services/gateway, repo root.
    d.code.forEach((c) => { if (!codeBases.some((b) => globExists(b, c))) add('warn', 'atlas', `${ATLAS_FILE}:${d.at(c)}`, `${d.key}: code pointer "${c}" matches nothing (tried services/gateway/src, services/gateway, repo root)`); });
    d.docs.forEach((doc) => { const p = doc.split(/\s+/)[0]; if (/\//.test(p) || /\.md$/.test(p)) { if (!globExists(roots.platform, p)) add('warn', 'atlas', `${ATLAS_FILE}:${d.at(doc)}`, `${d.key}: doc "${p}" does not exist`); } });
    d.routes.forEach((r) => { if (!files.some((f) => new RegExp(r).test(f))) add('warn', 'atlas', `${ATLAS_FILE}:${d.line}`, `${d.key}: route pattern /${r}/ claims no route file`); });
  }
  // 2. The context map itself (this tool's own doc): every path exists, every command is real. Errors.
  const mapRel = 'docs/CONTEXT-MAP.md';
  const map = read(path.join(roots.platform, mapRel));
  const resolve = resolversFor(roots);
  // This page writes vitana-v1 paths as `vitana-v1/<path>`. Without that checkout (CI of this repo) they cannot be
  // judged (info); every other path must exist in vitana-platform (error).
  if (!map) add('error', 'context-map', mapRel, 'missing');
  else {
    deadRefs(map, resolve).forEach((d) => {
      const v1Only = d.ref.startsWith('vitana-v1/') && !roots.v1;
      add(v1Only ? 'info' : 'error', 'context-map', `${mapRel}:${d.line}`, `dead link ${d.ref}${v1Only ? ' (vitana-v1 not checked out)' : ''}`);
    });
    for (const m of map.matchAll(/context\.mjs\s+([a-z]+)/g)) if (!COMMANDS.includes(m[1])) add('error', 'context-map', `${mapRel}:${lineOf(map, m.index)}`, `unknown command "${m[1]}"`);
  }
  // 3. Rule files that sessions load: dead path references.
  for (const [name, root] of [['vitana-platform', roots.platform], ['vitana-v1', roots.v1]].filter((r) => r[1])) {
    const ruleFiles = ['CLAUDE.md', 'AGENTS.md', 'docs/CODEINTEL-SESSION-SETUP.md', 'docs/DEPLOYMENT-PIPELINE.md',
      ...listDir(path.join(root, '.claude/rules')).filter((e) => e.name.endsWith('.md')).map((e) => `.claude/rules/${e.name}`)];
    for (const f of ruleFiles) {
      const t = read(path.join(root, f));
      if (t) deadRefs(t, resolve).forEach((d) => add('warn', 'rules', `${name}/${f}:${d.line}`, roots.v1
        ? `path ${d.ref} resolves in neither checkout`
        : `path ${d.ref} does not resolve here (vitana-v1 not checked out; it may live there)`));
    }
    // 4. Index freshness.
    const head = git(root, ['rev-parse', 'HEAD']).out.trim();
    const behind = (sha) => { const r = git(root, ['rev-list', '--count', `${sha}..HEAD`]); return r.status === 0 ? Number(r.out.trim()) : null; };
    const stamp = /Last indexed:\s*(\d{4}-\d{2}-\d{2})\s*\(commit\s*([0-9a-f]{7,40})\)/.exec(read(path.join(root, '.claude/CLAUDE.md')) || '');
    if (stamp) { const n = behind(stamp[2]); if (n === null || n > 100) add('warn', 'index', `${name}/.claude/CLAUDE.md`, `RepoWise block says "Last indexed ${stamp[1]} (commit ${stamp[2]})": ${n === null ? 'commit not in this clone' : `${n} commits behind HEAD`}; its file list and hotspots are a snapshot, not current`); }
    const stateDir = process.env.CODEINTEL_STATE_DIR || path.join(os.homedir(), '.cache/vitana-codeintel');
    // The state file is per checkout; a worktree of that checkout shares its index (same git common dir).
    const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).out.trim() || '.git');
    const st = [path.basename(root), name].map((n) => { try { return JSON.parse(readFileSync(path.join(stateDir, `${n}.json`), 'utf8')); } catch { return null; } })
      .find((s) => s && (!s.repo || path.resolve(s.repo) === root || path.resolve(s.repo, '.git') === common));
    if (!st) add('info', 'index', name, 'local RepoWise/Graphify index never built in this session (scripts/codeintel/session-setup.sh)');
    else if (st.head && st.head !== head) add('info', 'index', name, `local index at ${st.head.slice(0, 10)}, HEAD ${head.slice(0, 10)} (${behind(st.head) ?? '?'} commits behind): run \`repowise update\` / \`graphify update .\``);
  }
  const counts = { error: 0, warn: 0, info: 0 };
  findings.forEach((f) => { counts[f.level] += 1; });
  return { counts, findings };
}

// ------------------------------------------------------------------------------------------------ output
function print(cmd, r) {
  const L = [];
  const list = (title, xs) => { if (xs && xs.length) { L.push(`${title}:`); xs.forEach((x) => L.push(`  ${x}`)); } };
  if (r.error) L.push(`error: ${r.error}`);
  else if (cmd === 'route') {
    if (!r.matches.length) L.push(`no route for ${r.query}${r.note ? ` (${r.note})` : ''}`);
    r.matches.forEach((m) => {
      L.push(`${r.query} → mounted ${m.prefix} at ${m.mount} → ${m.file}`);
      m.handlers.forEach((h) => L.push(`  ${h.method} ${h.path}  ${h.at}`));
      if (!m.handlers.length) L.push('  (no handler path matches inside this router)');
      list('  atlas domain', m.domains);
    });
    list('tests naming it', r.tests);
  } else if (cmd === 'screen') {
    if (!r.routes.length) L.push(`no <Route> for ${r.query} in src/App.tsx`);
    r.routes.forEach((x) => { L.push(`${x.path}  ${x.at}${x.redirect ? `  → redirects to ${x.redirect}` : ''}`); x.pages.forEach((p) => L.push(`  ${p.component}  ${p.file || p.import || '(import not found)'}`)); });
    list('nav registry', r.navRegistry); list('nav exclusion', r.exclusions); list('screen manifest', r.manifest); list('parity ledger', r.parity); list('tests naming it', r.tests);
    if (r.moreTests) L.push(`  (+${r.moreTests} more)`);
  } else if (cmd === 'domain') {
    if (!r.domains.length) L.push(`no atlas domain matches "${r.query}" (${r.source})`);
    r.domains.forEach((d) => { L.push(`${d.key} — ${d.title}  ${d.at}`, `  ${d.summary}`); list('  route files', d.routeFiles); list('  code (services/gateway/src)', d.code); list('  tables', d.tables); list('  flags', d.flags); list('  docs', d.docs); });
  } else if (cmd === 'vtid') {
    list('commits', r.commits); list('spec / lane files', r.specs); list('validation', r.validation); list('rules / changelog', r.changelog); list('PRs', r.prs); L.push(r.ledger);
  } else if (cmd === 'why') {
    if (!r.hits.length) L.push(`no rule or decision text mentions "${r.query}"`);
    r.hits.forEach((h) => L.push(`${h.at}${h.heading ? `  [${h.heading}]` : ''}\n    ${h.text}`));
    if (r.more) L.push(`(+${r.more} more; narrow the term)`);
    L.push(`next: ${r.next}`);
  } else if (cmd === 'uses') {
    L.push(r.file); list('imported by (code)', r.code); list('imported by (tests)', r.tests); list('named in rule files', r.rules);
    if (!r.code.length && !r.tests.length) L.push('  no static importer found (dynamic import, script entry point, or unused)');
    if (r.hint) L.push(`more: ${r.hint}`);
  } else if (cmd === 'check') {
    r.findings.forEach((f) => L.push(`${f.level.padEnd(5)} ${f.area.padEnd(11)} ${f.at}  ${f.msg}`));
    L.push(`check: ${r.counts.error} error(s), ${r.counts.warn} warning(s), ${r.counts.info} info`);
  }
  return L.join('\n');
}

export function main(argv, { env = process.env } = {}) {
  const opts = { json: false, prs: false, strict: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true; else if (a === '--prs') opts.prs = true; else if (a === '--strict') opts.strict = true;
    else if (a === '--v1') opts.v1 = argv[++i]; else if (a === '--platform') opts.platform = argv[++i];
    else pos.push(a);
  }
  const [cmd, ...rest] = pos;
  const arg = rest.join(' ');
  if (!COMMANDS.includes(cmd) || (cmd !== 'check' && !arg)) {
    return { code: 2, text: `usage: context.mjs <${COMMANDS.join('|')}> <arg> [--json] [--prs] [--strict]  (see docs/CONTEXT-MAP.md)` };
  }
  const roots = findRoots({ platform: opts.platform, v1: opts.v1, env });
  const fn = { route, screen, domain, why, uses, check, vtid: (r, a) => vtid(r, a, { prs: opts.prs }) }[cmd];
  const r = fn(roots, arg);
  const code = r.error ? 1 : cmd === 'check' ? (r.counts.error || (opts.strict && r.counts.warn) ? 1 : 0) : 0;
  return { code, text: opts.json ? JSON.stringify(r, null, 2) : print(cmd, r) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, text } = main(process.argv.slice(2));
  process.stdout.write(`${text}\n`);
  process.exitCode = code;
}
