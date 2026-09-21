/**
 * VTID-04185: the bootstrap pack's all-sources-fail case.
 *
 * VTID-04018 (`vtid-04018-operator-bootstrap-pack.test.ts`) pins fail-open for
 * ONE source at a time — OASIS + open PRs broken, one build-info target broken,
 * and a deps set whose `readRepoFile` is missing entirely (which throws
 * synchronously inside `buildBootstrapSections`, so the whole turn fails open
 * to an empty pack rather than assembling a rendered one).
 *
 * Nothing there pins the shape the operator actually sees when EVERY source
 * fails or hangs at the same time: the pack must still assemble, every
 * section must render as "(unavailable: …)" lines only, the whole thing must
 * never throw, and it must stay under the byte budget. That is this file's
 * coverage — no source is allowed to succeed, and the file-backed sources and
 * both PR listers hang rather than reject.
 */

import {
  PACK_MAX_CHARS, SOURCE_TIMEOUT_MS,
  buildBootstrapSections, getOperatorBootstrapPack, resetBootstrapPackCache, type BootstrapDeps, type PackSection,
} from '../src/services/operator-bootstrap-pack';

const EXPECTED_TITLES = [
  'Governance rules (CLAUDE.md Part 1, abridged)',
  'Recent change log (newest first)',
  'Service path map (config/service-path-map.json)',
  'Database tables (DATABASE_SCHEMA.md index)',
  'Live build-info',
  'Open pull requests',
  'Recent deploy / autopilot events (OASIS)',
];

/** A line that is nothing but a failure note, either section-level or per-target. */
const isUnavailableLine = (line: string): boolean =>
  /^\(unavailable: .+\)$/.test(line) || /^- [^:]+: \(unavailable: .+\)$/.test(line);

/** Every source fails or hangs at once — nothing may succeed. */
function allSourcesFailDeps(): BootstrapDeps {
  const hang = () => new Promise<never>(() => undefined);
  return {
    // One hung read for each of CLAUDE.md (rules + change log), the path map and the schema.
    readRepoFile: hang,
    // Both PR listers hang: the enriched one blows its budget, the bare fallback never lands.
    listPlatformOpenPrs: hang,
    listPlatformOpenPrsBare: hang,
    listFrontendOpenPrs: async () => { throw new Error('FRONTEND_DEPLOY_TOKEN not set'); },
    queryRecentEvents: async () => { throw new Error('oasis_events 503'); },
    fetchBuildInfo: async () => { throw new Error('HTTP 503'); },
    env: {
      OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true',
      OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'staging=https://preview.example/build-info,prod=https://prod.example/build-info',
    },
  };
}

/** Each section's rendered failure text, in pack order. */
function renderedSectionText(s: PackSection): string {
  return s.error ? `(unavailable: ${s.error})` : (s.body || '').trim();
}

describe('VTID-04185 bootstrap pack — every source fails or times out at once', () => {
  beforeEach(() => resetBootstrapPackCache());

  it('renders every section as unavailable lines and never throws', async () => {
    const sections = await buildBootstrapSections(allSourcesFailDeps());

    expect(sections.map((s) => s.title)).toEqual(EXPECTED_TITLES);
    for (const s of sections) {
      const lines = renderedSectionText(s).split('\n');
      expect(lines.length).toBeGreaterThan(0);
      // No section leaked real content: it is unavailable notes and nothing else.
      for (const line of lines) expect(isUnavailableLine(line)).toBe(true);
    }
    expect(sections[0].error).toMatch(/timed out after 2500ms/); // hung CLAUDE.md read
    expect(sections[1].error).toMatch(/timed out after 2500ms/); // hung CLAUDE.md read (change log)
    expect(sections[2].error).toMatch(/timed out after 2500ms/); // hung path map read
    expect(sections[3].error).toMatch(/timed out after 2500ms/); // hung schema read
    expect(sections[4].error).toBeUndefined();                   // build-info fails per target, not per section
    expect(sections[4].body).toBe('- staging: (unavailable: HTTP 503)\n- prod: (unavailable: HTTP 503)');
    expect(sections[5].error).toMatch(/exceeded|timed out/);     // every PR lister failed or hung
    expect(sections[6].error).toBe('oasis_events 503');
  }, 15_000);

  it('assembles a string, one unavailable line per failure, under the byte cap', async () => {
    const deps = allSourcesFailDeps();
    const t0 = Date.now();
    const pack = await getOperatorBootstrapPack({
      toolDefs: [{ name: 'dev_read_file', description: 'Read a file from the repo.' }],
      deps,
      env: deps.env,
    });
    const elapsed = Date.now() - t0;

    expect(typeof pack).toBe('string');
    expect(pack.length).toBeGreaterThan(0);
    expect(pack.length).toBeLessThanOrEqual(PACK_MAX_CHARS);
    expect(pack).not.toContain('…[pack truncated at the size budget]');

    expect(pack).toContain('Session bootstrap pack (VTID-04018) — assembled ');
    for (const title of EXPECTED_TITLES) expect(pack).toContain(`### ${title}\n`);

    // AC-1: apart from the heading, the per-turn tool catalog (rendered from
    // the declarations, never a fetched source) and the intro line, every
    // rendered line is an "(unavailable: …)" note.
    const CATALOG_TITLE = '### Tool catalog (rendered from the declarations you were given this turn)';
    const contentLines = pack.split('\n').filter((line) =>
      line !== '' && !line.startsWith('### ') && !line.startsWith('**Session bootstrap pack') && !line.startsWith('- dev_read_file —'));
    expect(contentLines).toHaveLength(8); // 4 section errors + 2 build-info targets + PRs + OASIS
    for (const line of contentLines) expect(isUnavailableLine(line)).toBe(true);

    expect(pack).toContain(`${CATALOG_TITLE}\n- dev_read_file — Read a file from the repo.`);
    expect(pack).toContain('### Live build-info\n- staging: (unavailable: HTTP 503)');
    expect(pack).toContain('### Recent deploy / autopilot events (OASIS)\n(unavailable: oasis_events 503)');

    // The fail-open path is per source, not per pack: the sources run in
    // parallel, so the worst case is one SOURCE_TIMEOUT_MS round, not seven.
    expect(elapsed).toBeLessThan(SOURCE_TIMEOUT_MS + 1_000);
  }, 15_000);
});
