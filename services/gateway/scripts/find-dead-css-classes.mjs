#!/usr/bin/env node
/**
 * T11 (VTID-04086): conservative dead-CSS-class matcher for
 * services/gateway/src/frontend/command-hub/styles.css.
 *
 * The Command Hub JS/CSS cleanup chain (T1a/T1c/T1d, VTID-04061..04063)
 * removed whole dead JS render functions (a deleted Workflows module, the
 * dead admin-dev-users view, a dead Dev Autopilot execution card, ...) but
 * never touched the CSS those functions used — 20K+ lines of styles.css
 * with no build step means nothing ever flags an orphaned rule.
 *
 * Approach, in order of confidence:
 *   1. Collect every class name referenced anywhere in styles.css.
 *   2. A class is a DEAD CANDIDATE if it has zero whole-word occurrence in
 *      any other command-hub *.js/*.html file.
 *   3. Exclude any candidate that shares a prefix/suffix with a real
 *      string-concatenation site building class names at runtime (e.g.
 *      `'admin-status-' + row.status`) — a plain substring search cannot
 *      see a class name that is only ever assembled dynamically, and
 *      removing one of those would be a real, silent visual regression.
 *   4. Only actually REMOVE a CSS rule when its ENTIRE selector list is
 *      made of simple, single-class selectors (optionally with
 *      :pseudo-class/::pseudo-element/attribute-selector suffixes — never
 *      a descendant/child/sibling combinator, never a class combined with
 *      another class or an element selector) AND every one of those
 *      classes is a confirmed dead candidate. A rule with even one live
 *      class in its comma-separated selector list, or any non-simple
 *      selector shape, is left completely untouched — safer to under-
 *      remove than to misjudge a compound selector and break a still-live
 *      class sharing a rule with a dead one.
 *   5. @media (and other @-rule) blocks are recursed into the same way; a
 *      block left fully empty after its own dead rules are removed is
 *      itself removed.
 *
 * Usage:
 *   node services/gateway/scripts/find-dead-css-classes.mjs             # report only
 *   node services/gateway/scripts/find-dead-css-classes.mjs --fix       # write styles.css with dead rules removed
 *   node services/gateway/scripts/find-dead-css-classes.mjs --check     # exit 1 if --fix would change the file
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_ROOT = path.resolve(__dirname, '..');
const COMMAND_HUB_DIR = path.join(GATEWAY_ROOT, 'src/frontend/command-hub');
const CSS_PATH = path.join(COMMAND_HUB_DIR, 'styles.css');

const FIX_MODE = process.argv.includes('--fix');
const CHECK_MODE = process.argv.includes('--check');

// --- Step 1/2: collect classes referenced in CSS, and check JS/HTML usage --

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

export function collectCssClassNames(css) {
  const noComments = stripCssComments(css);
  const classRe = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
  const names = new Set();
  let m;
  while ((m = classRe.exec(noComments))) names.add(m[1]);
  return names;
}

export function findDynamicClassAffixes(jsSources) {
  const affixes = new Set();
  const patterns = [
    /['"`]([a-zA-Z0-9_-]*-)['"`]\s*\+/g, // 'foo-' +
    /\+\s*['"`](-[a-zA-Z0-9_-]+)['"`]/g, // + '-foo'
    /`([a-zA-Z0-9_-]*-)\$\{/g, // `foo-${
    /\}(-[a-zA-Z0-9_-]+)`/g, // }-foo`
  ];
  for (const src of jsSources) {
    for (const re of patterns) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(src))) affixes.add(m[1]);
    }
  }
  // Drop noise: an affix of 2 chars or fewer (after stripping dashes) is too
  // generic and would silently exclude almost every candidate.
  return [...affixes].filter((a) => a.replace(/-/g, '').length > 2);
}

function isDynamicallyBuilt(name, affixes) {
  for (const a of affixes) {
    if (a.endsWith('-') && name.startsWith(a)) return true;
    if (a.startsWith('-') && name.endsWith(a)) return true;
  }
  return false;
}

export function findDeadClassCandidates(cssClasses, jsHtmlCorpus, dynamicAffixes) {
  const dead = [];
  for (const cls of cssClasses) {
    if (isDynamicallyBuilt(cls, dynamicAffixes)) continue;
    const re = new RegExp('\\b' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (!re.test(jsHtmlCorpus)) dead.push(cls);
  }
  return dead.sort();
}

// --- Step 4/5: parse top-level CSS blocks and conditionally strip dead ones -

/** A selector is "simple" iff it is exactly one class, optionally followed
 * by pseudo-class/pseudo-element/attribute-selector suffixes — never a
 * combinator, never combined with another class or an element selector. */
const SIMPLE_CLASS_SELECTOR_RE = /^\.([A-Za-z_][A-Za-z0-9_-]*)((:{1,2}[A-Za-z-]+(\([^)]*\))?)|(\[[^\]]*\]))*$/;

export function classNameOfSimpleSelector(selector) {
  const m = SIMPLE_CLASS_SELECTOR_RE.exec(selector.trim());
  return m ? m[1] : null;
}

/**
 * Splits `css` into a flat list of top-level entities: comment blocks,
 * whitespace runs, rule blocks (`selector { ... }`), and @-rule blocks
 * (`@media ... { <nested> }`), recursing one level for @-rules (CSS here
 * never nests further than that). Each entity carries enough to
 * reconstruct the original text verbatim if left alone.
 */
