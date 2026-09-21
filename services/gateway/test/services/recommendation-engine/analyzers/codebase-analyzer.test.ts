import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  analyzeCodebase,
  parseTodoScanOutput,
} from '../../../../src/services/recommendation-engine/analyzers/codebase-analyzer';

describe('codebase-analyzer severity mapping', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['TODO', 'medium'],
    ['FIXME', 'high'],
    ['HACK', 'high'],
    ['XXX', 'medium'],
  ])('should assign severity %s for type %s', async (type: string, expectedSeverity: string) => {
    // Create a single file with one comment of the given type.
    // Use a subdirectory scan path (like the production defaults `services/`
    // etc.) — the analyzer strips `basePath/` off grep output, so paths are
    // reported relative to basePath, prefixed by the scan path.
    const fileContent = `// ${type}: test comment`;
    fs.mkdirSync(path.join(tmpDir, 'src'));
    const filePath = path.join(tmpDir, 'src', 'test.ts');
    fs.writeFileSync(filePath, fileContent, 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['src/'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(1);
    const signal = result.signals[0];
    expect(signal.type).toBe('todo');
    // String, never the boolean `true` that a mis-grouped ternary over the
    // `(FIXME || HACK)` condition would produce.
    expect(signal.severity).toBe(expectedSeverity);
    expect(typeof signal.severity).toBe('string');
    expect(signal.file_path).toBe('src/test.ts');
  });

  it('should handle all four types simultaneously', async () => {
    // Create a file with all four types
    const lines = [
      '// TODO: first',
      '// FIXME: second',
      '// HACK: third',
      '// XXX: fourth',
    ];
    const fileContent = lines.join('\n');
    const filePath = path.join(tmpDir, 'all.ts');
    fs.writeFileSync(filePath, fileContent, 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['.'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(4);

    const severityByType: Record<string, string> = {};
    for (const signal of result.signals) {
      // Extract type from message: "XXX: ..." -> "XXX"
      const prefix = signal.message.split(':')[0];
      severityByType[prefix] = signal.severity;
    }

    expect(severityByType['TODO']).toBe('medium');
    expect(severityByType['FIXME']).toBe('high');
    expect(severityByType['HACK']).toBe('high');
    expect(severityByType['XXX']).toBe('medium');
  });

  it('applies the include-extension filter in process, not via GNU-only grep flags', async () => {
    // The gateway runs on node:20-alpine whose BusyBox grep rejects
    // `--include=`/`--exclude-dir=` with exit 2. The old command swallowed
    // that (`2>/dev/null || true`) and so found nothing at all. Files of
    // other types still reach the parser — they must be filtered here.
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'keep.ts'), '// TODO: real\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'skip.md'), '// TODO: ignored\n', 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['src/'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].file_path).toBe('src/keep.ts');
  });

  it('excludes configured directories end to end', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'keep.ts'), '// FIXME: real\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.ts'), '// FIXME: vendored\n', 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['.'],
      exclude_paths: ['node_modules/'],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    const todoSignals = result.signals.filter(s => s.type === 'todo');
    expect(todoSignals).toHaveLength(1);
    // `scan_paths: ['.']` leaves grep's `./` prefix in place (pre-existing
    // behaviour), so match the suffix rather than the exact string.
    expect(todoSignals[0].file_path).toContain('src/keep.ts');
    expect(result.signals.every(s => !s.file_path.includes('node_modules'))).toBe(true);
  });
});

describe('parseTodoScanOutput', () => {
  const filter = {
    include_extensions: ['.ts', '.tsx', '.js', '.jsx', '.sql'],
    exclude_paths: ['node_modules/', 'dist/', '.git/', 'coverage/', 'build/'],
  };

  it('parses grep output, strips the base path and normalizes the type', () => {
    const stdout = [
      '/repo/src/a.ts:12:// TODO: tidy this',
      '/repo/src/b.js:3:/* FIXME: broken */',
      '/repo/src/c.tsx:9:// hack: works',
    ].join('\n');

    expect(parseTodoScanOutput(stdout, '/repo', filter)).toEqual([
      { file: 'src/a.ts', line: 12, type: 'TODO', text: '// TODO: tidy this' },
      { file: 'src/b.js', line: 3, type: 'FIXME', text: '/* FIXME: broken */' },
      { file: 'src/c.tsx', line: 9, type: 'HACK', text: '// hack: works' },
    ]);
  });

  it('drops non-source extensions, excluded directories and unparseable lines', () => {
    const stdout = [
      '/repo/README.md:1:// TODO: docs',
      '/repo/node_modules/dep/index.ts:2:// TODO: vendored',
      '/repo/dist/bundle.js:3:// TODO: built',
      '/repo/src/deep/.git/x.ts:4:// TODO: git internals',
      'not-a-grep-line',
      '',
      '/repo/src/keep.ts:5:// TODO: real',
    ].join('\n');

    expect(parseTodoScanOutput(stdout, '/repo', filter)).toEqual([
      { file: 'src/keep.ts', line: 5, type: 'TODO', text: '// TODO: real' },
    ]);
  });

  it('tolerates a trailing slash on the base path and paths outside it', () => {
    const stdout = [
      '/repo/src/a.ts:1:// TODO: in base',
      '/elsewhere/other.ts:2:// TODO: outside base',
    ].join('\n');

    const parsed = parseTodoScanOutput(stdout, '/repo/', filter);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].file).toBe('src/a.ts');
    expect(parsed[1].file).toBe('/elsewhere/other.ts');
  });
});
