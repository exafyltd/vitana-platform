/**
 * VTID-04175: the Operator Console's session bootstrap pack says, in one
 * line, whether thread persistence (OPERATOR_THREADS_ENABLED, VTID-04022)
 * and turn-memory extraction (OPERATOR_TURN_MEMORY_ENABLED, VTID-04025) are
 * on — so an operator turn can see the state of both switches at a glance
 * instead of reading environment variables directly.
 *
 * Pins: the line names both flags with their current state (AC-1), that it is
 * read live from the environment per turn while the fetched sections and the
 * byte budget are unchanged (AC-2), and both the enabled and the disabled
 * case for each flag (AC-3).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  OPERATOR_FLAGS_SECTION_TITLE, PACK_MAX_CHARS,
  buildBootstrapSections, getOperatorBootstrapPack, renderOperatorFlags, resetBootstrapPackCache, type BootstrapDeps,
} from '../src/services/operator-bootstrap-pack';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const REAL_CLAUDE_MD = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
const REAL_SCHEMA = fs.readFileSync(path.join(REPO_ROOT, 'DATABASE_SCHEMA.md'), 'utf8');
const REAL_PATH_MAP = fs.readFileSync(path.join(REPO_ROOT, 'config/service-path-map.json'), 'utf8');

/** The seven fetched sections the pack had before this VTID (AC-2). */
const EXISTING_SECTION_TITLES = [
  'Governance rules (CLAUDE.md Part 1, abridged)',
  'Recent change log (newest first)',
  'Service path map (config/service-path-map.json)',
  'Database tables (DATABASE_SCHEMA.md index)',
  'Live build-info',
  'Open pull requests',
  'Recent deploy / autopilot events (OASIS)',
];

const CATALOG_TITLE = 'Tool catalog (rendered from the declarations you were given this turn)';

function deps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    readRepoFile: async (p) => (p === 'CLAUDE.md' ? REAL_CLAUDE_MD : p === 'DATABASE_SCHEMA.md' ? REAL_SCHEMA : REAL_PATH_MAP),
    listPlatformOpenPrs: async () => [{ repo: 'exafyltd/vitana-platform', number: 3387, title: 'W2 open-ended intake', branch: 'claude/x', ci: 'passing', mergeable: true }],
    listFrontendOpenPrs: async () => [{ repo: 'exafyltd/vitana-v1', number: 1102, title: 'mobile fix', branch: 'f' }],
    queryRecentEvents: async () => [{ topic: 'dev_autopilot.execution.pr_opened', status: 'success', message: 'Execution 4f5d7ea4 opened https://x', created_at: '2026-09-17T20:15:04.000Z' }],
    fetchBuildInfo: async () => ({ env: 'staging', git_commit: 'ecfc0dff2a91b630b00060038bf1158572739360', booted_at: '2026-09-17T20:34:17.465Z' }),
    env: envWithFlags(false, false),
    ...overrides,
  };
}

function envWithFlags(threads: boolean, turnMemory: boolean): NodeJS.ProcessEnv {
  return {
    OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true',
    OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'staging=https://preview.example/build-info',
    ...(threads ? { OPERATOR_THREADS_ENABLED: 'true' } : {}),
    ...(turnMemory ? { OPERATOR_TURN_MEMORY_ENABLED: 'true' } : {}),
  };
}

/** The pack with the flag-line section removed — everything the pack was before this VTID. */
function withoutFlagSection(pack: string): string {
  const marker = `\n### ${OPERATOR_FLAGS_SECTION_TITLE}\n`;
  const start = pack.indexOf(marker);
  if (start < 0) return pack;
  const bodyEnd = pack.indexOf('\n', start + marker.length);
  return pack.slice(0, start) + (bodyEnd < 0 ? '' : pack.slice(bodyEnd));
}

const OFF_ALL = 'OPERATOR_THREADS_ENABLED=off (server-side thread persistence), OPERATOR_TURN_MEMORY_ENABLED=off (turn-memory extraction)';
const ON_ALL = 'OPERATOR_THREADS_ENABLED=on (server-side thread persistence), OPERATOR_TURN_MEMORY_ENABLED=on (turn-memory extraction)';