export function parseTopLevel(css) {
  const entities = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      entities.push({ type: 'raw', text: css.slice(i, stop) });
      i = stop;
      continue;
    }
    if (/\s/.test(css[i])) {
      let j = i;
      while (j < n && /\s/.test(css[j])) j++;
      entities.push({ type: 'raw', text: css.slice(i, j) });
      i = j;
      continue;
    }
    // Find the next `{` that opens this entity, and the selector/prelude text before it.
    const braceIdx = css.indexOf('{', i);
    if (braceIdx === -1) {
      entities.push({ type: 'raw', text: css.slice(i) });
      i = n;
      continue;
    }
    const prelude = css.slice(i, braceIdx).trim();
    // Find the matching closing brace (comment/string-aware; CSS strings are
    // only ever simple quoted content: "..."/'...').
    let depth = 0;
    let j = braceIdx;
    let inStr = false;
    let strCh = '';
    let end = -1;
    while (j < n) {
      const c = css[j];
      if (inStr) {
        if (c === '\\') { j += 2; continue; }
        if (c === strCh) inStr = false;
        j++;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; strCh = c; j++; continue; }
      if (c === '/' && css[j + 1] === '*') { const e = css.indexOf('*/', j + 2); j = e === -1 ? n : e + 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      j++;
    }
    if (end === -1) {
      entities.push({ type: 'raw', text: css.slice(i) });
      i = n;
      continue;
    }
    const body = css.slice(braceIdx + 1, end);
    if (prelude.startsWith('@')) {
      entities.push({ type: 'atrule', prelude, nested: parseTopLevel(body) });
    } else {
      entities.push({ type: 'rule', selector: prelude, body });
    }
    i = end + 1;
  }
  return entities;
}

export function serialize(entities) {
  let out = '';
  for (const e of entities) {
    if (e.type === 'raw') out += e.text;
    else if (e.type === 'rule') out += `${e.selector} {${e.body}}`;
    else if (e.type === 'atrule') out += `${e.prelude} {${serialize(e.nested)}}`;
  }
  return out;
}

/**
 * Returns a new entity list with every rule whose ENTIRE comma-separated
 * selector list resolves to simple, all-dead classes removed, and any
 * @-rule block left with no remaining rule/atrule entities dropped
 * entirely too. Never mutates a rule with a mix of dead and live/complex
 * selectors.
 */
export function stripDeadRules(entities, deadSet) {
  const kept = [];
  for (const e of entities) {
    if (e.type === 'atrule') {
      const nested = stripDeadRules(e.nested, deadSet);
      const hasContent = nested.some((n) => n.type === 'rule' || n.type === 'atrule');
      if (hasContent) kept.push({ ...e, nested });
      // else: the whole @-rule block is now empty — drop it (and its raw
      // whitespace/comment siblings are handled by the caller's own pass).
      continue;
    }
    if (e.type === 'rule') {
      const selectors = e.selector.split(',').map((s) => s.trim()).filter(Boolean);
      const classNames = selectors.map(classNameOfSimpleSelector);
      const allSimpleAndDead = classNames.length > 0 && classNames.every((c) => c !== null && deadSet.has(c));
      if (allSimpleAndDead) continue; // drop this rule
      kept.push(e);
      continue;
    }
    kept.push(e);
  }
  return kept;
}

function main() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const cssClasses = collectCssClassNames(css);

  const jsFiles = fs.readdirSync(COMMAND_HUB_DIR).filter((f) => f.endsWith('.js') || f.endsWith('.html'));
  const jsSources = jsFiles.map((f) => fs.readFileSync(path.join(COMMAND_HUB_DIR, f), 'utf8'));
  const corpus = jsSources.join('\n');

  const dynamicAffixes = findDynamicClassAffixes(jsSources);
  const deadCandidates = findDeadClassCandidates(cssClasses, corpus, dynamicAffixes);
  const deadSet = new Set(deadCandidates);

  const entities = parseTopLevel(css);
  const stripped = stripDeadRules(entities, deadSet);
  const fixedCss = serialize(stripped);

  const removedRuleCount = countRules(entities) - countRules(stripped);

  console.log(`✓ ${cssClasses.size} classes referenced in styles.css`);
  console.log(`✓ ${deadCandidates.length} dead candidates (zero JS/HTML occurrence, not a dynamic-affix match)`);
  console.log(`✓ ${removedRuleCount} rule(s) removable (entire selector list is simple + all-dead)`);
  console.log('  (remaining candidates share a rule with a live class, or have a compound/complex selector — left untouched, needs a human read)');

  if (CHECK_MODE) {
    if (fixedCss !== css) {
      console.error('✗ out of sync — styles.css has removable dead rules. Run with --fix to remove them.');
      process.exit(1);
    }
    console.log('✓ in sync (no removable dead rules found)');
    return;
  }

  if (FIX_MODE) {
    if (fixedCss === css) {
      console.log('✓ no changes');
      return;
    }
    fs.writeFileSync(CSS_PATH, fixedCss);
    console.log(`✓ wrote styles.css (removed ${removedRuleCount} rule(s))`);
  }
}

function countRules(entities) {
  let n = 0;
  for (const e of entities) {
    if (e.type === 'rule') n++;
    else if (e.type === 'atrule') n += countRules(e.nested);
  }
  return n;
}

main();
