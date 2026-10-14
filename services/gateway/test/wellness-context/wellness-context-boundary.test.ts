/**
 * VTID-05165 (Health Hub Phase 1 / C2) — the wellness context is the ONLY
 * sanctioned path for Health Hub data into AI, and it never reaches commerce
 * (plan Change 13). Source scans over services/gateway/src:
 *
 *   (a) nothing imports services/wellness-context outside an allowlist, which
 *       is empty in C2 (tests only; Phase 4 adds its consumers here);
 *   (b) wellness-context imports no commerce module and no provider SDK
 *       (@google*, vertex, openai, @anthropic-ai/sdk, and no Bedrock client or
 *       router either: C2 makes no model call). Its internal imports are an
 *       explicit allowlist;
 *   (c) the health store's tables (HEALTH_STORE_TABLES, S5) are referenced
 *       only inside services/health-store/**; wellness-context reads only
 *       through S4 (health-store/reader) and makes no direct DB call;
 *   (d) ratchet: the legacy AI readers of device/lab data (D10 WP3 gates them)
 *       keep exactly today's direct importers. The list may only shrink: a new
 *       importer fails, and an importer that went away must be removed. The
 *       ratchet is import-based; the VTID-05025 scan stays the table-based
 *       guard for commerce modules (round-2 F3);
 *   (e) the rendered prompt for fixture facts contains no disease/condition
 *       name from any of the 11 locales' denylists.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HEALTH_STORE_TABLES } from '../../src/services/health-store/tables';
import { buildWellnessSystemPrompt, WELLNESS_BOUNDARY_RULES, type WellnessFact } from '../../src/services/wellness-context';
import { GATEWAY_LOCALES } from '../../src/i18n/catalog';
import { CONDITION_DENYLIST, findConditionTerms } from './condition-denylist';

const SRC = path.join(__dirname, '..', '..', 'src');
const WELLNESS_DIR = 'services/wellness-context/';

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const ALL_FILES = listTs(SRC);
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const read = (f: string) => fs.readFileSync(f, 'utf8');

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function specifiers(src: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(src))) out.push(m[1]);
  return out;
}

/** A relative specifier resolved to a src-relative .ts path; a package name as-is. */
function resolveSpec(file: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  const p = path.resolve(path.dirname(file), spec);
  for (const c of [p, `${p}.ts`, path.join(p, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  }
  return rel(`${p}.ts`);
}

function importsOf(file: string): string[] {
  return specifiers(read(file)).map((s) => resolveSpec(file, s));
}

const WELLNESS_FILES = ALL_FILES.filter((f) => rel(f).startsWith(WELLNESS_DIR));

// ---------------------------------------------------------------------------
// (a) importers of wellness-context
// ---------------------------------------------------------------------------

/** Phase 4 adds its consumers here, each in its own sparred, reviewed PR. Empty in C2. */
const WELLNESS_CONTEXT_IMPORTER_ALLOWLIST: readonly string[] = [];

describe('(a) wellness-context has no importers outside the allowlist', () => {
  it('the module exists', () => {
    expect(WELLNESS_FILES.map(rel).sort()).toEqual(
      expect.arrayContaining(['services/wellness-context/index.ts', 'services/wellness-context/context.ts', 'services/wellness-context/prompt.ts']),
    );
  });

  it('no src file outside services/wellness-context imports it', () => {
    const importers = ALL_FILES.filter((f) => !rel(f).startsWith(WELLNESS_DIR))
      .filter((f) => importsOf(f).some((i) => i.startsWith(WELLNESS_DIR)))
      .map(rel);
    expect(importers.filter((i) => !WELLNESS_CONTEXT_IMPORTER_ALLOWLIST.includes(i))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) wellness-context imports
// ---------------------------------------------------------------------------

/** Internal modules the wellness context may import (besides its own files). */
const WELLNESS_INTERNAL_ALLOWLIST = [
  'services/consent/health-consent.ts',
  'services/health-store/reader.ts',
  'i18n/catalog.ts',
  'i18n/server-locale.ts',
  'i18n/llm-locale.ts',
];
const WELLNESS_PACKAGE_ALLOWLIST = ['@supabase/supabase-js'];

const PROVIDER_SDK = /^(@google|@google-cloud\/|google-auth-library|openai|@anthropic-ai\/sdk|@aws-sdk\/client-bedrock)|vertex|gemini|bedrock|llm-router|providers\//i;
const COMMERCE = /marketplace|shopping|commerce|discover-|feed-ranker|limitations-filter|product|offer|merchant|affiliate|context-pack-builder|orb-tools-shared/i;

describe('(b) wellness-context imports no commerce module and no provider SDK', () => {
  it.each(WELLNESS_FILES.map((f) => [rel(f), f]))('%s imports only the allowlisted modules', (_r, file) => {
    for (const imp of importsOf(file as string)) {
      expect(imp).not.toMatch(PROVIDER_SDK);
      expect(imp).not.toMatch(COMMERCE);
      const ok = imp.startsWith(WELLNESS_DIR) || WELLNESS_INTERNAL_ALLOWLIST.includes(imp) || WELLNESS_PACKAGE_ALLOWLIST.includes(imp);
      if (!ok) throw new Error(`${rel(file as string)} imports ${imp}, which is not on the wellness-context allowlist`);
    }
  });

  it('the patterns catch real violations', () => {
    for (const bad of ['@google/genai', '@google-cloud/vertexai', 'openai', '@anthropic-ai/sdk', '@aws-sdk/client-bedrock-runtime', 'services/llm-router.ts', 'providers/bedrock.ts']) {
      expect(bad).toMatch(PROVIDER_SDK);
    }
    for (const bad of ['services/orb-tools/marketplace-discovery-tools.ts', 'services/shopping-agent/agent-core.ts', 'routes/discover-feed.ts', 'services/feed-ranker.ts', 'services/limitations-filter.ts']) {
      expect(bad).toMatch(COMMERCE);
    }
    for (const okImp of WELLNESS_INTERNAL_ALLOWLIST) {
      expect(okImp).not.toMatch(PROVIDER_SDK);
      expect(okImp).not.toMatch(COMMERCE);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) health store tables only inside services/health-store/**
// ---------------------------------------------------------------------------

const STORE_TABLE_RE = new RegExp(`['"\`](${HEALTH_STORE_TABLES.join('|')})['"\`]`);

describe('(c) A\'s tables are referenced only inside services/health-store/**', () => {
  it('HEALTH_STORE_TABLES is the S5 list', () => {
    expect([...HEALTH_STORE_TABLES].sort()).toEqual(
      ['health_ingest_batches', 'health_ingest_quarantine', 'health_observations', 'health_series_1d', 'health_series_1h', 'health_series_5m'].sort(),
    );
  });

  it('no src file outside services/health-store references a store table', () => {
    const offenders = ALL_FILES.filter((f) => !rel(f).startsWith('services/health-store/'))
      .filter((f) => STORE_TABLE_RE.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('wellness-context makes no direct database call and reaches the store only through S4 (health-store/reader)', () => {
    for (const f of WELLNESS_FILES) {
      const src = read(f);
      expect(src).not.toMatch(/\.from\(\s*['"`]/);
      expect(src).not.toMatch(/\.rpc\(/);
      const storeImports = importsOf(f).filter((i) => i.startsWith('services/health-store/'));
      expect(storeImports.every((i) => i === 'services/health-store/reader.ts')).toBe(true);
    }
    const context = read(path.join(SRC, 'services', 'wellness-context', 'context.ts'));
    expect(context).toMatch(/purpose:\s*'ai_context'/);
  });

  it('the pattern catches a store table and ignores the catalogue table', () => {
    for (const t of HEALTH_STORE_TABLES) expect(`.from('${t}')`).toMatch(STORE_TABLE_RE);
    expect(".from('health_codes')").not.toMatch(STORE_TABLE_RE);
  });
});

// ---------------------------------------------------------------------------
// (d) ratchet: legacy AI readers of device/lab data
// ---------------------------------------------------------------------------

/**
 * Today's legacy AI readers of device/lab data (D10 WP3 gates them; Phase 4
 * reroutes them into the wellness module) and their direct importers as of
 * VTID-05165. MAY ONLY SHRINK. Do not add an importer here to make this test
 * pass: new AI access to health data goes through services/wellness-context.
 */
const LEGACY_AI_HEALTH_READER_RATCHET: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // user-health-context.ts: the wearable branch (include_wearable).
  'services/user-health-context.ts': [
    'routes/discover-feed.ts',
    'routes/discover-search.ts',
    'routes/shopping-agent.ts',
    'routes/user-limitations.ts',
    'services/context-pack-builder.ts',
    'services/feed-ranker.ts',
    'services/gemini-operator.ts',
    'services/limitations-filter.ts',
    'services/orb-tools/health-depth-tools.ts',
    'services/orb-tools/marketplace-discovery-tools.ts',
    'services/orb-tools/marketplace-guide-tools.ts',
    'services/orb-tools/marketplace-journey-tools.ts',
    'services/recommendation-engine/analyzers/marketplace-analyzer.ts',
    'services/shopping-agent/agent-core.ts',
    'services/shopping-agent/reorder-core.ts',
  ],
  'services/user-health-context-repository.ts': ['services/user-health-context.ts'],
  // gemini-operator.ts: the get_wearable_metrics tool.
  'services/gemini-operator.ts': [
    'routes/conversation.ts',
    'routes/operator.ts',
    'routes/orb-live.ts',
    'services/conversation-client.ts',
    'services/kiro/kiro-mcp-tools.ts',
    'services/kiro/kiro-mcp-writes.ts',
  ],
  // health-depth-tools.ts: the lab tool.
  'services/orb-tools/health-depth-tools.ts': ['services/orb-tools-shared.ts'],
  'services/orb-tools/health-depth-tools-repository.ts': ['services/orb-tools/health-depth-tools.ts'],
  'services/recommendation-engine/analyzers/wearable-analyzer.ts': ['services/recommendation-engine/recommendation-generator.ts'],
  'services/recommendation-engine/analyzers/wearable-analyzer-repository.ts': ['services/recommendation-engine/analyzers/wearable-analyzer.ts'],
});

/** Files that reference the get_wearable_metrics tool today (definition, registry, route gate). May only shrink. */
const GET_WEARABLE_METRICS_RATCHET = ['services/gemini-operator.ts', 'services/jev/gates/operator-route-gate.ts', 'services/tool-registry.ts'];

function directImporters(target: string): string[] {
  return ALL_FILES.filter((f) => rel(f) !== target && importsOf(f).includes(target))
    .map(rel)
    .sort();
}

describe('(d) ratchet: legacy AI readers of device/lab data keep only today\'s importers', () => {
  it.each(Object.keys(LEGACY_AI_HEALTH_READER_RATCHET).map((k) => [k]))('%s', (target) => {
    expect(fs.existsSync(path.join(SRC, target))).toBe(true);
    const actual = directImporters(target);
    const frozen = LEGACY_AI_HEALTH_READER_RATCHET[target];
    const added = actual.filter((a) => !frozen.includes(a));
    const gone = frozen.filter((f) => !actual.includes(f));
    if (added.length > 0) {
      throw new Error(`new importer(s) of legacy AI health reader ${target}: ${added.join(', ')} — route AI access to health data through services/wellness-context instead`);
    }
    if (gone.length > 0) {
      throw new Error(`${gone.join(', ')} no longer import(s) ${target}: remove them from LEGACY_AI_HEALTH_READER_RATCHET (the ratchet only shrinks)`);
    }
  });

  it('get_wearable_metrics is referenced only by today\'s files', () => {
    const actual = ALL_FILES.filter((f) => read(f).includes('get_wearable_metrics')).map(rel).sort();
    expect(actual).toEqual([...GET_WEARABLE_METRICS_RATCHET].sort());
  });

  it('the wellness context imports none of the legacy readers', () => {
    for (const f of WELLNESS_FILES) {
      for (const imp of importsOf(f)) expect(Object.keys(LEGACY_AI_HEALTH_READER_RATCHET)).not.toContain(imp);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) no condition names in the rendered prompt
// ---------------------------------------------------------------------------

const AS_OF = '2026-10-12';
const FIXTURE_FACTS: WellnessFact[] = [
  {
    kind: 'sleep_duration_vs_baseline',
    category: 'sleep',
    code: 'sleep_session',
    unit: 'min',
    direction: 'lower',
    recent_mean: 330,
    baseline_mean: 440,
    change_pct: -25,
    recent_days: 7,
    baseline_days: 30,
    recent_window: { from: '2026-10-06', to: AS_OF },
    baseline_window: { from: '2026-09-13', to: AS_OF },
  },
  {
    kind: 'activity_volume',
    category: 'activity',
    code: 'steps',
    unit: '{steps}',
    direction: 'higher',
    recent_mean: 12000,
    baseline_mean: 7000,
    change_pct: 71,
    recent_days: 7,
    baseline_days: 30,
    recent_window: { from: '2026-10-06', to: AS_OF },
    baseline_window: { from: '2026-09-13', to: AS_OF },
  },
];

describe('(e) the rendered prompt names no disease or condition in any of the 11 locales', () => {
  it('the denylist covers every shipped locale', () => {
    expect(Object.keys(CONDITION_DENYLIST).sort()).toEqual([...GATEWAY_LOCALES].sort());
  });

  it.each(GATEWAY_LOCALES.map((l) => [l]))('locale %s', (locale) => {
    const out = buildWellnessSystemPrompt('You are Vitana, a wellness companion.', { status: 'ok', locale, facts: FIXTURE_FACTS });
    expect(findConditionTerms(out)).toEqual([]);
  });

  it('the boundary rules alone name no condition', () => {
    expect(findConditionTerms(WELLNESS_BOUNDARY_RULES.join('\n'))).toEqual([]);
  });

  it('the detector catches condition names (sanity)', () => {
    expect(findConditionTerms('possible insomnia')).toContain('en:insomnia');
    expect(findConditionTerms('Verdacht auf Vorhofflimmern')).toContain('de:Vorhofflimmern');
    expect(findConditionTerms('у вас депрессия')).toContain('ru:депрессия');
    expect(findConditionTerms('可能是失眠')).toContain('zh:失眠');
    expect(findConditionTerms('تعاني من الأرق')).toContain('ar:الأرق');
    expect(findConditionTerms('track your sleep')).toEqual([]);
  });
});