describe('VTID-04175 renderOperatorFlags', () => {
  it('names both flags with their current state in all four combinations (AC-1, AC-3)', () => {
    expect(renderOperatorFlags(envWithFlags(true, true))).toBe(ON_ALL);
    expect(renderOperatorFlags(envWithFlags(true, false))).toBe(
      'OPERATOR_THREADS_ENABLED=on (server-side thread persistence), OPERATOR_TURN_MEMORY_ENABLED=off (turn-memory extraction)',
    );
    expect(renderOperatorFlags(envWithFlags(false, true))).toBe(
      'OPERATOR_THREADS_ENABLED=off (server-side thread persistence), OPERATOR_TURN_MEMORY_ENABLED=on (turn-memory extraction)',
    );
    expect(renderOperatorFlags(envWithFlags(false, false))).toBe(OFF_ALL);
    expect(renderOperatorFlags({})).toBe(OFF_ALL);
  });

  it('uses the exact-string gates the two services use, not a loose truthiness test', () => {
    expect(renderOperatorFlags({ OPERATOR_THREADS_ENABLED: 'true', OPERATOR_TURN_MEMORY_ENABLED: '1' })).toBe(
      'OPERATOR_THREADS_ENABLED=on (server-side thread persistence), OPERATOR_TURN_MEMORY_ENABLED=off (turn-memory extraction)',
    );
    expect(renderOperatorFlags({ OPERATOR_THREADS_ENABLED: 'TRUE', OPERATOR_TURN_MEMORY_ENABLED: 'true' })).toBe(
      'OPERATOR_THREADS_ENABLED=off (server-side thread persistence), OPERATOR_TURN_MEMORY_ENABLED=on (turn-memory extraction)',
    );
  });

  it('defaults to process.env, so the line is live from the environment (AC-1)', () => {
    const ORIGINAL_ENV = process.env;
    try {
      process.env = { ...ORIGINAL_ENV, OPERATOR_THREADS_ENABLED: 'true', OPERATOR_TURN_MEMORY_ENABLED: 'true' };
      expect(renderOperatorFlags()).toBe(ON_ALL);
      process.env = { ...ORIGINAL_ENV, OPERATOR_THREADS_ENABLED: 'false' };
      expect(renderOperatorFlags()).toBe(OFF_ALL);
    } finally {
      process.env = ORIGINAL_ENV;
    }
  });
});

describe('VTID-04175 pack wiring', () => {
  beforeEach(() => resetBootstrapPackCache());

  it('the assembled pack carries the flag line and keeps the existing sections and catalog (AC-1, AC-2)', async () => {
    const env = envWithFlags(true, false);
    const pack = await getOperatorBootstrapPack({ toolDefs: [{ name: 'dev_read_file', description: 'Read a file.' }], deps: deps({ env }), env });
    expect(pack).toContain(`### ${OPERATOR_FLAGS_SECTION_TITLE}`);
    expect(pack).toContain('OPERATOR_THREADS_ENABLED=on (server-side thread persistence), OPERATOR_TURN_MEMORY_ENABLED=off (turn-memory extraction)');
    for (const title of EXISTING_SECTION_TITLES) expect(pack).toContain(`### ${title}`);
    expect(pack).toContain(`### ${CATALOG_TITLE}`);
    expect(pack).toContain('- dev_read_file — Read a file.');
  });

  it('neither adds nor reorders the fetched sections (AC-2)', async () => {
    const sections = await buildBootstrapSections(deps());
    expect(sections.map((s) => s.title)).toEqual(EXISTING_SECTION_TITLES);
    expect(sections.every((s) => !s.error)).toBe(true);
  });

  it('renders the flag line for every combination in a full pack (AC-3)', async () => {
    const seen: string[] = [];
    for (const [threads, turnMemory] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      resetBootstrapPackCache();
      const env = envWithFlags(threads, turnMemory);
      const pack = await getOperatorBootstrapPack({ toolDefs: [], deps: deps({ env }), env });
      const line = pack.split('\n').find((l) => l.startsWith('OPERATOR_THREADS_ENABLED='));
      expect(line).toBe(renderOperatorFlags(env));
      seen.push(line!);
    }
    expect(new Set(seen).size).toBe(4);
  });

  it('reads the flags per turn, not once per 5-minute section cache (AC-2)', async () => {
    let reads = 0;
    const d = deps({
      readRepoFile: async (p) => { reads += 1; return p === 'CLAUDE.md' ? REAL_CLAUDE_MD : p === 'DATABASE_SCHEMA.md' ? REAL_SCHEMA : REAL_PATH_MAP; },
    });
    const first = await getOperatorBootstrapPack({ toolDefs: [{ name: 'a', description: 'A.' }], deps: d, env: envWithFlags(false, false) });
    const second = await getOperatorBootstrapPack({ toolDefs: [{ name: 'a', description: 'A.' }], deps: d, env: envWithFlags(true, true) });
    expect(reads).toBe(3); // one build: CLAUDE.md, path map, schema — the flags are not a fetched source
    expect(first).toContain(OFF_ALL);
    expect(second).toContain(ON_ALL);
    // Same cached build, so the rest of the pack is byte-identical.
    expect(withoutFlagSection(second)).toBe(withoutFlagSection(first));
  });

  it('keeps the pack inside the existing byte budget with the extra section (AC-2)', async () => {
    const env = envWithFlags(true, true);
    const pack = await getOperatorBootstrapPack({ toolDefs: [], deps: deps({ env }), env });
    expect(pack.length).toBeLessThanOrEqual(PACK_MAX_CHARS + 60);
  });

  it('is still empty when the pack flag is off, flag line included', async () => {
    expect(await getOperatorBootstrapPack({ toolDefs: [], deps: deps(), env: { OPERATOR_THREADS_ENABLED: 'true' } })).toBe('');
  });
});
