#!/usr/bin/env node
/**
 * Regenerate services/gateway/specs/dev-screen-inventory-v1.json from
 * source-of-truth files so /command-hub/docs/screens/ stays in sync
 * with the actual sidebars without manual edits.
 *
 * Sources:
 *   DEV          → services/gateway/src/frontend/command-hub/app.js (NAVIGATION_CONFIG)
 *   ADM          → vitana-v1/src/config/admin-navigation.ts (ADMIN_SECTIONS)
 *   COM/PAT/PRO/STA → services/gateway/specs/screens-overrides.json (sidecar; rarely changes)
 *
 * Usage:
 *   node services/gateway/scripts/regen-screens-catalog.mjs            # write
 *   node services/gateway/scripts/regen-screens-catalog.mjs --check    # exit 1 if regen would change spec
 *   VITANA_V1_ROOT=/path/to/vitana-v1 node ...regen-screens-catalog.mjs  # override v1 location
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_ROOT = path.resolve(__dirname, '..');
const APP_JS = path.join(GATEWAY_ROOT, 'src/frontend/command-hub/app.js');
const NAV_CONFIG_JS = path.join(GATEWAY_ROOT, 'src/frontend/command-hub/navigation-config.js');
const SPEC_PATH = path.join(GATEWAY_ROOT, 'specs/dev-screen-inventory-v1.json');
const OVERRIDES_PATH = path.join(GATEWAY_ROOT, 'specs/screens-overrides.json');
const V1_ROOT = process.env.VITANA_V1_ROOT
  || path.resolve(GATEWAY_ROOT, '../../../vitana-v1');
const ADMIN_NAV_TS = path.join(V1_ROOT, 'src/config/admin-navigation.ts');

const CHECK_MODE = process.argv.includes('--check');

function bail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function stripComments(src) {
  // Replace `//`-line and `/* */`-block comments with spaces so character
  // offsets stay stable (not strictly required, but cheap and predictable).
  let out = '';
  let i = 0;
  let inStr = false;
  let strCh = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += next; i += 2; continue; }
      if (c === strCh) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function extractArrayLiteralAfter(rawSrc, marker) {
  const src = stripComments(rawSrc);
  const start = src.indexOf(marker);
  if (start === -1) bail(`marker not found: ${marker}`);
  // Find `=` first so we skip past TS type annotations like `: AdminSection[]`.
  const eq = src.indexOf('=', start);
  if (eq === -1) bail(`no = after ${marker}`);
  const arrStart = src.indexOf('[', eq);
  if (arrStart === -1) bail(`no [ after ${marker}`);
  let depth = 0;
  let inStr = false;
  let strCh = '';
  for (let i = arrStart; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return src.slice(arrStart, i + 1);
    }
  }
  bail(`unbalanced brackets after ${marker}`);
}

// --- DEV: NAVIGATION_CONFIG from app.js -------------------------------------

function loadDev() {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const arrLit = extractArrayLiteralAfter(src, 'const NAVIGATION_CONFIG = ');
  const navConfig = vm.runInNewContext(`(${arrLit})`, {}, { timeout: 1000 });

  // Section labels live in a separate const (SECTION_LABELS) right after.
  const labelsLit = extractObjectLiteralAfter(src, 'const SECTION_LABELS = ');
  const sectionLabels = vm.runInNewContext(`(${labelsLit})`, {}, { timeout: 1000 });

  // Side-effect: stash the parsed nav for downstream sidebar/module_catalog/navigation-config.js writers.
  loadDev._lastNav = navConfig;
  loadDev._lastLabels = sectionLabels;

  // Tab labels: app.js uses tab keys without explicit labels in NAVIGATION_CONFIG;
  // labels for the docs catalog come from converting key → Title Case, with a few
  // overrides for special cases (acronyms, "&", apostrophes).
  const tabLabelOverrides = {
    'orb-live': 'ORB Live',
    'sse': 'SSE',
    'voice-lab': 'Voice LAB',
    'mcp-connectors': 'MCP & CLI',
    'apis': "API's",
    'plugins': 'Plugins & Extensions',
    'errors-violations': 'Errors & Violations',
    'autopilot-community': 'Autopilot (Community)',
    'autopilot-developer': 'Autopilot (Developer)',
    'autopilot-admin': 'Autopilot (Admin)',
    'self-healing': 'Self-Healing',
    'vtid-ledger': 'VTID Ledger',
    'vtids': 'VTIDs',
    'e2e': 'E2E',
    'ci-reports': 'CI Reports',
    'rls-access': 'RLS & Access',
    'keys-secrets': 'Keys & Secrets',
    'llm-providers': 'LLM Providers',
    'service-mesh': 'Service Mesh',
  };
  const titleCase = (s) => s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  // Disambiguators for screen-id collisions when raw tab key isn't unique across sections.
  const idOverrides = {
    'admin/analytics': 'ADMIN_ANALYTICS',
    'assistant/overview': 'ASSISTANT_OVERVIEW',
    'operator/deployments': 'OPERATOR_DEPLOYMENTS',
    'command-hub/events': 'OPS_EVENTS',
    'oasis/events': 'OASIS_EVENTS',
    'databases/analytics': 'DB_ANALYTICS',
    'infrastructure/deployments': 'INFRA_DEPLOYMENTS',
    'models-evaluations/evaluations': 'MODEL_EVALUATIONS',
  };

  const screens = [];
  for (const section of navConfig) {
    const sectionKey = section.section;
    const moduleLabel = sectionLabels[sectionKey] || titleCase(sectionKey);
    for (const tab of section.tabs) {
      const collisionKey = `${sectionKey}/${tab.key}`;
      const idSuffix = idOverrides[collisionKey] || tab.key.toUpperCase().replace(/-/g, '_');
      const label = tabLabelOverrides[tab.key] || titleCase(tab.key);
      screens.push({
        screen_id: `DEV-${idSuffix}`,
        module: moduleLabel,
        tab: label,
        url_path: tab.path,
        role: 'DEVELOPER',
      });
    }
  }
  return screens;
}

function extractObjectLiteralAfter(rawSrc, marker) {
  const src = stripComments(rawSrc);
  const start = src.indexOf(marker);
  if (start === -1) bail(`marker not found: ${marker}`);
  const objStart = src.indexOf('{', start);
  if (objStart === -1) bail(`no { after ${marker}`);
  let depth = 0;
  let inStr = false;
  let strCh = '';
  for (let i = objStart; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(objStart, i + 1);
    }
  }
  bail(`unbalanced braces after ${marker}`);
}

// --- ADM: ADMIN_SECTIONS from vitana-v1/src/config/admin-navigation.ts ------

function loadAdm() {
  if (!fs.existsSync(ADMIN_NAV_TS)) {
    bail(`vitana-v1 admin-navigation.ts not found at ${ADMIN_NAV_TS}. Set VITANA_V1_ROOT or check out exafyltd/vitana-v1 next to vitana-platform.`);
  }
  const src = fs.readFileSync(ADMIN_NAV_TS, 'utf8');
  const arrLit = extractArrayLiteralAfter(src, 'export const ADMIN_SECTIONS');

  // Strip TypeScript type annotations (`: AdminSection[]` etc) and provide stub
  // identifiers for the lucide-react icons referenced in the literal.
  const cleaned = arrLit.replace(/:\s*AdminSection\[\]/g, '');
  const ctx = {
    LayoutDashboard: 0, Users: 0, Sparkles: 0, BookOpen: 0, Compass: 0,
    Zap: 0, MessageSquare: 0, Video: 0, Bell: 0, BarChart3: 0,
    Settings: 0, ShieldCheck: 0,
  };
  const sections = vm.runInNewContext(`(${cleaned})`, ctx, { timeout: 1000 });

  // Disambiguator for the `growth` key colliding between Autopilot and Insights.
  const idOverrides = {
    'autopilot/growth': 'AUTOPILOT_GROWTH',
    'insights/growth': 'INSIGHTS_GROWTH',
  };

  const screens = [];
  for (const section of sections) {
    for (const tab of section.tabs) {
      const collisionKey = `${section.key}/${tab.key}`;
      const idSuffix = idOverrides[collisionKey] || tab.key.toUpperCase().replace(/-/g, '_');
      screens.push({
        screen_id: `ADM-${idSuffix}`,
        module: section.label,
        tab: tab.label,
        url_path: tab.path,
        role: 'ADMIN',
      });
    }
  }
  return screens;
}

// --- COM/PAT/PRO/STA: sidecar overrides file --------------------------------

function loadOverrides() {
  const data = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  return data.screens || [];
}

// --- Main -------------------------------------------------------------------

function buildNavReferenceJs(navConfig, sectionLabels) {
  // Re-emit services/gateway/src/frontend/command-hub/navigation-config.js so it
  // exactly mirrors the runtime NAVIGATION_CONFIG. The dev-frontend validator
  // imports this file and compares its tab list to spec.module_catalog.
  const titleCase = (s) => s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  const tabLabelOverrides = {
    'orb-live': 'ORB Live', 'sse': 'SSE', 'voice-lab': 'Voice LAB',
    'mcp-connectors': 'MCP & CLI', 'apis': "API's", 'plugins': 'Plugins & Extensions',
    'errors-violations': 'Errors & Violations',
    'autopilot-community': 'Autopilot (Community)',
    'autopilot-developer': 'Autopilot (Developer)',
    'autopilot-admin': 'Autopilot (Admin)',
    'self-healing': 'Self-Healing', 'vtid-ledger': 'VTID Ledger', 'vtids': 'VTIDs',
    'e2e': 'E2E', 'ci-reports': 'CI Reports', 'rls-access': 'RLS & Access',
    'keys-secrets': 'Keys & Secrets', 'llm-providers': 'LLM Providers',
    'service-mesh': 'Service Mesh',
  };

  const lines = [];
  lines.push('/**');
  lines.push(' * Vitana Developer Catalog – Canonical Navigation Config');
  lines.push(' * VTID: DEV-CICDL-0205');
  lines.push(' *');
  lines.push(' * AUTO-GENERATED by services/gateway/scripts/regen-screens-catalog.mjs');
  lines.push(' * from the runtime NAVIGATION_CONFIG in app.js. Do not hand-edit — your');
  lines.push(' * changes will be overwritten on the next regen run.');
  lines.push(' */');
  lines.push('');
  lines.push('export const NAVIGATION_CONFIG = [');
  navConfig.forEach((section, i) => {
    const label = sectionLabels[section.section] || titleCase(section.section);
    lines.push('  {');
    lines.push(`    module: ${JSON.stringify(section.section)},`);
    lines.push(`    label: ${JSON.stringify(label)},`);
    lines.push('    tabs: [');
    section.tabs.forEach((tab, j) => {
      const tabLabel = tabLabelOverrides[tab.key] || titleCase(tab.key);
      const sep = j < section.tabs.length - 1 ? ',' : '';
      lines.push(`      { key: ${JSON.stringify(tab.key)}, label: ${JSON.stringify(tabLabel)} }${sep}`);
    });
    lines.push('    ]');
    lines.push(`  }${i < navConfig.length - 1 ? ',' : ''}`);
  });
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const dev = loadDev();
  const adm = loadAdm();
  const others = loadOverrides();
  const all = [...dev, ...others, ...adm];

  // Validate uniqueness.
  const ids = new Set();
  const dupIds = [];
  for (const s of all) {
    if (ids.has(s.screen_id)) dupIds.push(s.screen_id);
    ids.add(s.screen_id);
  }
  if (dupIds.length) bail(`duplicate screen_ids: ${dupIds.join(', ')}`);

  const roleCounts = {};
  for (const s of all) roleCounts[s.role] = (roleCounts[s.role] || 0) + 1;

  // Build sidebar_navigation + module_catalog from the same runtime nav so the
  // dev-frontend validator stays happy as new tabs are added.
  const navConfig = loadDev._lastNav;
  const sidebarNavigation = navConfig.map(s => s.section);
  const moduleCatalog = {};
  for (const section of navConfig) moduleCatalog[section.section] = section.tabs.map(t => t.key);

  const existing = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

  const today = new Date().toISOString().slice(0, 10);
  existing.sidebar_navigation = sidebarNavigation;
  existing.module_catalog = moduleCatalog;
  existing.screen_inventory = {
    total_screens: dev.length, // DEV-only — required by validate-dev-frontend-spec.mjs
    total_entries: all.length,
    last_synced: today,
    source: 'auto-regen via services/gateway/scripts/regen-screens-catalog.mjs',
    role_counts: roleCounts,
    screens: all,
  };

  const generatedSpec = JSON.stringify(existing, null, 2) + '\n';
  const generatedNavJs = buildNavReferenceJs(navConfig, loadDev._lastLabels);

  const currentSpec = fs.readFileSync(SPEC_PATH, 'utf8');
  const currentNavJs = fs.existsSync(NAV_CONFIG_JS) ? fs.readFileSync(NAV_CONFIG_JS, 'utf8') : '';

  const specChanged = currentSpec !== generatedSpec;
  const navJsChanged = currentNavJs !== generatedNavJs;

  if (CHECK_MODE) {
    if (specChanged || navJsChanged) {
      console.error(`✗ out of sync (spec changed=${specChanged}, navigation-config.js changed=${navJsChanged}). Run without --check to regenerate.`);
      process.exit(1);
    }
    console.log(`✓ in sync (${all.length} entries: DEV ${dev.length} · ADM ${adm.length} · others ${others.length})`);
    return;
  }

  if (!specChanged && !navJsChanged) {
    console.log(`✓ no changes (${all.length} entries)`);
    return;
  }

  if (specChanged) fs.writeFileSync(SPEC_PATH, generatedSpec);
  if (navJsChanged) fs.writeFileSync(NAV_CONFIG_JS, generatedNavJs);
  console.log(`✓ regenerated${specChanged ? ' spec' : ''}${navJsChanged ? ' nav-config' : ''}`);
  console.log(`  ${all.length} entries: DEV ${dev.length} · ADM ${adm.length} · others ${others.length}`);
}

main();
